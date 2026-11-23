import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
afterAll(() => h?.close());

const emails = (to: string) => h.outbox.sent.filter((m) => m.to === to && m.kind === "seller-low-stock");
const run = () => h.lowStock().run();

/** An approved seller with a published product at ₱100 (cheap enough for cash on delivery in bulk), stock 11 unless set. */
async function setUp(variants: { name: string; stock: number }[] = [{ name: "Blue", stock: 11 }], extra: Record<string, unknown> = {}) {
  const seller = await sell.seller({ approve: true });
  const product = await sell.publish(seller.browser, {
    title: `Boom Mini Portable Speaker ${randomUUID().slice(0, 4)}`,
    variants: variants.map((v) => ({ ...v, sku: `SKU-${randomUUID().slice(0, 8)}`, priceCentavos: 10_000 })),
    ...extra
  });
  return { seller, product };
}

/** A shopper buys `quantity` of a variant (cash on delivery). */
const buy = async (sku: string, quantity: number) => shop.order(await shop.shopper(), [[sku, quantity]]);

/** The seller changes a variant's stock in the product form. */
async function restock(b: Browser, p: SellerProduct, stock: number) {
  const current = (await b.get(`/api/v1/seller/products/${p.id}`)).body.product as SellerProduct;
  const form = sell.editForm(current);
  const res = await b.put(`/api/v1/seller/products/${p.id}`, { ...form, variants: form.variants.map((v, i) => (i === 0 ? { ...v, stock } : v)) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

describe("low-stock emails", () => {
  it("emails the seller when a sale takes a variant below 10, once until it's restocked", async () => {
    const { seller, product } = await setUp();
    const sku = product.variants[0]?.sku ?? "";
    await run();
    expect(emails(seller.user.email)).toHaveLength(0); // 11 left: fine

    await buy(sku, 2); // 9 left
    expect((await run()).emailed).toBeGreaterThanOrEqual(1);
    let mail = emails(seller.user.email);
    expect(mail).toHaveLength(1);
    expect(mail[0]?.subject).toBe(`Low stock: ${product.title} (Blue) is 9 left`);
    expect(mail[0]?.text).toContain(`• ${product.title} · Blue (SKU ${sku}): 9 left`);
    expect(mail[0]?.text).toContain("/seller/products");

    await buy(sku, 1); // 8 left: already told
    await run();
    expect(emails(seller.user.email)).toHaveLength(1);

    await restock(seller.browser, product, 20); // restocked: the next drop is news again
    await run();
    await buy(sku, 2); // 18: fine
    await run();
    expect(emails(seller.user.email)).toHaveLength(1);
    await buy(sku, 9); // 9 left again
    await run();
    mail = emails(seller.user.email);
    expect(mail).toHaveLength(2);
    expect(mail[1]?.subject).toBe(`Low stock: ${product.title} (Blue) is 9 left`);
  });

  it("isn't news when the seller typed the low number themselves (adding or editing); nothing for products with the alert off", async () => {
    const typed = await setUp([{ name: "Red", stock: 5 }]);
    const edited = await setUp([{ name: "Black", stock: 30 }]);
    const off = await setUp([{ name: "Green", stock: 11 }], { lowStockAlert: false });
    await restock(edited.seller.browser, edited.product, 6); // the seller lowers it in the form
    await buy(typed.product.variants[0]?.sku ?? "", 1); // 4 left, but the seller set 5 themselves
    await buy(edited.product.variants[0]?.sku ?? "", 1); // 5 left, the seller set 6
    await buy(off.product.variants[0]?.sku ?? "", 3); // 8 left, alert off
    await run();
    expect(emails(typed.seller.user.email)).toHaveLength(0);
    expect(emails(edited.seller.user.email)).toHaveLength(0);
    expect(emails(off.seller.user.email)).toHaveLength(0);
  });

  it("puts all of a store's low variants in one email (out of stock included), and two runs at once send it once", async () => {
    const { seller, product } = await setUp([
      { name: "Blue", stock: 11 },
      { name: "Coral", stock: 10 }
    ]);
    const [blue, coral] = product.variants;
    await buy(blue?.sku ?? "", 3); // 8 left
    await buy(coral?.sku ?? "", 10); // sold out
    await Promise.all([run(), run()]);
    const mail = emails(seller.user.email);
    expect(mail).toHaveLength(1);
    expect(mail[0]?.subject).toBe(`Low stock: 2 items in ${seller.store.name} are running out`);
    // The lowest stock first.
    expect(mail[0]?.text.split("\n").filter((l) => l.startsWith("•"))).toEqual([
      `• ${product.title} · Coral (SKU ${coral?.sku}): out of stock`,
      `• ${product.title} · Blue (SKU ${blue?.sku}): 8 left`
    ]);
  });
});
