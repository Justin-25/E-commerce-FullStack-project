import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRODUCTS } from "../../prisma/demo-data.js";
import { createCatalogHarness, type CatalogHarness } from "../support/catalogHarness.js";

let h: CatalogHarness;
beforeAll(async () => {
  h = await createCatalogHarness();
}, 120_000);
afterAll(() => h?.close());

const DAY = 24 * 60 * 60 * 1000;
const storePage = (slug: string) => request(h.app).get(`/api/v1/stores/${slug}`);
const search = (qs: string) => request(h.app).get(`/api/v1/products?${qs}`);
const follow = (slug: string) => `/api/v1/stores/${slug}/follow`;
const visible = PRODUCTS.filter((p) => (p.status ?? "ACTIVE") === "ACTIVE");
/** Demo products whose cheapest variant has a crossed-out price (the cards' "Deal" badge). */
const isDeal = (p: (typeof PRODUCTS)[number]) => {
  const cheapest = [...p.variants].sort((a, b) => a[2] - b[2])[0];
  return cheapest?.[3] !== null && cheapest?.[3] !== undefined;
};
let emails = 0;
const shopper = () => h.signUp({ email: `follower${++emails}@example.com` });

describe("GET /stores/:slug (store page)", () => {
  it("shows the header, About and category chips, computed from real data", async () => {
    const res = await storePage("soundcraft-audio");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
    const s = res.body.store;
    // Exactly these fields: owner, legal name, tax number and warnings stay private.
    expect(Object.keys(s).sort()).toEqual(
      ["bannerUrl", "categories", "dealCount", "description", "followerCount", "id", "logoUrl", "name", "positivePercent", "productCount", "rating", "returns", "sellingSince", "shipsFrom", "shipsWithinHours", "slug", "verified"].sort()
    );

    const row = await h.db.prisma.store.findUniqueOrThrow({ where: { slug: "soundcraft-audio" } });
    expect(s).toMatchObject({
      name: "SoundCraft Audio",
      verified: true,
      shipsFrom: "Manila",
      followerCount: 12_400,
      sellingSince: row.approvedAt?.getFullYear(),
      rating: { avg: Number(row.ratingAvg), count: row.ratingCount },
      returns: { days: 30 }
    });

    const mine = visible.filter((p) => p.store === "soundcraft-audio");
    expect(s.productCount).toBe(mine.length); // the draft speaker isn't counted
    expect(s.dealCount).toBe(mine.filter(isDeal).length);
    expect((await search("store=soundcraft-audio&deal=true")).body.totalItems).toBe(s.dealCount);

    const chips = s.categories as { slug: string; name: string; count: number }[];
    expect(chips.reduce((sum, c) => sum + c.count, 0)).toBe(s.productCount);
    expect(chips.map((c) => c.count)).toEqual([...chips.map((c) => c.count)].sort((a, b) => b - a));
    expect(chips.find((c) => c.slug === "speakers")?.count).toBe(mine.filter((p) => p.category === "speakers").length);
  });

  it("works out '98% positive' from the last 12 months of reviews, and the product page agrees", async () => {
    const reviews = await h.db.prisma.review.findMany({
      where: { status: "PUBLISHED", createdAt: { gte: new Date(Date.now() - 365 * DAY) }, product: { store: { slug: "soundcraft-audio" }, status: { not: "REMOVED" } } },
      select: { rating: true }
    });
    expect(reviews.length).toBeGreaterThan(0);
    const expected = Math.floor((reviews.filter((r) => r.rating >= 4).length * 100) / reviews.length);
    expect((await storePage("soundcraft-audio")).body.store.positivePercent).toBe(expected);
    const product = (await request(h.app).get(`/api/v1/products/${await h.idOf("aurasound-pro")}`)).body.product;
    expect(product.store.positivePercent).toBe(expected);
  });

  it("says how fast it ships: 90% of the last 90 days' orders shipped within this many hours", async () => {
    const rows = await h.db.prisma.sellerOrder.findMany({
      where: { store: { slug: "soundcraft-audio" }, shippedAt: { gte: new Date(Date.now() - 90 * DAY) } },
      select: { shippedAt: true, order: { select: { placedAt: true } } }
    });
    const hours = rows.map((r) => ((r.shippedAt?.getTime() ?? 0) - (r.order.placedAt?.getTime() ?? 0)) / 3_600_000).sort((a, b) => a - b);
    expect(hours.length).toBeGreaterThanOrEqual(5);
    // PostgreSQL's percentile_cont: linear interpolation between the two nearest values.
    const pos = 0.9 * (hours.length - 1);
    const lo = hours[Math.floor(pos)] as number;
    const hi = hours[Math.ceil(pos)] as number;
    const p90 = lo + (hi - lo) * (pos - Math.floor(pos));
    const s = (await storePage("soundcraft-audio")).body.store;
    expect(s.shipsWithinHours).toBe(Math.ceil(p90));
    expect(s.shipsWithinHours).toBeLessThanOrEqual(24); // the design's "Ships within 24 hours"
  });

  it("answers 404 for unknown and not-approved stores, 400 for a malformed name", async () => {
    expect((await storePage("no-such-store")).status).toBe(404);
    expect((await storePage("Robert'); DROP TABLE stores;--")).status).toBe(400);
    for (const status of ["PENDING", "SUSPENDED", "REJECTED"] as const) {
      await h.db.prisma.store.update({ where: { slug: "sol-co" }, data: { status, reviewNote: status === "REJECTED" ? "Documents didn't match." : null, ...(status === "SUSPENDED" ? { suspendedAt: new Date(), suspendedCause: "ADMIN" as const } : {}) } });
      expect((await storePage("sol-co")).status, status).toBe(404);
    }
    await h.db.prisma.store.update({ where: { slug: "sol-co" }, data: { status: "APPROVED", reviewNote: null } });
    expect((await storePage("sol-co")).status).toBe(200);
  });

  it("is the same for everyone (cacheable): being signed in doesn't change it", async () => {
    const { browser } = await shopper();
    await browser.put(follow("hearth-home"));
    const anonymous = await storePage("hearth-home");
    const signedIn = await browser.get("/api/v1/stores/hearth-home");
    expect(signedIn.body).toEqual(anonymous.body);
  });
});

