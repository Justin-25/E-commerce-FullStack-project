import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCatalogHarness, type CatalogHarness } from "../support/catalogHarness.js";

let h: CatalogHarness;
beforeAll(async () => {
  h = await createCatalogHarness();
}, 120_000);
afterAll(() => h?.close());

type Line = { variantId: string; title: string; quantity: number; unitPriceCentavos: number; compareAtCentavos: number | null; lineTotalCentavos: number; stock: { status: string; left?: number }; maxQuantity: number; priceChange: { fromCentavos: number; toCentavos: number } | null; issue: string | null };
type Group = { store: { slug: string }; items: Line[]; subtotalCentavos: number; deliveryCentavos: number; freeDelivery: { qualifies: boolean; remainingCentavos: number } };
type Cart = { groups: Group[]; summary: { itemCount: number; subtotalCentavos: number; savingsCentavos: number; deliveryCentavos: number; totalCentavos: number; issueCount: number; canCheckout: boolean } };

const C = "/api/v1/cart";
let emails = 0;
const shopper = () => h.signUp({ email: `cart${++emails}@example.com` });
/** A demo variant's id by SKU. */
const sku = async (s: string) => (await h.db.prisma.productVariant.findFirstOrThrow({ where: { sku: s }, select: { id: true } })).id;
const lineOf = (cart: Cart, variantId: string) => cart.groups.flatMap((g) => g.items).find((l) => l.variantId === variantId);

/** Temporarily changes the database, always putting it back. */
async function withChange(change: () => Promise<unknown>, restore: () => Promise<unknown>, check: () => Promise<void>) {
  await change();
  try {
    await check();
  } finally {
    await restore();
  }
}

