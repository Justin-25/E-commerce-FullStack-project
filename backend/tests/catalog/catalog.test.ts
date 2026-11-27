import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CATEGORIES, PRODUCTS } from "../../prisma/demo-data.js";
import { CATEGORY_CACHE_KEY } from "../../src/modules/catalog/catalog.service.js";
import { TOP_RATED_PRIOR } from "../../src/modules/catalog/search.js";
import { createCatalogHarness, type CatalogHarness } from "../support/catalogHarness.js";

let h: CatalogHarness;
beforeAll(async () => {
  h = await createCatalogHarness();
}, 120_000);
afterAll(() => h?.close());

type Card = { slug: string; title: string; priceCentavos: number; compareAtCentavos: number | null; ratingAvg: number; ratingCount: number; soldCount: number; store: { slug: string }; freeDelivery: boolean; badges: Record<string, boolean> };
const search = (qs = "") => request(h.app).get(`/api/v1/products${qs ? `?${qs}` : ""}`);
const slugs = (res: { body: { items: Card[] } }) => res.body.items.map((i) => i.slug);
const visible = PRODUCTS.filter((p) => (p.status ?? "ACTIVE") === "ACTIVE");

describe("GET /categories", () => {
  it("returns the category tree with product counts that include sub-categories (drafts not counted)", async () => {
    const res = await request(h.app).get("/api/v1/categories");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=300");
    const roots = res.body.categories as { slug: string; productCount: number; children: { slug: string; productCount: number }[] }[];
    expect(roots.map((c) => c.slug)).toEqual(CATEGORIES.filter(([, , parent]) => !parent).map(([slug]) => slug));

    const expected = (slug: string) => {
      const kids = CATEGORIES.filter(([, , parent]) => parent === slug).map(([s]) => s);
      return visible.filter((p) => p.category === slug || kids.includes(p.category)).length;
    };
    for (const root of roots) {
      expect(root.productCount).toBe(expected(root.slug));
      for (const child of root.children) expect(child.productCount).toBe(expected(child.slug));
    }
    expect(roots.find((c) => c.slug === "electronics")?.children.find((c) => c.slug === "speakers")?.productCount).toBe(6); // 7 minus the draft
  });

  it("is cached in Redis, and still works when Redis is down", async () => {
    await request(h.app).get("/api/v1/categories");
    expect(await h.kv.get(CATEGORY_CACHE_KEY)).not.toBeNull();
    h.redis.down = true;
    try {
      expect((await request(h.app).get("/api/v1/categories")).status).toBe(200);
      expect((await search("q=serum")).status).toBe(200);
      expect(h.logs.some((l) => l.msg.includes("cache unavailable"))).toBe(true);
    } finally {
      h.redis.down = false;
    }
  });
});