describe("GET /products?deal=true (the 'Deals' chip)", () => {
  it("lists only products on a deal, and drops a deal once its countdown ends", async () => {
    const res = await search("deal=true&pageSize=48");
    expect(res.body.totalItems).toBe(visible.filter(isDeal).length);
    expect((res.body.items as { compareAtCentavos: number | null }[]).every((i) => i.compareAtCentavos !== null)).toBe(true);

    const productId = await h.idOf("aurasound-pro");
    const original = await h.db.prisma.productVariant.findMany({ where: { productId }, select: { id: true, saleEndsAt: true } });
    // A minute ago, not a second: the test machine's clock and the database's can differ by more than a second (seen: 1.15 s with Neon).
    await h.db.prisma.productVariant.updateMany({ where: { productId }, data: { saleEndsAt: new Date(Date.now() - 60_000) } });
    try {
      const after = await search("deal=true&pageSize=48");
      expect(after.body.totalItems).toBe(res.body.totalItems - 1);
      expect((after.body.items as { slug: string }[]).map((i) => i.slug)).not.toContain("aurasound-pro");
    } finally {
      for (const v of original) await h.db.prisma.productVariant.update({ where: { id: v.id }, data: { saleEndsAt: v.saleEndsAt } });
    }
    expect((await search("deal=maybe")).status).toBe(400);
  });
});

describe("Follow a store", () => {
  it("needs you to be signed in, and a CSRF token to change anything", async () => {
    const anonymous = await h.browser();
    for (const res of [await anonymous.get(follow("glow-lab")), await anonymous.put(follow("glow-lab")), await anonymous.delete(follow("glow-lab"))]) {
      expect(res.status).toBe(401);
    }
    const { browser } = await shopper();
    const noToken = await browser.agent.put(follow("glow-lab"));
    expect(noToken.status).toBe(403);
    expect(noToken.body.error.code).toBe("CSRF_INVALID");
    expect((await browser.get(follow("glow-lab"))).body.following).toBe(false);
  });

  it("follows and unfollows, counting each shopper once however often they click", async () => {
    const { browser, user } = await shopper();
    const start = (await browser.get(follow("glow-lab"))).body as { following: boolean; followerCount: number };
    expect(start.following).toBe(false);

    const first = await browser.put(follow("glow-lab"));
    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toBe("private, no-store");
    expect(first.body).toEqual({ following: true, followerCount: start.followerCount + 1 });
    expect((await browser.put(follow("glow-lab"))).body).toEqual({ following: true, followerCount: start.followerCount + 1 });
    expect((await browser.get(follow("glow-lab"))).body).toEqual({ following: true, followerCount: start.followerCount + 1 });
    expect((await storePage("glow-lab")).body.store.followerCount).toBe(start.followerCount + 1);

    expect((await browser.delete(follow("glow-lab"))).body).toEqual({ following: false, followerCount: start.followerCount });
    expect((await browser.delete(follow("glow-lab"))).body).toEqual({ following: false, followerCount: start.followerCount });
    expect(await h.db.prisma.storeFollow.count({ where: { userId: user.id } })).toBe(0);
  });

  it("counts a burst of simultaneous clicks once", async () => {
    const { browser, user } = await shopper();
    const before = (await storePage("peak-outdoors")).body.store.followerCount as number;
    const results = await Promise.all([1, 2, 3, 4].map(() => browser.put(follow("peak-outdoors"))));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect((await storePage("peak-outdoors")).body.store.followerCount).toBe(before + 1);
    expect(await h.db.prisma.storeFollow.count({ where: { userId: user.id } })).toBe(1);
  });

  it("refuses following your own store", async () => {
    const { browser, user } = await shopper();
    await h.db.prisma.store.create({ data: { ownerId: user.id, name: "My Little Shop", slug: "my-little-shop", businessType: "INDIVIDUAL", status: "APPROVED", submittedAt: new Date(), approvedAt: new Date() } });
    const res = await browser.put(follow("my-little-shop"));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
    expect(await h.db.prisma.storeFollow.count({ where: { userId: user.id } })).toBe(0);
  });

  it("can't start following a suspended store, but can always unfollow one", async () => {
    const { browser } = await shopper();
    expect((await browser.put(follow("nova-wearables"))).status).toBe(200);
    const followed = (await browser.get(follow("nova-wearables"))).body.followerCount as number;
    await h.db.prisma.store.update({ where: { slug: "nova-wearables" }, data: { status: "SUSPENDED", suspendedAt: new Date(), suspendedCause: "ADMIN" } });
    try {
      const other = await shopper();
      expect((await other.browser.put(follow("nova-wearables"))).status).toBe(404);
      const left = await browser.delete(follow("nova-wearables"));
      expect(left.status).toBe(200);
      expect(left.body).toEqual({ following: false, followerCount: followed - 1 });
    } finally {
      await h.db.prisma.store.update({ where: { slug: "nova-wearables" }, data: { status: "APPROVED" } });
    }
    expect((await browser.put(follow("no-such-store"))).status).toBe(404);
    expect((await browser.delete(follow("no-such-store"))).status).toBe(404);
  });
});
