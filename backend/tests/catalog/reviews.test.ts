import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemoData } from "../../prisma/demo-data.js";
import { recomputeRatings } from "../../src/modules/reviews/ratings.js";
import { shortName, summarize } from "../../src/modules/reviews/reviews.service.js";
import { createCatalogHarness, type CatalogHarness } from "../support/catalogHarness.js";

let h: CatalogHarness;
beforeAll(async () => {
  h = await createCatalogHarness();
}, 120_000);
afterAll(() => h?.close());

type Summary = { avg: number; count: number; stars: { stars: number; count: number; percent: number }[] };
type Item = { id: string; rating: number; title: string | null; body: string | null; author: string; variantName: string; verifiedPurchase: boolean; createdAt: string; product?: { id: string; title: string; available: boolean } };
type ReviewPage = { summary: Summary; items: Item[]; page: number; pageSize: number; totalItems: number; totalPages: number };

const productReviews = async (slug: string, qs = "") => request(h.app).get(`/api/v1/products/${await h.idOf(slug)}/reviews${qs ? `?${qs}` : ""}`);
const storeReviews = (slug: string, qs = "") => request(h.app).get(`/api/v1/stores/${slug}/reviews${qs ? `?${qs}` : ""}`);
const isNewestFirst = (items: Item[]) => items.every((r, i) => i === 0 || (items[i - 1] as Item).createdAt >= r.createdAt);