describe("GET /products (search)", () => {
  it("lists every visible product, best sellers first, 24 per page, never the draft", async () => {
    const res = await search();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ query: null, page: 1, pageSize: 24, totalItems: 62, totalPages: 3, sellerCount: 7 });
    expect(res.body.items).toHaveLength(24);
    const sold = res.body.items.map((i: Card) => i.soldCount);
    expect(sold).toEqual([...sold].sort((a, b) => b - a));
    const all = [...slugs(res), ...slugs(await search("page=2")), ...slugs(await search("page=3"))];
    expect(all).toHaveLength(62);
    expect(new Set(all).size).toBe(62); // no product on two pages
    expect(all).not.toContain("boom-max-pro");
  });

  it("finds products by words, ignores word endings, and ranks title matches first", async () => {
    const res = await search("q=headphone");
    expect(res.body.matchMode).toBe("words");
    expect(res.body.totalItems).toBeGreaterThanOrEqual(6);
    for (const item of res.body.items as Card[]) expect(item.title.toLowerCase()).toMatch(/headphone/);
    const noise = await search(`q=${encodeURIComponent("noise cancelling")}`);
    expect(slugs(noise)).toEqual(expect.arrayContaining(["aurasound-pro", "quietwave-travel"]));
  });

  it("forgives typos", async () => {
    const res = await search("q=hedphones");
    expect(res.body.matchMode).toBe("similar"); // no exact word match, so similar spellings are shown
    expect(res.body.totalItems).toBeGreaterThan(0);
    const titles = (res.body.items as Card[]).map((i) => i.title);
    expect(titles.slice(0, 6).every((t) => /headphones/i.test(t))).toBe(true); // the closest spellings first…
    expect(titles.every((t) => /headphones|earphones/i.test(t))).toBe(true); // …and nothing unrelated
    expect(slugs(await search("q=sunglases"))).toContain("riviera-tortoise");
    expect(slugs(await search("q=speker"))).toEqual(expect.arrayContaining(["boom-mini", "pocket-pal"]));
    expect(slugs(await search("q=botle"))).toEqual(expect.arrayContaining(["hydra-steel-750"]));
  });

  it("supports search-engine syntax: \"exact phrases\" and -excluded words", async () => {
    const serums = slugs(await search("q=serum"));
    expect(serums).toEqual(expect.arrayContaining(["vitamin-c-serum-30", "gentle-retinol-night"]));
    const withoutRetinol = slugs(await search(`q=${encodeURIComponent("serum -retinol")}`));
    expect(withoutRetinol).toContain("vitamin-c-serum-30");
    expect(withoutRetinol).not.toContain("gentle-retinol-night");
    expect(slugs(await search(`q=${encodeURIComponent('"vitamin c"')}`))).toEqual(["vitamin-c-serum-30"]);
  });

  it("filters by category (including sub-categories, several at once), with counts for the other categories", async () => {
    const electronics = await search("category=electronics&pageSize=48");
    expect(electronics.body.totalItems).toBe(20);
    const both = await search("category=headphones&category=speakers&pageSize=48");
    expect(both.body.totalItems).toBe(14);
    expect(new Set((both.body.items as Card[]).map((i) => i.slug))).toEqual(
      new Set(visible.filter((p) => ["headphones", "speakers"].includes(p.category)).map((p) => p.slug))
    );
    // The category list still shows the other categories with their counts (so you can switch).
    const facet = both.body.facets.categories as { slug: string; count: number }[];
    expect(facet.find((c) => c.slug === "beauty")?.count).toBe(10);
    expect((await search("category=does-not-exist")).body.totalItems).toBe(0);
  });

  it("filters by seller, with counts for the other sellers", async () => {
    const res = await search("store=glow-lab&pageSize=48");
    expect((res.body.items as Card[]).every((i) => i.store.slug === "glow-lab")).toBe(true);
    expect(res.body.totalItems).toBe(visible.filter((p) => p.store === "glow-lab").length);
    expect(res.body.facets.stores.total).toBe(7);
    expect(res.body.facets.stores.items.find((s: { slug: string }) => s.slug === "peak-outdoors").count).toBe(visible.filter((p) => p.store === "peak-outdoors").length);
  });

  it("filters by price (in centavos), customer rating and free delivery", async () => {
    const priced = await search("minPrice=100000&maxPrice=300000&pageSize=48");
    expect(priced.body.totalItems).toBeGreaterThan(0);
    for (const i of priced.body.items as Card[]) {
      expect(i.priceCentavos).toBeGreaterThanOrEqual(100_000);
      expect(i.priceCentavos).toBeLessThanOrEqual(300_000);
    }
    // The price range ignores the price filter itself: it spans every visible product.
    expect(priced.body.facets.price.minCentavos).toBe(Math.min(...visible.flatMap((p) => p.variants.map((v) => v[2]))));

    const best = await search("rating=4&sort=top_rated&pageSize=48");
    const cards = best.body.items as Card[];
    expect(cards.every((i) => i.ratingAvg >= 4)).toBe(true);
    // Weighted rating: a few perfect reviews don't beat a long track record.
    const weighted = (c: Card) => (c.ratingAvg * c.ratingCount + TOP_RATED_PRIOR.stars * TOP_RATED_PRIOR.reviews) / (c.ratingCount + TOP_RATED_PRIOR.reviews);
    for (let i = 1; i < cards.length; i++) expect(weighted(cards[i - 1] as Card)).toBeGreaterThanOrEqual(weighted(cards[i] as Card) - 1e-9);
    // Checked without the code's constant: a perfect 5.0 from a handful of reviews ranks
    // below a 4.7–4.99 with a long track record (the plain average would put it on top).
    const fewPerfect = cards.filter((c) => c.ratingAvg === 5 && c.ratingCount <= 5);
    const proven = cards.findIndex((c) => c.ratingAvg >= 4.7 && c.ratingAvg < 5 && c.ratingCount >= 15);
    expect(fewPerfect.length).toBeGreaterThan(0);
    expect(proven).toBeGreaterThanOrEqual(0);
    for (const c of fewPerfect) expect(cards.indexOf(c), c.slug).toBeGreaterThan(proven);

    const free = await search("freeDelivery=true&pageSize=48");
    expect((free.body.items as Card[]).every((i) => i.freeDelivery && i.priceCentavos >= 99_900)).toBe(true);
    expect(free.body.totalItems).toBeLessThan(62);
  });

  it("sorts by price, newest and best selling", async () => {
    const asc = (await search("sort=price_asc&pageSize=48")).body.items.map((i: Card) => i.priceCentavos);
    expect(asc).toEqual([...asc].sort((a: number, b: number) => a - b));
    const desc = (await search("sort=price_desc&pageSize=48")).body.items.map((i: Card) => i.priceCentavos);
    expect(desc).toEqual([...desc].sort((a: number, b: number) => b - a));
    expect(slugs(await search("sort=newest"))[0]).toBe("aurasound-pro-2"); // published 5 days ago
    expect(slugs(await search("sort=best_selling"))[0]).toBe("pulse-fit-lite");
  });

  it("refuses unknown sorts, deep pages, odd page sizes, bad slugs and impossible price ranges", async () => {
    for (const qs of ["sort=cheapest", "page=51", "pageSize=30", "category=DROP%20TABLE", "minPrice=500&maxPrice=100", `q=${"x".repeat(101)}`]) {
      const res = await search(qs);
      expect(res.status, qs).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("treats typed text as text, never as SQL or search operators", async () => {
    for (const q of ["'; DROP TABLE products; --", "a & | ! ( ) :* <->", "%_\\", "🙂"]) {
      const res = await search(`q=${encodeURIComponent(q)}`);
      expect(res.status, q).toBe(200);
    }
    expect(await h.db.prisma.product.count()).toBe(63);
  });
});

describe("deals with a countdown", () => {
  it("shows the deal price until the end time, then the regular price with nothing crossed out", async () => {
    const live = (await search("q=boom%20max")).body.items.find((i: Card) => i.slug === "boom-max");
    expect(live).toMatchObject({ priceCentavos: 699_900, compareAtCentavos: 849_900, savingsPercent: 18, badges: { deal: true } });
    expect(new Date(live.saleEndsAt).getTime()).toBeGreaterThan(Date.now());

    await h.db.prisma.productVariant.updateMany({ where: { sku: "SC-BOOM-MAX-BLK" }, data: { saleEndsAt: new Date(Date.now() - 60_000) } });
    const ended = (await search("q=boom%20max")).body.items.find((i: Card) => i.slug === "boom-max");
    expect(ended).toMatchObject({ priceCentavos: 849_900, compareAtCentavos: null, savingsPercent: 0, saleEndsAt: null, badges: { deal: false } });
    const page = (await request(h.app).get(`/api/v1/products/${await h.idOf("boom-max")}`)).body.product;
    expect(page.variants[0]).toMatchObject({ priceCentavos: 849_900, compareAtCentavos: null, savingsCentavos: 0 });
    expect(page.price.dealEndsAt).toBeNull();
  });
});

describe("GET /products/:id (product page)", () => {
  it("has everything the page shows: variants with deal prices and stock, specs, seller, delivery", async () => {
    const res = await request(h.app).get(`/api/v1/products/${await h.idOf("aurasound-pro")}`);
    expect(res.status).toBe(200);
    const p = res.body.product;
    expect(p).toMatchObject({
      slug: "aurasound-pro",
      breadcrumbs: [{ slug: "electronics", name: "Electronics" }, { slug: "headphones", name: "Headphones" }],
      store: { slug: "soundcraft-audio", name: "SoundCraft Audio", verified: true, shipsFrom: "Manila" },
      price: { fromCentavos: 749_900, compareAtCentavos: 999_900, savingsPercent: 25 },
      delivery: { qualifiesForFreeDelivery: true, freeThresholdCentavos: 99_900 },
      returns: { days: 30 }
    });
    // Ratings are computed from the demo reviews, so compare with the database, not typed-in numbers.
    const [own, store] = await Promise.all([
      h.db.prisma.product.findFirstOrThrow({ where: { slug: "aurasound-pro" }, select: { ratingAvg: true, ratingCount: true } }),
      h.db.prisma.store.findUniqueOrThrow({ where: { slug: "soundcraft-audio" }, select: { ratingAvg: true, ratingCount: true } })
    ]);
    expect(own.ratingCount).toBeGreaterThan(0);
    expect(p.rating).toEqual({ avg: Number(own.ratingAvg), count: own.ratingCount });
    expect(p.store).toMatchObject({ ratingAvg: Number(store.ratingAvg), ratingCount: store.ratingCount });
    expect(p.store.positivePercent).toEqual(expect.any(Number));
    expect(p.specs).toContainEqual({ label: "Battery life", value: "30 hours (ANC on)" });
    expect(p.variants.map((v: { name: string; stock: { status: string } }) => [v.name, v.stock.status])).toEqual([
      ["Midnight Black", "in_stock"],
      ["Sand", "in_stock"],
      ["Silver", "out_of_stock"]
    ]);
    expect(p.price.dealEndsAt).not.toBeNull();
    // Exact stock numbers aren't published: 42 in stock just says "in stock"; only low stock shows a number.
    for (const v of p.variants as { stock: { status: string; left?: number } }[]) {
      expect(v.stock.status === "low_stock" ? Object.keys(v.stock).sort() : Object.keys(v.stock)).toEqual(v.stock.status === "low_stock" ? ["left", "status"] : ["status"]);
    }
  });

  it("says 'Only N left' for low stock", async () => {
    const p = (await request(h.app).get(`/api/v1/products/${await h.idOf("riviera-tortoise")}`)).body.product;
    expect(p.variants[0].stock).toEqual({ status: "low_stock", left: 3 });
  });

  it("is 404 for drafts, unknown ids and suspended stores, and 400 for malformed ids", async () => {
    expect((await request(h.app).get(`/api/v1/products/${await h.idOf("boom-max-pro")}`)).status).toBe(404);
    expect((await request(h.app).get("/api/v1/products/00000000-0000-7000-8000-000000000000")).status).toBe(404);
    expect((await request(h.app).get("/api/v1/products/not-an-id")).status).toBe(400);

    const lampId = await h.idOf("capiz-table-lamp");
    await h.db.prisma.store.update({ where: { slug: "hearth-home" }, data: { status: "SUSPENDED", suspendedAt: new Date(), suspendedCause: "ADMIN" } });
    try {
      expect((await request(h.app).get(`/api/v1/products/${lampId}`)).status).toBe(404);
      expect(slugs(await search("q=lamp"))).not.toContain("capiz-table-lamp");
    } finally {
      await h.db.prisma.store.update({ where: { slug: "hearth-home" }, data: { status: "APPROVED" } });
    }
  });

  it("hides products with nothing on sale (every variant switched off)", async () => {
    await h.db.prisma.productVariant.updateMany({ where: { sku: "SC-M50-BLK" }, data: { isActive: false } });
    try {
      expect((await request(h.app).get(`/api/v1/products/${await h.idOf("studio-monitor-m50")}`)).status).toBe(404);
      expect(slugs(await search("q=studio%20monitor"))).not.toContain("studio-monitor-m50");
    } finally {
      await h.db.prisma.productVariant.updateMany({ where: { sku: "SC-M50-BLK" }, data: { isActive: true } });
    }
  });

  it("suggests related products from the same category, without the product itself", async () => {
    const id = await h.idOf("vitamin-c-serum-30");
    const res = await request(h.app).get(`/api/v1/products/${id}/related`);
    expect(res.status).toBe(200);
    const related = res.body.products as Card[];
    expect(related.length).toBeGreaterThan(0);
    expect(related.length).toBeLessThanOrEqual(8);
    expect(related.map((r) => r.slug)).not.toContain("vitamin-c-serum-30");
    const skincare = new Set(visible.filter((p) => p.category === "skincare").map((p) => p.slug));
    expect(related.every((r) => skincare.has(r.slug))).toBe(true);
  });
});
