import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Browser } from "../support/browser.js";
import { createCatalogHarness, type CatalogHarness } from "../support/catalogHarness.js";
import { sellers, type SellerProduct } from "../support/sellers.js";
import { shopping } from "../support/shopping.js";

let h: CatalogHarness;
let sell: ReturnType<typeof sellers>;
let shop: ReturnType<typeof shopping>;
beforeAll(async () => {
  h = await createCatalogHarness();
  sell = sellers(h);
  shop = shopping(h);
}, 120_000);
beforeEach(() => {
  h.clock.offsetMs = 0;
});
afterAll(() => h?.close());

const HOUR = 60 * 60 * 1000;

/** A seller with two published products (₱1,000 and ₱2,000) and a shopper who saved both. */
async function setUp() {
  const s = await sell.seller({ approve: true });
  const a = await sell.publish(s.browser, { title: "Boom Mini Portable Speaker", variants: [{ name: "Blue", priceCentavos: 100_000, stock: 5 }] });
  const b = await sell.publish(s.browser, { title: "QuietWave Travel ANC Headphones", variants: [{ name: "Black", priceCentavos: 200_000, stock: 5 }] });
  const fan = await shop.shopper("Maria Santos");
  for (const p of [a, b]) expect((await fan.browser.put(`/api/v1/wishlist/${p.id}`)).status).toBe(200);
  return { seller: s, a, b, fan };
}

