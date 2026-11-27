import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CATEGORY_CACHE_KEY } from "../../src/modules/catalog/catalog.service.js";
import { HOME_CACHE_KEY } from "../../src/modules/home/home.service.js";
import { TOP_RATED_PRIOR } from "../../src/modules/catalog/search.js";
import { CATEGORIES, PRODUCTS } from "../../prisma/demo-data.js";
import { recomputeRatings } from "../../src/modules/reviews/ratings.js";
import { createCatalogHarness, type CatalogHarness } from "../support/catalogHarness.js";

let h: CatalogHarness;
beforeAll(async () => {
  h = await createCatalogHarness();
}, 120_000);
afterAll(() => h?.close());

type Card = { id: string; slug: string; store: { slug: string }; saleEndsAt: string | null; compareAtCentavos: number | null; soldCount: number; stockLeft: number | null; inStock: boolean };
type Store = { slug: string; mainCategory: { slug: string; name: string } | null; rating: { avg: number; count: number }; positivePercent: number | null; followerCount: number };
type Home = { categories: { slug: string; name: string; productCount: number }[]; todaysDeals: { endsAt: string | null; items: Card[] }; bestSellers: Card[]; topStores: Store[] };

/** Home is cached for a minute (and its category counts for 5): tests that change data start fresh. */
const freshHome = async () => {
  await h.kv.delete(HOME_CACHE_KEY, CATEGORY_CACHE_KEY);
  const res = await request(h.app).get("/api/v1/home");
  expect(res.status).toBe(200);
  return res.body as Home;
};
const weighted = (r: { avg: number; count: number }) => (r.avg * r.count + TOP_RATED_PRIOR.stars * TOP_RATED_PRIOR.reviews) / (r.count + TOP_RATED_PRIOR.reviews);

