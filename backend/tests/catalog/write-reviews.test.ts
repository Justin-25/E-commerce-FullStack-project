import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Browser } from "../support/browser.js";
import { createCatalogHarness, type CatalogHarness } from "../support/catalogHarness.js";
import { shopping } from "../support/shopping.js";

let h: CatalogHarness;
let shop: ReturnType<typeof shopping>;
beforeAll(async () => {
  h = await createCatalogHarness();
  shop = shopping(h);
}, 120_000);
afterAll(() => h?.close());

type Item = { id: string; review: { id: string; rating: number; title: string | null; body: string | null; status: string } | null; canReview: boolean };
const LAMP = "HH-LUMEN-WHT"; // Lumen Dimmable LED Desk Lamp · White (Hearth & Home), ₱1,499
const BEDSIDE = "HH-STONE-SND"; // Stone Bedside Touch Lamp · Sand (Hearth & Home)

/** A shopper whose order with these items has been delivered; returns the order items by SKU order. */
async function delivered(skus: string[], name = "Ana Reyes") {
  const s = await shop.shopper(name);
  const o = await shop.order(s, skus.map((sku) => [sku, 1] as [string, number]));
  await shop.deliver(o.id);
  const items = await itemsOf(s.browser, o.id);
  return { ...s, orderId: o.id, items };
}
const itemsOf = async (b: Browser, orderId: string) => ((await b.get(`/api/v1/orders/${orderId}`)).body.order.packages as { items: Item[] }[]).flatMap((p) => p.items);
const write = (b: Browser, body: object) => b.post("/api/v1/reviews", body);

/**
 * The stored ratings must always equal what the published reviews say: the product's, and
 * the store's (all its products except removed ones). Checked straight against the reviews.
 */
async function expectRatingsMatchReviews(productId: string) {
  const [row] = await h.db.prisma.$queryRaw<
    { productAvg: number; productCount: number; storeAvg: number; storeCount: number; realProductAvg: number; realProductCount: number; realStoreAvg: number; realStoreCount: number }[]
  >`
    SELECT p."ratingAvg"::float AS "productAvg", p."ratingCount" AS "productCount", s."ratingAvg"::float AS "storeAvg", s."ratingCount" AS "storeCount",
      (SELECT coalesce(avg(r.rating), 0)::float FROM reviews r WHERE r."productId" = p.id AND r.status = 'PUBLISHED') AS "realProductAvg",
      (SELECT count(*)::int FROM reviews r WHERE r."productId" = p.id AND r.status = 'PUBLISHED') AS "realProductCount",
      (SELECT coalesce(avg(r.rating), 0)::float FROM reviews r JOIN products q ON q.id = r."productId" WHERE q."storeId" = s.id AND r.status = 'PUBLISHED' AND q.status <> 'REMOVED') AS "realStoreAvg",
      (SELECT count(*)::int FROM reviews r JOIN products q ON q.id = r."productId" WHERE q."storeId" = s.id AND r.status = 'PUBLISHED' AND q.status <> 'REMOVED') AS "realStoreCount"
    FROM products p JOIN stores s ON s.id = p."storeId" WHERE p.id = ${productId}::uuid`;
  if (!row) throw new Error("product not found");
  expect(row.productCount).toBe(row.realProductCount);
  expect(row.storeCount).toBe(row.realStoreCount);
  // Stored rounded to 2 decimals.
  expect(Math.abs(row.productAvg - row.realProductAvg)).toBeLessThanOrEqual(0.005 + 1e-9);
  expect(Math.abs(row.storeAvg - row.realStoreAvg)).toBeLessThanOrEqual(0.005 + 1e-9);
  return row;
}