describe("Cart (signed in)", () => {
  it("needs you to be signed in, and a CSRF token to change anything", async () => {
    const id = await sku("SC-AURA-PRO-BLK");
    const anonymous = await h.browser();
    for (const res of [await anonymous.get(C), await anonymous.post(`${C}/items`, { variantId: id }), await anonymous.post(`${C}/merge`, { items: [] })]) expect(res.status).toBe(401);
    const { browser } = await shopper();
    const noToken = await browser.agent.post(`${C}/items`).send({ variantId: id });
    expect(noToken.status).toBe(403);
    const empty = await browser.get(C);
    expect(empty.headers["cache-control"]).toBe("private, no-store");
    expect(empty.body.cart).toEqual({ groups: [], summary: { itemCount: 0, subtotalCentavos: 0, savingsCentavos: 0, deliveryCentavos: 0, totalCentavos: 0, issueCount: 0, canCheckout: false } });
  });

  it("adds items at today's price, one package per store, with the delivery rules", async () => {
    const { browser } = await shopper();
    const headphones = await sku("SC-AURA-PRO-BLK"); // ₱7,499 on a deal (was ₱9,999)
    const toner = await sku("GL-TONER-150"); // ₱599, Glow Lab

    await browser.post(`${C}/items`, { variantId: headphones, quantity: 2 });
    let cart = (await browser.post(`${C}/items`, { variantId: headphones })).body.cart as Cart; // adds 1 more
    expect(lineOf(cart, headphones)).toMatchObject({ quantity: 3, unitPriceCentavos: 749_900, compareAtCentavos: 999_900, lineTotalCentavos: 2_249_700, issue: null, priceChange: null });

    cart = (await browser.post(`${C}/items`, { variantId: toner })).body.cart as Cart;
    expect(cart.groups.map((g) => g.store.slug)).toEqual(["glow-lab", "soundcraft-audio"]); // newest first
    const [glow, sound] = cart.groups as [Group, Group];
    expect(glow).toMatchObject({ subtotalCentavos: 59_900, deliveryCentavos: 4_900, freeDelivery: { qualifies: false, remainingCentavos: 40_000 } });
    expect(sound).toMatchObject({ subtotalCentavos: 2_249_700, deliveryCentavos: 0, freeDelivery: { qualifies: true, remainingCentavos: 0 } });
    expect(cart.summary).toEqual({
      itemCount: 4,
      subtotalCentavos: 2_309_600,
      savingsCentavos: 3 * 250_000,
      deliveryCentavos: 4_900,
      totalCentavos: 2_314_500,
      issueCount: 0,
      canCheckout: true
    });
  });

  it("gives free delivery from exactly ₱999 per store", async () => {
    const { browser } = await shopper();
    const retinol = await sku("GL-RETINOL-30"); // exactly ₱999
    const cart = (await browser.post(`${C}/items`, { variantId: retinol })).body.cart as Cart;
    expect(cart.groups[0]).toMatchObject({ subtotalCentavos: 99_900, deliveryCentavos: 0, freeDelivery: { qualifies: true, remainingCentavos: 0 } });
  });

  it("refuses what can't be bought: sold out, not enough left, hidden, too many", async () => {
    const { browser } = await shopper();
    const sand = await sku("SC-AURA-PRO-SND"); // 9 left
    expect((await browser.post(`${C}/items`, { variantId: await sku("SC-AURA-PRO-SLV") })).body.error.message).toMatch(/sold out/i);
    expect((await browser.post(`${C}/items`, { variantId: "0193c0de-0000-7000-8000-000000000000" })).status).toBe(404); // unknown
    expect((await browser.post(`${C}/items`, { variantId: await sku("SC-BOOM-MAXPRO") })).status).toBe(404); // the draft product

    await browser.post(`${C}/items`, { variantId: sand, quantity: 5 });
    const tooMany = await browser.post(`${C}/items`, { variantId: sand, quantity: 5 });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.details).toEqual({ left: 9, inCart: 5 });
    for (const quantity of [0, 100, 1.5, "lots"]) expect((await browser.post(`${C}/items`, { variantId: sand, quantity })).status, String(quantity)).toBe(400);
    expect((await browser.post(`${C}/items`, { variantId: sand, userId: "someone-else" })).status).toBe(400); // only known fields
    expect(lineOf((await browser.get(C)).body.cart, sand)?.quantity).toBe(5);
  });

  it("changes quantities within stock and removes lines", async () => {
    const { browser } = await shopper();
    const coral = await sku("SC-BOOM-MINI-CRL"); // 28 left
    await browser.post(`${C}/items`, { variantId: coral });
    expect(lineOf((await browser.patch(`${C}/items/${coral}`, { quantity: 7 })).body.cart, coral)?.quantity).toBe(7);
    expect((await browser.patch(`${C}/items/${coral}`, { quantity: 29 })).status).toBe(409);
    expect((await browser.patch(`${C}/items/${await sku("GL-VITC-30")}`, { quantity: 1 })).status).toBe(404); // not in the cart
    expect((await browser.delete(`${C}/items/${coral}`)).body.cart.groups).toEqual([]);
    expect((await browser.delete(`${C}/items/${coral}`)).status).toBe(200); // twice is fine
  });

  it("flags lines that changed since they were added, and blocks checkout until they're fixed", async () => {
    const { browser } = await shopper();
    const blue = await sku("SC-BOOM-MINI-BLU"); // 6 left
    const serum = await sku("GL-VITC-30");
    await browser.post(`${C}/items`, { variantId: blue, quantity: 4 });
    await browser.post(`${C}/items`, { variantId: serum, quantity: 2 });

    await withChange(
      () => h.db.prisma.productVariant.update({ where: { id: blue }, data: { stock: 2 } }),
      () => h.db.prisma.productVariant.update({ where: { id: blue }, data: { stock: 6 } }),
      async () => {
        const cart = (await browser.get(C)).body.cart as Cart;
        expect(lineOf(cart, blue)).toMatchObject({ issue: "not_enough_stock", maxQuantity: 2, stock: { status: "low_stock", left: 2 } });
        expect(cart.summary).toMatchObject({ issueCount: 1, canCheckout: false, itemCount: 2 }); // only the serum counts
        await browser.patch(`${C}/items/${blue}`, { quantity: 2 });
        expect(((await browser.get(C)).body.cart as Cart).summary.canCheckout).toBe(true);
      }
    );

    const productId = (await h.db.prisma.productVariant.findUniqueOrThrow({ where: { id: serum }, select: { productId: true } })).productId;
    await withChange(
      () => h.db.prisma.product.update({ where: { id: productId }, data: { status: "ARCHIVED" } }),
      () => h.db.prisma.product.update({ where: { id: productId }, data: { status: "ACTIVE" } }),
      async () => {
        const cart = (await browser.get(C)).body.cart as Cart;
        expect(lineOf(cart, serum)).toMatchObject({ issue: "unavailable", maxQuantity: 0, stock: { status: "out_of_stock" }, priceChange: null });
        expect(cart.summary.canCheckout).toBe(false);
        // Glow Lab's package now has nothing to send, so no delivery fee for it.
        expect(cart.groups.find((g) => g.store.slug === "glow-lab")).toMatchObject({ subtotalCentavos: 0, deliveryCentavos: 0 });
        expect(cart.summary.deliveryCentavos).toBe(0);
        expect((await browser.patch(`${C}/items/${serum}`, { quantity: 1 })).status).toBe(409); // can only be removed
      }
    );
  });

  it("says when a price changed since it was added, until the shopper changes the quantity", async () => {
    const { browser } = await shopper();
    const serum = await sku("GL-VITC-30"); // ₱899 on a deal
    await browser.post(`${C}/items`, { variantId: serum });
    const original = await h.db.prisma.productVariant.findUniqueOrThrow({ where: { id: serum }, select: { saleEndsAt: true } });
    await withChange(
      () => h.db.prisma.productVariant.update({ where: { id: serum }, data: { saleEndsAt: new Date(Date.now() - 60_000) } }), // the deal ends
      () => h.db.prisma.productVariant.update({ where: { id: serum }, data: { saleEndsAt: original.saleEndsAt } }),
      async () => {
        const line = lineOf((await browser.get(C)).body.cart, serum);
        expect(line).toMatchObject({ unitPriceCentavos: 119_900, compareAtCentavos: null, priceChange: { fromCentavos: 89_900, toCentavos: 119_900 } });
        expect(lineOf((await browser.patch(`${C}/items/${serum}`, { quantity: 1 })).body.cart, serum)?.priceChange).toBeNull();
      }
    );
  });

  it("counts a burst of simultaneous adds exactly", async () => {
    const { browser } = await shopper();
    const coral = await sku("SC-BOOM-MINI-CRL");
    const results = await Promise.all([1, 2, 3, 4].map(() => browser.post(`${C}/items`, { variantId: coral })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(lineOf((await browser.get(C)).body.cart, coral)?.quantity).toBe(4);
  });

  it("holds at most 50 different items", async () => {
    const { browser, user } = await shopper();
    const variants = await h.db.prisma.productVariant.findMany({ where: { isActive: true, stock: { gt: 0 }, product: { status: "ACTIVE" } }, select: { id: true }, take: 51 });
    expect(variants.length).toBe(51);
    const cart = await h.db.prisma.cart.create({ data: { userId: user.id } });
    await h.db.prisma.cartItem.createMany({ data: variants.slice(0, 50).map((v) => ({ cartId: cart.id, variantId: v.id, quantity: 1 })) });
    const full = await browser.post(`${C}/items`, { variantId: variants[50]?.id });
    expect(full.status).toBe(409);
    expect(full.body.error.message).toMatch(/full/);
    expect((await browser.post(`${C}/items`, { variantId: variants[0]?.id })).status).toBe(200); // more of one already there is fine
    const merged = await browser.post(`${C}/merge`, { items: [{ variantId: variants[50]?.id, quantity: 1 }] });
    expect(merged.body.merge.skipped).toEqual([{ variantId: variants[50]?.id, reason: "cart_full" }]);
  });
});

describe("Guest cart", () => {
  it("shows a browser cart with the same rules, without saving anything", async () => {
    const [blk, toner, silver] = [await sku("SC-AURA-PRO-BLK"), await sku("GL-TONER-150"), await sku("SC-AURA-PRO-SLV")];
    const before = await h.db.prisma.cartItem.count();
    const res = await request(h.app).get(`${C}/preview?items=${blk}:1,${toner}:2,${blk}:1,${silver}:1`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const cart = res.body.cart as Cart;
    expect(lineOf(cart, blk)?.quantity).toBe(2); // listed twice: added together
    expect(lineOf(cart, toner)?.lineTotalCentavos).toBe(119_800);
    expect(lineOf(cart, silver)?.issue).toBe("out_of_stock");
    expect(cart.summary.canCheckout).toBe(false);
    expect(await h.db.prisma.cartItem.count()).toBe(before);
  });

  it("validates the list", async () => {
    const id = await sku("GL-TONER-150");
    const many = Array.from({ length: 51 }, () => `${id}:1`).join(",");
    for (const qs of ["", "items=", "items=nope:1", `items=${id}:0`, `items=${id}:abc`, `items=${many}`]) {
      const res = await request(h.app).get(`${C}/preview${qs ? `?${qs}` : ""}`);
      expect(res.status, qs.slice(0, 30)).toBe(400);
    }
  });

  it("is merged into the account cart at sign-in: quantities add up, capped by stock; the rest is reported", async () => {
    const { browser } = await shopper();
    const [coral, sand, silver, draft] = [await sku("SC-BOOM-MINI-CRL"), await sku("SC-AURA-PRO-SND"), await sku("SC-AURA-PRO-SLV"), await sku("SC-BOOM-MAXPRO")];
    await browser.post(`${C}/items`, { variantId: coral, quantity: 1 }); // already in the account cart

    const res = await browser.post(`${C}/merge`, {
      items: [
        { variantId: coral, quantity: 2 },
        { variantId: sand, quantity: 50 }, // only 9 left
        { variantId: silver, quantity: 1 }, // sold out
        { variantId: draft, quantity: 1 }, // not for sale
        { variantId: coral, quantity: 1 } // listed twice
      ]
    });
    expect(res.status).toBe(200);
    expect(res.body.merge).toEqual({
      added: 2,
      adjusted: [{ variantId: sand, quantity: 9 }],
      skipped: [
        { variantId: silver, reason: "sold_out" },
        { variantId: draft, reason: "unavailable" }
      ]
    });
    const cart = res.body.cart as Cart;
    expect(lineOf(cart, coral)?.quantity).toBe(4);
    expect(lineOf(cart, sand)?.quantity).toBe(9);
    expect(cart.summary.canCheckout).toBe(true);
    expect((await browser.post(`${C}/merge`, { items: [{ variantId: coral, quantity: 0 }] })).status).toBe(400);
  });
});

describe("Carts are private", () => {
  it("only ever change your own cart", async () => {
    const a = await shopper();
    const b = await shopper();
    const coral = await sku("SC-BOOM-MINI-CRL");
    await a.browser.post(`${C}/items`, { variantId: coral, quantity: 2 });
    expect((await b.browser.get(C)).body.cart.groups).toEqual([]);
    await b.browser.delete(`${C}/items/${coral}`);
    expect((await b.browser.patch(`${C}/items/${coral}`, { quantity: 1 })).status).toBe(404);
    expect(lineOf((await a.browser.get(C)).body.cart, coral)?.quantity).toBe(2);
  });
});