describe("GET /home", () => {
  it("has the four sections, built from the same rules as the rest of the catalog", async () => {
    const res = await request(h.app).get("/api/v1/home");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
    const home = res.body as Home;
    expect(Object.keys(home).sort()).toEqual(["bestSellers", "categories", "todaysDeals", "topStores"]);

    // Shop by category = the top level of the category list.
    const roots = (await request(h.app).get("/api/v1/categories")).body.categories as { slug: string; name: string; productCount: number }[];
    expect(home.categories).toEqual(roots.map(({ slug, name, productCount }) => ({ slug, name, productCount })));

    // Today's deals: running countdowns only, ending soonest first; "Ends in" is the soonest.
    const countdowns = await h.db.prisma.product.count({ where: { status: "ACTIVE", variants: { some: { isActive: true, saleEndsAt: { gt: new Date() } } } } });
    expect(home.todaysDeals.items.length).toBe(Math.min(8, countdowns));
    const ends = home.todaysDeals.items.map((c) => c.saleEndsAt);
    expect(ends.every((e) => e !== null)).toBe(true);
    expect(ends).toEqual([...ends].sort());
    expect(home.todaysDeals.endsAt).toBe(ends[0]);
    expect(home.todaysDeals.items.every((c) => c.compareAtCentavos !== null)).toBe(true);

    // Best sellers = the first 8 of the search's best-selling sort.
    const best = (await request(h.app).get("/api/v1/products?sort=best_selling&pageSize=12")).body.items as Card[];
    expect(home.bestSellers.map((c) => c.slug)).toEqual(best.slice(0, 8).map((c) => c.slug));
  });

  it("ranks top-rated stores by weighted rating, with the same numbers as their store pages", async () => {
    const { topStores } = await freshHome();
    expect(topStores.length).toBeGreaterThan(0);
    expect(topStores.length).toBeLessThanOrEqual(6);
    for (let i = 1; i < topStores.length; i++) expect(weighted((topStores[i - 1] as Store).rating)).toBeGreaterThanOrEqual(weighted((topStores[i] as Store).rating) - 1e-9);
    for (const s of topStores) {
      const page = (await request(h.app).get(`/api/v1/stores/${s.slug}`)).body.store;
      expect({ rating: s.rating, positivePercent: s.positivePercent, followerCount: s.followerCount }).toEqual({ rating: page.rating, positivePercent: page.positivePercent, followerCount: page.followerCount });
    }
    // "Main category": the top-level category with most of the store's products (ties: by name).
    const rootOf = (slug: string): string => CATEGORIES.find(([s]) => s === slug)?.[2] ?? slug;
    const nameOf = (slug: string) => CATEGORIES.find(([s]) => s === slug)?.[1] ?? "";
    for (const s of topStores) {
      const counts = new Map<string, number>();
      for (const p of PRODUCTS.filter((p) => p.store === s.slug && (p.status ?? "ACTIVE") === "ACTIVE")) counts.set(rootOf(p.category), (counts.get(rootOf(p.category)) ?? 0) + 1);
      const [main] = [...counts.entries()].sort((a, b) => b[1] - a[1] || nameOf(a[0]).localeCompare(nameOf(b[0])));
      expect(s.mainCategory, s.slug).toEqual({ slug: main?.[0], name: nameOf(main?.[0] ?? "") });
    }
    expect(new Set(topStores.map((s) => s.mainCategory?.slug)).size).toBeGreaterThan(2); // stores with mixed categories too
  });

  it("doesn't let a store with one 5★ review top the list", async () => {
    await h.db.prisma.store.update({ where: { slug: "nova-wearables" }, data: { ratingAvg: 5, ratingCount: 1 } });
    try {
      const { topStores } = await freshHome();
      expect(topStores[0]?.slug).not.toBe("nova-wearables");
      const nova = topStores.findIndex((s) => s.slug === "nova-wearables");
      if (nova >= 0) expect(nova).toBeGreaterThan(2);
    } finally {
      await recomputeRatings(h.db.prisma, "all");
      await h.kv.delete(HOME_CACHE_KEY);
    }
  });

  it("shows only running countdowns, even when there are fewer than 8", async () => {
    const keep = (await freshHome()).todaysDeals.items.slice(0, 3).map((c) => c.id);
    const others = await h.db.prisma.productVariant.findMany({ where: { saleEndsAt: { not: null }, productId: { notIn: keep } }, select: { id: true, saleEndsAt: true } });
    await h.db.prisma.productVariant.updateMany({ where: { id: { in: others.map((v) => v.id) } }, data: { saleEndsAt: new Date(Date.now() - 60_000) } });
    try {
      const home = await freshHome();
      expect(home.todaysDeals.items.map((c) => c.id)).toEqual(keep);
    } finally {
      for (const v of others) await h.db.prisma.productVariant.update({ where: { id: v.id }, data: { saleEndsAt: v.saleEndsAt } });
      await h.kv.delete(HOME_CACHE_KEY);
    }
  });

  it("drops a deal from Today's deals once its countdown ends", async () => {
    const before = await freshHome();
    const soonest = before.todaysDeals.items[0] as Card;
    const original = await h.db.prisma.productVariant.findMany({ where: { productId: soonest.id }, select: { id: true, saleEndsAt: true } });
    await h.db.prisma.productVariant.updateMany({ where: { productId: soonest.id }, data: { saleEndsAt: new Date(Date.now() - 60_000) } });
    try {
      const after = await freshHome();
      expect(after.todaysDeals.items.map((c) => c.id)).not.toContain(soonest.id);
      expect(after.todaysDeals.endsAt).not.toBe(soonest.saleEndsAt);
    } finally {
      for (const v of original) await h.db.prisma.productVariant.update({ where: { id: v.id }, data: { saleEndsAt: v.saleEndsAt } });
    }
  });

  it("leaves out suspended stores and their products everywhere", async () => {
    await h.db.prisma.store.update({ where: { slug: "soundcraft-audio" }, data: { status: "SUSPENDED", suspendedAt: new Date(), suspendedCause: "ADMIN" } });
    try {
      const home = await freshHome();
      const cards = [...home.todaysDeals.items, ...home.bestSellers];
      expect(cards.some((c) => c.store.slug === "soundcraft-audio")).toBe(false);
      expect(home.topStores.some((s) => s.slug === "soundcraft-audio")).toBe(false);
      const electronics = home.categories.find((c) => c.slug === "electronics");
      const visible = await h.db.prisma.product.count({ where: { status: "ACTIVE", store: { status: "APPROVED" }, category: { OR: [{ slug: "electronics" }, { parent: { slug: "electronics" } }] } } });
      expect(electronics?.productCount).toBe(visible);
    } finally {
      await h.db.prisma.store.update({ where: { slug: "soundcraft-audio" }, data: { status: "APPROVED" } });
      await h.kv.delete(CATEGORY_CACHE_KEY, HOME_CACHE_KEY);
    }
  });

  it("is served from the Redis cache for a minute, and still works when Redis is down", async () => {
    const first = await freshHome();
    expect(await h.kv.get(HOME_CACHE_KEY)).not.toBeNull();
    // A change inside the minute isn't visible yet: the cached copy is served.
    await h.db.prisma.store.update({ where: { slug: "glow-lab" }, data: { followerCount: 1 } });
    try {
      const cached = (await request(h.app).get("/api/v1/home")).body as Home;
      expect(cached).toEqual(first);

      h.redis.down = true;
      const down = await request(h.app).get("/api/v1/home");
      expect(down.status).toBe(200);
      expect(h.logs.some((l) => /cache unavailable/.test(l.msg))).toBe(true);
    } finally {
      h.redis.down = false;
      await h.db.prisma.store.update({ where: { slug: "glow-lab" }, data: { followerCount: 21_000 } });
      await h.kv.delete(HOME_CACHE_KEY);
    }
  });
});