/** The seller changes the price in Seller Center (returns the product as saved). */
async function reprice(seller: { browser: Browser }, product: SellerProduct, priceCentavos: number, extra: Record<string, unknown> = {}) {
  const current = (await seller.browser.get(`/api/v1/seller/products/${product.id}`)).body.product as SellerProduct;
  const form = sell.editForm(current, extra);
  const res = await seller.browser.put(`/api/v1/seller/products/${product.id}`, { ...form, variants: form.variants.map((v) => ({ ...v, priceCentavos })) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.product as SellerProduct;
}

async function run() {
  const result = await h.priceDrops().run();
  await h.priceDrops().drain();
  return result;
}
const emailsTo = (to: string) => h.outbox.sent.filter((m) => m.to === to && m.kind === "price-drop");

describe("Price-drop emails", () => {
  it("emails once when a saved item gets cheaper (with the was/now prices and an unsubscribe link), not again for the same price", async () => {
    const { seller, a, fan } = await setUp();
    await run();
    expect(emailsTo(fan.user.email)).toHaveLength(0); // nothing got cheaper yet

    await reprice(seller, a, 80_000);
    await run();
    const [email] = emailsTo(fan.user.email);
    expect(email?.subject).toBe("Price drop: Boom Mini Portable Speaker is now ₱800");
    expect(email?.text).toContain("Hi Maria,");
    expect(email?.text).toContain("• Boom Mini Portable Speaker: now ₱800 (was ₱1,000, save 20%).");
    expect(email?.text).toContain(`http://localhost:5173/products/${a.id}`);
    expect(email?.text).toMatch(/Stop price-drop emails: http:\/\/localhost:5173\/unsubscribe\?token=[0-9a-f-]{36}\.[0-9a-f]{64}/);
    expect(email?.headers).toEqual({
      "List-Unsubscribe": expect.stringMatching(/^<http:\/\/localhost:5173\/api\/v1\/notifications\/unsubscribe\?token=[0-9a-f-]{36}\.[0-9a-f]{64}>$/),
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
    });

    h.clock.offsetMs = 25 * HOUR; // even a day later: the same price isn't news
    await run();
    expect(emailsTo(fan.user.email)).toHaveLength(1);
  });

  it("at most one a day: later drops wait, then come together in one email", async () => {
    const { seller, a, b, fan } = await setUp();
    await reprice(seller, a, 90_000);
    await run();
    expect(emailsTo(fan.user.email)).toHaveLength(1);

    await reprice(seller, b, 150_000);
    await reprice(seller, a, 70_000);
    h.clock.offsetMs = 23 * HOUR;
    await run();
    expect(emailsTo(fan.user.email)).toHaveLength(1); // not yet: one a day

    h.clock.offsetMs = 25 * HOUR;
    await run();
    const second = emailsTo(fan.user.email)[1];
    expect(second?.subject).toBe("Price drop on 2 items in your wishlist");
    // The biggest saving first.
    expect(second?.text).toContain("2 items in your Vendora wishlist got cheaper:\n\n• QuietWave Travel ANC Headphones: now ₱1,500 (was ₱2,000, save 25%).");
    expect(second?.text).toContain("• Boom Mini Portable Speaker: now ₱700 (was ₱1,000, save 30%).");
  });

  it("a drop that's over makes the next drop news again", async () => {
    const { seller, a, fan } = await setUp();
    await reprice(seller, a, 80_000);
    await run();
    await reprice(seller, a, 100_000); // back to the saved price: the drop is over
    h.clock.offsetMs = 25 * HOUR;
    await run();
    expect((await h.db.prisma.wishlistItem.findFirstOrThrow({ where: { userId: fan.user.id, productId: a.id } })).notifiedPriceCentavos).toBeNull();

    await reprice(seller, a, 80_000);
    h.clock.offsetMs = 50 * HOUR;
    await run();
    expect(emailsTo(fan.user.email).map((m) => m.subject)).toEqual(["Price drop: Boom Mini Portable Speaker is now ₱800", "Price drop: Boom Mini Portable Speaker is now ₱800"]);
  });

  it("a deal starting is a drop too; hidden products and shoppers who opted out get nothing", async () => {
    const { seller, a, b, fan } = await setUp();
    const quiet = await shop.shopper("Juan Cruz");
    expect((await quiet.browser.put(`/api/v1/wishlist/${a.id}`)).status).toBe(200);
    expect((await quiet.browser.put("/api/v1/notifications/preferences", { priceDrops: false })).body).toEqual({ priceDrops: false });
    expect((await quiet.browser.get("/api/v1/notifications/preferences")).body).toEqual({ priceDrops: false });
    const unverified = await shop.shopper("Ana Lim");
    expect((await unverified.browser.put(`/api/v1/wishlist/${a.id}`)).status).toBe(200);
    await h.db.prisma.user.update({ where: { id: unverified.user.id }, data: { emailVerifiedAt: null } });

    // A deal on A (price ₱600 with ₱1,000 crossed out, ending in two days); B gets cheaper but is hidden.
    const current = (await seller.browser.get(`/api/v1/seller/products/${a.id}`)).body.product as SellerProduct;
    const withDeal = sell.editForm(current, { dealEndsAt: new Date(Date.now() + 48 * HOUR).toISOString() });
    const deal = await seller.browser.put(`/api/v1/seller/products/${a.id}`, { ...withDeal, variants: withDeal.variants.map((v) => ({ ...v, priceCentavos: 60_000, compareAtCentavos: 100_000 })) });
    expect(deal.status, JSON.stringify(deal.body)).toBe(200);
    await reprice(seller, b, 100_000, { active: false });

    await run();
    const [email] = emailsTo(fan.user.email);
    expect(email?.subject).toBe("Price drop: Boom Mini Portable Speaker is now ₱600");
    expect(email?.text).toMatch(/now ₱600 \(was ₱1,000, save 40%\)\. Deal ends [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}\s?[AP]M\./);
    expect(email?.text).not.toContain("QuietWave");
    expect(emailsTo(quiet.user.email)).toHaveLength(0);
    expect(emailsTo(unverified.user.email)).toHaveLength(0);
  });

  it("the unsubscribe link works without signing in, and only with our signature", async () => {
    const { seller, a, b, fan } = await setUp();
    await reprice(seller, a, 80_000);
    await run();
    const token = /unsubscribe\?token=([0-9a-f-]{36}\.[0-9a-f]{64})/.exec(emailsTo(fan.user.email)[0]?.text ?? "")?.[1] ?? "";
    const mailApp = await h.browser(); // no session, no CSRF token: like Gmail's own "Unsubscribe" button
    const post = (t: string) => mailApp.agent.post(`/api/v1/notifications/unsubscribe?token=${encodeURIComponent(t)}`).type("form").send("List-Unsubscribe=One-Click");

    const flipped = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
    const otherUser = `${seller.user.id}.${token.split(".")[1]}`;
    for (const bad of [flipped, otherUser, "nonsense", ""]) {
      const res = await post(bad);
      expect(res.status, bad).toBe(400);
    }
    expect((await fan.browser.get("/api/v1/notifications/preferences")).body).toEqual({ priceDrops: true });

    const res = await post(token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ priceDrops: false });
    expect((await post(token)).status).toBe(200); // twice is fine
    expect((await fan.browser.get("/api/v1/notifications/preferences")).body).toEqual({ priceDrops: false });

    await reprice(seller, b, 100_000);
    h.clock.offsetMs = 25 * HOUR;
    await run();
    expect(emailsTo(fan.user.email)).toHaveLength(1); // nothing after unsubscribing

    expect((await fan.browser.put("/api/v1/notifications/preferences", { priceDrops: true })).body).toEqual({ priceDrops: true });
    expect((await fan.browser.put("/api/v1/notifications/preferences", { priceDrops: "yes" })).status).toBe(400);
    expect((await mailApp.get("/api/v1/notifications/preferences")).status).toBe(401);
  });

  it("two runs at the same moment send one email", async () => {
    const { seller, a, fan } = await setUp();
    await reprice(seller, a, 80_000);
    await Promise.all([h.priceDrops().run(), h.priceDrops().run(), h.priceDrops().run()]);
    await h.priceDrops().drain();
    expect(emailsTo(fan.user.email)).toHaveLength(1);
  });
});
