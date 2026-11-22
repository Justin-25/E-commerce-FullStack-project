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

type Card = { id: string; slug: string; inStock: boolean; soldCount: number; store: { slug: string } };
type Recs = { basedOn: "cart" | "you" | "popular"; items: Card[]; seeAll: { categorySlug: string; categoryName: string } | null };

const forGuest = async (skus: string[] = []) => {
  const guest = await Browser.open(h.app);
  const items = (await Promise.all(skus.map(async (sku) => `${await shop.variantId(sku)}:1`))).join(",");
  const res = await guest.get(`/api/v1/cart/recommendations${items ? `?items=${items}` : ""}`);
  expect(res.status).toBe(200);
  expect(res.headers["cache-control"]).toBe("private, no-store");
  return res.body as Recs;
};
/** Each card's category slug, from the database. */
const categoriesOf = async (cards: Card[]) => {
  const rows = await h.db.prisma.product.findMany({ where: { id: { in: cards.map((c) => c.id) } }, select: { id: true, category: { select: { slug: true } } } });
  const by = new Map(rows.map((r) => [r.id, r.category.slug]));
  return cards.map((c) => by.get(c.id));
};
const soldDesc = (cards: Card[]) => cards.map((c) => c.soldCount).every((n, i, all) => i === 0 || (all[i - 1] ?? 0) >= n);
/** The public search, as an independent answer to "what's best-selling / top rated". */
const search = async (query: string) => ((await (await Browser.open(h.app)).get(`/api/v1/products?${query}`)).body.items as Card[]).filter((c) => c.inStock);

describe("Recommended for you (cart)", () => {
  it("guest: best sellers from the cart's categories, never what's already in the cart, never unpublished", async () => {
    const recs = await forGuest(["SC-POCKET-BLK"]); // Pocket Pal, a speaker
    expect(recs.basedOn).toBe("cart");
    expect(recs.items).toHaveLength(5);
    expect(await categoriesOf(recs.items)).toEqual(Array(5).fill("speakers"));
    expect(recs.items.map((c) => c.slug)).not.toContain("pocket-pal");
    expect(recs.items.map((c) => c.slug)).not.toContain("boom-max-pro"); // a draft
    expect(soldDesc(recs.items)).toBe(true);
    expect(recs.seeAll).toEqual({ categorySlug: "speakers", categoryName: "Speakers" });
  });

  it("never suggests a sold-out product, however popular", async () => {
    const { prisma } = h.db;
    // QuietWave (headphones) is sold out; make it the best seller of its category.
    const quiet = await prisma.product.findFirstOrThrow({ where: { slug: "quietwave-travel" } });
    await prisma.product.update({ where: { id: quiet.id }, data: { soldCount: 100_000 } });
    try {
      const recs = await forGuest(["SC-AURA-PRO-BLK"]);
      expect(recs.items.map((c) => c.slug)).not.toContain("quietwave-travel");
      expect(recs.items.every((c) => c.inStock)).toBe(true);
      expect(await categoriesOf(recs.items)).toEqual(Array(5).fill("headphones"));
    } finally {
      await prisma.product.update({ where: { id: quiet.id }, data: { soldCount: quiet.soldCount } });
    }
  });

  it("tops up with top-rated products when the cart's categories run out (guest)", async () => {
    // Lighting has 4 products; one is in the cart, so 3 come from lighting and 2 are top rated.
    const recs = await forGuest(["HH-LUMEN-WHT"]);
    expect(recs.basedOn).toBe("cart");
    const cats = await categoriesOf(recs.items);
    expect(cats.slice(0, 3)).toEqual(["lighting", "lighting", "lighting"]);
    expect(recs.items).toHaveLength(5);
    const topRated = (await search("sort=top_rated&pageSize=24")).filter((c) => !["lumen-desk-lamp", ...recs.items.slice(0, 3).map((x) => x.slug)].includes(c.slug));
    expect(recs.items.slice(3).map((c) => c.slug)).toEqual(topRated.slice(0, 2).map((c) => c.slug));
  });

  it("guest with an empty cart: top rated, with no 'See all' category", async () => {
    const recs = await forGuest();
    expect(recs.basedOn).toBe("popular");
    expect(recs.seeAll).toBeNull();
    expect(recs.items.map((c) => c.slug)).toEqual((await search("sort=top_rated&pageSize=24")).slice(0, 5).map((c) => c.slug));
  });

  it("'See all' is the category most of the cart is in", async () => {
    const recs = await forGuest(["GL-TONER-150", "SC-POCKET-BLK", "SC-BOOM-MINI-CRL"]);
    expect(recs.seeAll).toEqual({ categorySlug: "speakers", categoryName: "Speakers" });
    expect(recs.items.map((c) => c.slug)).not.toContain("boom-mini");
  });

  it("signed in: uses the account cart (not the browser's list), then wishlist categories and followed stores, then best sellers", async () => {
    const s = await shop.shopper();
    // Empty cart, nothing saved: best sellers.
    let recs = (await s.browser.get(`/api/v1/cart/recommendations?items=${await shop.variantId("SC-POCKET-BLK")}:1`)).body as Recs;
    expect(recs.basedOn).toBe("popular");
    expect(recs.items.map((c) => c.slug)).toEqual((await search("sort=best_selling&pageSize=24")).slice(0, 5).map((c) => c.slug));

    // A fragrance on the wishlist: fragrances first.
    const rose = await h.idOf("rose-veil-edp-50");
    expect((await s.browser.put(`/api/v1/wishlist/${rose}`, {})).status).toBeLessThan(300);
    recs = (await s.browser.get("/api/v1/cart/recommendations")).body as Recs;
    expect(recs.basedOn).toBe("you");
    expect((await categoriesOf(recs.items)).slice(0, 4)).toEqual(["fragrance", "fragrance", "fragrance", "fragrance"]);

    // Following a store: its products next.
    expect((await s.browser.put("/api/v1/stores/northbound-goods/follow", {})).status).toBeLessThan(300);
    recs = (await s.browser.get("/api/v1/cart/recommendations")).body as Recs;
    expect(recs.items.slice(4).map((c) => c.store.slug)).toEqual(["northbound-goods"]);

    // Something in the account cart comes first.
    await shop.addToCart(s.browser, [["HH-LUMEN-WHT", 1]]);
    recs = (await s.browser.get("/api/v1/cart/recommendations")).body as Recs;
    expect(recs.basedOn).toBe("cart");
    expect((await categoriesOf(recs.items)).slice(0, 3)).toEqual(["lighting", "lighting", "lighting"]);
    expect(recs.items.map((c) => c.slug)).not.toContain("lumen-desk-lamp");
    expect(recs.seeAll?.categorySlug).toBe("lighting");
  });

  it("refuses a malformed cart list", async () => {
    const guest = await Browser.open(h.app);
    for (const q of ["?items=", "?items=not-a-uuid:1", `?items=${await shop.variantId("SC-POCKET-BLK")}:0`]) {
      expect((await guest.get(`/api/v1/cart/recommendations${q}`)).status, q).toBe(400);
    }
  });
});