describe("GET /products/cards (Recently viewed)", () => {
  it("returns the cards in the order asked, leaving out hidden, unknown and repeated products", async () => {
    const [a, b, draft] = [await h.idOf("aurasound-pro"), await h.idOf("boom-mini"), await h.idOf("boom-max-pro")];
    const unknown = "0193c0de-0000-7000-8000-000000000000";
    const res = await request(h.app).get(`/api/v1/products/cards?ids=${[b, a, draft, unknown, a].join(",")}`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
    expect((res.body.products as Card[]).map((c) => c.slug)).toEqual(["boom-mini", "aurasound-pro"]);
  });

  it("validates the list: 1 to 20 product ids", async () => {
    const ids = await h.db.prisma.product.findMany({ take: 21, select: { id: true } });
    for (const qs of ["", "ids=", "ids=not-a-uuid", `ids=${ids.map((p) => p.id).join(",")}`]) {
      const res = await request(h.app).get(`/api/v1/products/cards${qs ? `?${qs}` : ""}`);
      expect(res.status, qs.slice(0, 20)).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect((await request(h.app).get(`/api/v1/products/cards?ids=${ids.slice(0, 20).map((p) => p.id).join(",")}`)).status).toBe(200);
  });
});

describe("product cards", () => {
  it("say 'Only N left' when 1–5 units remain, and never show bigger stock numbers", async () => {
    const res = await request(h.app).get(`/api/v1/products/cards?ids=${[await h.idOf("riviera-tortoise"), await h.idOf("aurasound-pro"), await h.idOf("quietwave-travel")].join(",")}`);
    const bySlug = Object.fromEntries((res.body.products as Card[]).map((c) => [c.slug, c]));
    expect(bySlug["riviera-tortoise"]).toMatchObject({ stockLeft: 3, inStock: true });
    expect(bySlug["aurasound-pro"]).toMatchObject({ stockLeft: null, inStock: true }); // 51 left: not shown
    expect(bySlug["quietwave-travel"]).toMatchObject({ stockLeft: null, inStock: false }); // sold out
  });
});