describe("Writing a review", () => {
  it("is only possible once the package is delivered, then shows on the product and updates its and the store's rating", async () => {
    const s = await shop.shopper("Ana Reyes");
    const o = await shop.order(s, [[LAMP, 1]]);
    const [item] = await itemsOf(s.browser, o.id);
    const orderItemId = item?.id ?? "";
    expect(item?.canReview).toBe(false);
    const early = await write(s.browser, { orderItemId, rating: 5 });
    expect(early.status).toBe(409);
    expect(early.body.error.details).toEqual({ reason: "not_delivered" });
    await shop.ship(o.packages[0]?.id ?? "");
    expect((await write(s.browser, { orderItemId, rating: 5 })).status).toBe(409); // shipped isn't delivered
    await shop.deliver(o.id);
    expect((await itemsOf(s.browser, o.id))[0]?.canReview).toBe(true);

    const productId = await h.idOf("lumen-desk-lamp");
    const before = await expectRatingsMatchReviews(productId);
    const res = await write(s.browser, { orderItemId, rating: 1, title: "  Flickers at low brightness ", body: "The dimmer flickers below 20%." });
    expect(res.status).toBe(201);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body.review).toMatchObject({ orderItemId, productId, rating: 1, title: "Flickers at low brightness", body: "The dimmer flickers below 20%.", status: "PUBLISHED" });
    const after = await expectRatingsMatchReviews(productId);
    expect(after.productCount).toBe(before.productCount + 1);
    expect(after.storeCount).toBe(before.storeCount + 1);
    expect(after.productAvg).toBeLessThan(before.productAvg); // a 1★ pulls the average down

    // Newest first on the product's Reviews tab, by "Ana R.", as a verified purchase.
    const guest = await Browser.open(h.app);
    const page = (await guest.get(`/api/v1/products/${productId}/reviews`)).body;
    expect(page.items[0]).toMatchObject({ id: res.body.review.id, rating: 1, author: "Ana R.", variantName: "White", verifiedPurchase: true });
    expect(page.summary.count).toBe(after.productCount);
    // The order page shows the review instead of "Write a review".
    expect((await itemsOf(s.browser, o.id))[0]).toMatchObject({ canReview: false, review: { id: res.body.review.id, rating: 1, title: "Flickers at low brightness" } });
    const card = (await s.browser.get("/api/v1/orders")).body.items[0];
    expect(card.packages[0].reviewableItems).toBe(0);
  });

  it("allows one review per item bought, also when sent twice at the same moment", async () => {
    const s = await delivered([LAMP, BEDSIDE]);
    const [lamp, bedside] = s.items;
    expect((await write(s.browser, { orderItemId: lamp?.id, rating: 5 })).status).toBe(201);
    const again = await write(s.browser, { orderItemId: lamp?.id, rating: 4 });
    expect(again.status).toBe(409);
    expect(again.body.error.details).toEqual({ reason: "already_reviewed" });

    const both = await Promise.all([write(s.browser, { orderItemId: bedside?.id, rating: 5 }), write(s.browser, { orderItemId: bedside?.id, rating: 3 })]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await h.db.prisma.review.count({ where: { orderItemId: bedside?.id } })).toBe(1);
    await expectRatingsMatchReviews(await h.idOf("stone-bedside-lamp"));
  });

  it("is only for items in my own orders", async () => {
    const owner = await delivered([LAMP]);
    const other = await shop.shopper("Jose Rizal");
    const res = await write(other.browser, { orderItemId: owner.items[0]?.id, rating: 1 });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe("This item isn't in your orders.");
    expect((await write(other.browser, { orderItemId: "00000000-0000-7000-8000-000000000000", rating: 1 })).status).toBe(404);
    expect(await h.db.prisma.review.count({ where: { orderItemId: owner.items[0]?.id } })).toBe(0);
  });

  it("checks the stars and the text, accepts stars alone, and can't be used to set anything else", async () => {
    const s = await delivered([LAMP]);
    const orderItemId = s.items[0]?.id;
    const bad: object[] = [
      { orderItemId },
      { orderItemId, rating: 0 },
      { orderItemId, rating: 6 },
      { orderItemId, rating: 4.5 },
      { orderItemId, rating: "5" },
      { orderItemId, rating: 5, title: "t".repeat(121) },
      { orderItemId, rating: 5, body: "b".repeat(2001) },
      { orderItemId, rating: 5, body: "nul \u0000 byte" },
      { orderItemId, rating: 5, title: 5 },
      { orderItemId, rating: 5, status: "PUBLISHED" },
      { orderItemId, rating: 5, helpfulCount: 999 },
      { orderItemId, rating: 5, productId: await h.idOf("aurasound-pro") },
      { rating: 5 }
    ];
    for (const body of bad) expect((await write(s.browser, body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    expect(await h.db.prisma.review.count({ where: { orderItemId } })).toBe(0);

    const ok = await write(s.browser, { orderItemId, rating: 4, title: "   ", body: "Line one\nLine two\tok" });
    expect(ok.status).toBe(201);
    expect(ok.body.review).toMatchObject({ rating: 4, title: null, body: "Line one\nLine two\tok" });
  });

  it("can be edited any time: only the stars, title and text change, and the ratings follow", async () => {
    const s = await delivered([LAMP]);
    const productId = await h.idOf("lumen-desk-lamp");
    const { id } = (await write(s.browser, { orderItemId: s.items[0]?.id, rating: 5, title: "Great lamp", body: "Bright." })).body.review as { id: string };

    let res = await s.browser.patch(`/api/v1/reviews/${id}`, { rating: 2 });
    expect(res.status).toBe(200);
    expect(res.body.review).toMatchObject({ id, rating: 2, title: "Great lamp", body: "Bright." });
    await expectRatingsMatchReviews(productId);
    res = await s.browser.patch(`/api/v1/reviews/${id}`, { title: "", body: "Stopped working after a week." });
    expect(res.body.review).toMatchObject({ rating: 2, title: null, body: "Stopped working after a week." });

    // An allow-list: a valid change plus a field that isn't allowed is refused as a whole.
    for (const body of [{}, { rating: 9 }, { status: "HIDDEN" }, { orderItemId: s.items[0]?.id }, { helpfulCount: 5 }, { rating: 3, status: "HIDDEN" }, { rating: 3, productId: productId }]) {
      expect((await s.browser.patch(`/api/v1/reviews/${id}`, body)).status, JSON.stringify(body)).toBe(400);
    }
    const other = await shop.shopper("Jose Rizal");
    expect((await other.browser.patch(`/api/v1/reviews/${id}`, { rating: 5 })).status).toBe(404);
    expect((await h.db.prisma.review.findUniqueOrThrow({ where: { id } })).rating).toBe(2);

    // Hidden by moderation (milestone 7): editing doesn't bring it back, and it still doesn't count.
    await h.db.prisma.review.update({ where: { id }, data: { status: "HIDDEN" } });
    res = await s.browser.patch(`/api/v1/reviews/${id}`, { rating: 5 });
    expect(res.body.review).toMatchObject({ rating: 5, status: "HIDDEN" });
    await expectRatingsMatchReviews(productId);
    const guest = await Browser.open(h.app);
    const shown = (await guest.get(`/api/v1/products/${productId}/reviews`)).body.items as { id: string }[];
    expect(shown.map((r) => r.id)).not.toContain(id);
  });

  it("can be deleted, which updates the ratings, and the item can then be reviewed again", async () => {
    const s = await delivered([BEDSIDE]);
    const productId = await h.idOf("stone-bedside-lamp");
    const before = await expectRatingsMatchReviews(productId);
    const { id } = (await write(s.browser, { orderItemId: s.items[0]?.id, rating: 1 })).body.review as { id: string };
    const other = await shop.shopper("Jose Rizal");
    expect((await other.browser.delete(`/api/v1/reviews/${id}`)).status).toBe(404);

    const res = await s.browser.delete(`/api/v1/reviews/${id}`);
    expect(res.status).toBe(204);
    const after = await expectRatingsMatchReviews(productId);
    expect(after.productCount).toBe(before.productCount);
    expect(after.productAvg).toBe(before.productAvg);
    expect((await s.browser.delete(`/api/v1/reviews/${id}`)).status).toBe(404);
    expect((await itemsOf(s.browser, s.orderId))[0]).toMatchObject({ review: null, canReview: true });
    expect((await write(s.browser, { orderItemId: s.items[0]?.id, rating: 4 })).status).toBe(201);
  });

  it("needs sign-in", async () => {
    const guest = await Browser.open(h.app);
    expect((await write(guest, { orderItemId: "00000000-0000-7000-8000-000000000000", rating: 5 })).status).toBe(401);
    expect((await guest.patch("/api/v1/reviews/00000000-0000-7000-8000-000000000000", { rating: 5 })).status).toBe(401);
    expect((await guest.delete("/api/v1/reviews/00000000-0000-7000-8000-000000000000")).status).toBe(401);
  });

  it("keeps the stored ratings right when several shoppers review one store's products at the same moment", async () => {
    const shoppers = await Promise.all(["Ana Reyes", "Ben Cruz", "Cora Lim", "Dan Yu"].map((name, i) => delivered([i % 2 ? BEDSIDE : LAMP], name)));
    const results = await Promise.all(shoppers.map((s, i) => write(s.browser, { orderItemId: s.items[0]?.id, rating: 1 + i })));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    await expectRatingsMatchReviews(await h.idOf("lumen-desk-lamp"));
    await expectRatingsMatchReviews(await h.idOf("stone-bedside-lamp"));
  });
});