describe("GET /products/:id/reviews", () => {
  it("summarizes the same numbers the product page shows, with star bars that add up", async () => {
    const res = await productReviews("aurasound-pro");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
    const body = res.body as ReviewPage;
    const page = (await request(h.app).get(`/api/v1/products/${await h.idOf("aurasound-pro")}`)).body.product;

    expect(body.summary.count).toBeGreaterThan(0);
    expect({ avg: body.summary.avg, count: body.summary.count }).toEqual(page.rating);
    expect(body.summary.stars.map((s) => s.stars)).toEqual([5, 4, 3, 2, 1]);
    expect(body.summary.stars.reduce((sum, s) => sum + s.count, 0)).toBe(body.summary.count);
    for (const s of body.summary.stars) expect(s.percent).toBe(Math.round((s.count * 100) / body.summary.count));
    expect(body.totalItems).toBe(body.summary.count);
    expect(body.totalPages).toBe(Math.ceil(body.summary.count / 10));
  });

  it("lists verified purchases newest first, showing only a first name and initial", async () => {
    const body = (await productReviews("aurasound-pro")).body as ReviewPage;
    const variants = (await h.db.prisma.productVariant.findMany({ where: { product: { slug: "aurasound-pro" } }, select: { name: true } })).map((v) => v.name);
    expect(body.items.length).toBe(Math.min(10, body.totalItems));
    expect(isNewestFirst(body.items)).toBe(true);
    for (const r of body.items) {
      // Exactly these fields: no user id, email or full name ever leaves the API.
      expect(Object.keys(r).sort()).toEqual(["author", "body", "createdAt", "id", "rating", "title", "variantName", "verifiedPurchase"]);
      expect(r.author).toMatch(/^[A-Z][a-z]+ [A-Z]\.$/);
      expect(r.verifiedPurchase).toBe(true);
      expect(variants).toContain(r.variantName);
      expect(r.body).toBeTruthy();
    }
  });

  it("pages through every review exactly once", async () => {
    const first = (await productReviews("vitamin-c-serum-30")).body as ReviewPage;
    expect(first.totalPages).toBeGreaterThan(1);
    const ids: string[] = [];
    for (let page = 1; page <= first.totalPages; page++) ids.push(...((await productReviews("vitamin-c-serum-30", `page=${page}`)).body as ReviewPage).items.map((r) => r.id));
    expect(ids.length).toBe(first.totalItems);
    expect(new Set(ids).size).toBe(first.totalItems);
  });

  it("filters by stars (clicking a bar) and sorts by highest or lowest", async () => {
    const all = ((await productReviews("vitamin-c-serum-30")).body as ReviewPage).summary;
    for (const bar of all.stars.filter((s) => s.count > 0)) {
      const res = (await productReviews("vitamin-c-serum-30", `rating=${bar.stars}`)).body as ReviewPage;
      expect(res.totalItems).toBe(bar.count);
      expect(res.items.every((r) => r.rating === bar.stars)).toBe(true);
      expect(res.summary).toEqual(all); // the summary always describes all reviews
    }
    const highest = ((await productReviews("vitamin-c-serum-30", "sort=highest")).body as ReviewPage).items.map((r) => r.rating);
    expect(highest).toEqual([...highest].sort((a, b) => b - a));
    const lowest = ((await productReviews("vitamin-c-serum-30", "sort=lowest")).body as ReviewPage).items.map((r) => r.rating);
    expect(lowest).toEqual([...lowest].sort((a, b) => a - b));
    expect(lowest[0]).toBe(Math.min(...all.stars.filter((s) => s.count > 0).map((s) => s.stars)));
  });

  it("leaves hidden reviews out of the list and, once recomputed, out of the rating", async () => {
    const productId = await h.idOf("aurasound-lite");
    const before = (await productReviews("aurasound-lite")).body as ReviewPage;
    const victim = await h.db.prisma.review.findFirstOrThrow({ where: { productId }, orderBy: { createdAt: "desc" } });
    await h.db.prisma.review.update({ where: { id: victim.id }, data: { status: "HIDDEN" } });
    try {
      await recomputeRatings(h.db.prisma, { productIds: [productId] });
      const after = (await productReviews("aurasound-lite")).body as ReviewPage;
      expect(after.summary.count).toBe(before.summary.count - 1);
      expect(after.items.map((r) => r.id)).not.toContain(victim.id);
      const page = (await request(h.app).get(`/api/v1/products/${productId}`)).body.product;
      expect(page.rating).toEqual({ avg: after.summary.avg, count: after.summary.count });
    } finally {
      await h.db.prisma.review.update({ where: { id: victim.id }, data: { status: "PUBLISHED" } });
      await recomputeRatings(h.db.prisma, { productIds: [productId] });
    }
  });

  it("answers 404 when the product page would (draft, suspended store, unknown) and 400 for bad input", async () => {
    expect((await productReviews("boom-max-pro")).status).toBe(404);
    expect((await request(h.app).get("/api/v1/products/0193c0de-0000-7000-8000-000000000000/reviews")).status).toBe(404);
    expect((await request(h.app).get("/api/v1/products/not-a-uuid/reviews")).status).toBe(400);

    await h.db.prisma.store.update({ where: { slug: "glow-lab" }, data: { status: "SUSPENDED", suspendedAt: new Date(), suspendedCause: "ADMIN", suspendedReason: "Test: suspended" } });
    try {
      expect((await productReviews("vitamin-c-serum-30")).status).toBe(404);
    } finally {
      await h.db.prisma.store.update({ where: { slug: "glow-lab" }, data: { status: "APPROVED" } });
    }

    // Nothing on sale: hidden like on the product page.
    const productId = await h.idOf("studio-monitor-m50");
    await h.db.prisma.productVariant.updateMany({ where: { productId }, data: { isActive: false } });
    try {
      expect((await productReviews("studio-monitor-m50")).status).toBe(404);
    } finally {
      await h.db.prisma.productVariant.updateMany({ where: { productId }, data: { isActive: true } });
    }

    for (const qs of ["rating=0", "rating=6", "rating=4.5", "sort=helpful", "page=0", "page=51"]) {
      const res = await productReviews("aurasound-pro", qs);
      expect(res.status, qs).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("GET /stores/:slug/reviews", () => {
  it("lists every review of the store's products, matching the store's rating, with the product named", async () => {
    const res = await storeReviews("soundcraft-audio");
    expect(res.status).toBe(200);
    const body = res.body as ReviewPage;
    const store = (await request(h.app).get("/api/v1/stores/soundcraft-audio")).body.store;
    expect({ avg: body.summary.avg, count: body.summary.count }).toEqual(store.rating);
    expect(isNewestFirst(body.items)).toBe(true);

    const own = new Set((await h.db.prisma.product.findMany({ where: { store: { slug: "soundcraft-audio" } }, select: { id: true } })).map((p) => p.id));
    for (const r of body.items) {
      expect(own.has(r.product?.id ?? "")).toBe(true);
      expect(r.product).toEqual({ id: expect.any(String), title: expect.any(String), available: true });
    }
  });

  it("keeps reviews of products the seller stopped selling, but drops ones removed by moderation", async () => {
    const productId = await h.idOf("boom-mini");
    const reviewsOfIt = await h.db.prisma.review.count({ where: { productId, status: "PUBLISHED" } });
    const before = ((await storeReviews("soundcraft-audio")).body as ReviewPage).summary.count;
    try {
      await h.db.prisma.product.update({ where: { id: productId }, data: { status: "ARCHIVED" } });
      await recomputeRatings(h.db.prisma, { productIds: [productId] });
      const archived = (await storeReviews("soundcraft-audio", "sort=newest")).body as ReviewPage;
      expect(archived.summary.count).toBe(before);
      const all: Item[] = [];
      for (let page = 1; page <= archived.totalPages; page++) all.push(...((await storeReviews("soundcraft-audio", `page=${page}`)).body as ReviewPage).items);
      expect(all.filter((r) => r.product?.id === productId).every((r) => r.product?.available === false)).toBe(true);

      await h.db.prisma.product.update({ where: { id: productId }, data: { status: "REMOVED", removedAt: new Date(), removedReason: "Test: removed" } });
      await recomputeRatings(h.db.prisma, { productIds: [productId] });
      const removed = (await storeReviews("soundcraft-audio")).body as ReviewPage;
      expect(removed.summary.count).toBe(before - reviewsOfIt);
      const store = (await request(h.app).get("/api/v1/stores/soundcraft-audio")).body.store;
      expect(store.rating.count).toBe(before - reviewsOfIt);
    } finally {
      await h.db.prisma.product.update({ where: { id: productId }, data: { status: "ACTIVE" } });
      await recomputeRatings(h.db.prisma, { productIds: [productId] });
    }
  });

  it("answers 404 for unknown or unapproved stores and 400 for a malformed name", async () => {
    expect((await storeReviews("no-such-store")).status).toBe(404);
    expect((await storeReviews("Bad Slug!")).status).toBe(400);
    await h.db.prisma.store.update({ where: { slug: "sol-co" }, data: { status: "PENDING" } });
    try {
      expect((await storeReviews("sol-co")).status).toBe(404);
    } finally {
      await h.db.prisma.store.update({ where: { slug: "sol-co" }, data: { status: "APPROVED" } });
    }
  });
});

describe("rating maths", () => {
  it("rounds the average exactly like PostgreSQL does for the stored rating", async () => {
    // 39×1★ + 1×2★ averages exactly 1.025: naive floating-point rounding gives 1.02, PostgreSQL 1.03.
    const samples = [[5, 4, 4, 5, 5, 5, 4, 5], [5, 5, 4], [1, 2, 3, 4, 5, 5, 5], [4, 5, 5, 5, 5, 5, 5, 5, 4, 3, 5, 5, 4, 5, 5, 4], [3], [5, 4, 4, 4, 4, 4, 4, 4], [...Array<number>(39).fill(1), 2]];
    for (const ratings of samples) {
      const counts = [1, 2, 3, 4, 5].map((rating) => ({ rating, count: ratings.filter((r) => r === rating).length })).filter((c) => c.count > 0);
      const [pg] = await h.db.prisma.$queryRawUnsafe<{ avg: string }[]>(`SELECT round(avg(x), 2)::text AS avg FROM unnest($1::int[]) x`, ratings);
      expect(summarize(counts).avg, ratings.join(",")).toBe(Number(pg?.avg));
    }
    expect(summarize([])).toEqual({ avg: 0, count: 0, stars: [5, 4, 3, 2, 1].map((stars) => ({ stars, count: 0, percent: 0 })) });
  });

  it("shows names as first name + initial", () => {
    expect(shortName("Maria Santos")).toBe("Maria S.");
    expect(shortName("Nicole Dela Cruz")).toBe("Nicole D.");
    expect(shortName("Cher")).toBe("Cher");
    expect(shortName("  ")).toBe("Vendora shopper");
  });
});

describe("demo reviews", () => {
  it("are verified purchases: each review sits on a delivered order of that product, bought by the reviewer", async () => {
    const [broken] = await h.db.prisma.$queryRawUnsafe<{ n: number }[]>(`
      SELECT count(*)::int AS n FROM reviews r
      JOIN order_items oi ON oi.id = r."orderItemId"
      JOIN seller_orders so ON so.id = oi."sellerOrderId"
      JOIN orders o ON o.id = so."orderId"
      JOIN products p ON p.id = r."productId"
      WHERE oi."productId" <> r."productId" OR o."userId" <> r."userId" OR so."storeId" <> p."storeId"
         OR so.status <> 'DELIVERED' OR NOT (o."placedAt" < so."shippedAt" AND so."shippedAt" < so."deliveredAt" AND so."deliveredAt" < r."createdAt")
         OR o."placedAt" < p."publishedAt"`);
    expect(broken?.n).toBe(0);
    expect(h.demo.reviews).toBeGreaterThan(500);
  });

  it("give every stored rating, and seeding again changes nothing", async () => {
    const mismatches = `
      SELECT count(*)::int AS n FROM products p
      WHERE p."ratingCount" <> (SELECT count(*) FROM reviews r WHERE r."productId" = p.id AND r.status = 'PUBLISHED')
         OR p."ratingAvg" <> coalesce((SELECT round(avg(r.rating), 2) FROM reviews r WHERE r."productId" = p.id AND r.status = 'PUBLISHED'), 0)`;
    expect((await h.db.prisma.$queryRawUnsafe<{ n: number }[]>(mismatches))[0]?.n).toBe(0);

    const counts = () => Promise.all([h.db.prisma.review.count(), h.db.prisma.order.count(), h.db.prisma.orderItem.count(), h.db.prisma.user.count()]);
    const before = await counts();
    // An older seed approved the stores "now"; seeding again must date them before their products.
    await h.db.prisma.store.updateMany({ data: { approvedAt: new Date() } });
    await seedDemoData(h.db.prisma);
    expect(await counts()).toEqual(before);
    const [tooNew] = await h.db.prisma.$queryRawUnsafe<{ n: number }[]>(`
      SELECT count(*)::int AS n FROM products p JOIN stores s ON s.id = p."storeId" WHERE p."publishedAt" < s."approvedAt"`);
    expect(tooNew?.n).toBe(0);
    expect((await h.db.prisma.$queryRawUnsafe<{ n: number }[]>(mismatches))[0]?.n).toBe(0);
  }, 60_000); // re-runs the whole seed: hundreds of queries, slow against a remote database
});
