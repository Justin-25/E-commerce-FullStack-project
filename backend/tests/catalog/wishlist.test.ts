import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppError } from "../../src/lib/errors.js";
import { MemoryKv } from "../../src/lib/kv.js";
import { CatalogService } from "../../src/modules/catalog/catalog.service.js";
import { WishlistService } from "../../src/modules/wishlist/wishlist.service.js";
import { createCatalogHarness, type CatalogHarness } from "../support/catalogHarness.js";

let h: CatalogHarness;
beforeAll(async () => {
  h = await createCatalogHarness();
}, 120_000);
afterAll(() => h?.close());

const W = "/api/v1/wishlist";
let emails = 0;
const shopper = () => h.signUp({ email: `wish${++emails}@example.com` });

type Item = { productId: string; title: string; store: { slug: string }; image: unknown; savedPriceCentavos: number; available: boolean; card: { priceCentavos: number; saleEndsAt: string | null } | null; priceDrop: { wasCentavos: number; nowCentavos: number; savingsCentavos: number; savingsPercent: number } | null };
type List = { items: Item[]; count: number; priceDrops: { count: number; dealsEndAt: string | null } };

/** Temporarily changes something in the database, always putting it back. */
async function withChange(change: () => Promise<unknown>, restore: () => Promise<unknown>, check: () => Promise<void>) {
  await change();
  try {
    await check();
  } finally {
    await restore();
  }
}

describe("Wishlist", () => {
  it("needs you to be signed in, and a CSRF token to change anything", async () => {
    const id = await h.idOf("aurasound-pro");
    const anonymous = await h.browser();
    for (const res of [await anonymous.get(W), await anonymous.get(`${W}/ids`), await anonymous.put(`${W}/${id}`), await anonymous.delete(`${W}/${id}`)]) {
      expect(res.status).toBe(401);
    }
    const { browser } = await shopper();
    const noToken = await browser.agent.put(`${W}/${id}`);
    expect(noToken.status).toBe(403);
    expect(noToken.body.error.code).toBe("CSRF_INVALID");
    expect((await browser.get(W)).body.count).toBe(0);
  });

  it("saves products at today's price, lists them newest first and fills the hearts", async () => {
    const { browser, user } = await shopper();
    const [older, newer] = [await h.idOf("aurasound-pro"), await h.idOf("boom-mini")];

    const first = await browser.put(`${W}/${older}`);
    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toBe("private, no-store");
    expect(first.body).toEqual({ productId: older, saved: true, savedPriceCentavos: 749_900, count: 1 }); // the deal price today
    await h.db.prisma.wishlistItem.update({ where: { userId_productId: { userId: user.id, productId: older } }, data: { createdAt: new Date(Date.now() - 60_000) } });
    expect((await browser.put(`${W}/${newer}`)).body.count).toBe(2);

    expect((await browser.get(`${W}/ids`)).body).toEqual({ productIds: [newer, older] });
    const list = (await browser.get(W)).body as List;
    expect(list.count).toBe(2);
    expect(list.items.map((i) => i.productId)).toEqual([newer, older]);
    for (const item of list.items) {
      expect(item.available).toBe(true);
      expect(item.card?.priceCentavos).toBe(item.savedPriceCentavos);
      expect(item.priceDrop).toBeNull();
    }
    expect(list.priceDrops).toEqual({ count: 0, dealsEndAt: null });
  });

  it("shows a price drop against the price when saved, and saving again keeps that first price", async () => {
    const { browser } = await shopper();
    const id = await h.idOf("hydra-steel-750"); // ₱1,099, no deal
    expect((await browser.put(`${W}/${id}`)).body.savedPriceCentavos).toBe(109_900);

    await withChange(
      () => h.db.prisma.productVariant.updateMany({ where: { productId: id }, data: { priceCentavos: 89_900 } }),
      () => h.db.prisma.productVariant.updateMany({ where: { productId: id }, data: { priceCentavos: 109_900 } }),
      async () => {
        const list = (await browser.get(W)).body as List;
        expect(list.items[0]?.priceDrop).toEqual({ wasCentavos: 109_900, nowCentavos: 89_900, savingsCentavos: 20_000, savingsPercent: 18 });
        expect(list.priceDrops).toEqual({ count: 1, dealsEndAt: null }); // no countdown on this one
        expect((await browser.put(`${W}/${id}`)).body.savedPriceCentavos).toBe(109_900);
      }
    );
  });

  it("counts a deal as a drop only while it runs, and the banner shows the soonest countdown", async () => {
    const { browser, user } = await shopper();
    const id = await h.idOf("aurasound-pro"); // deal ends in 30 hours
    const later = await h.idOf("raptor-gaming-headset"); // deal ends in 72 hours
    await browser.put(`${W}/${later}`);
    await browser.put(`${W}/${id}`);
    // As if both were saved before their deals started, at the regular price.
    await h.db.prisma.wishlistItem.update({ where: { userId_productId: { userId: user.id, productId: id } }, data: { priceAtSaveCentavos: 999_900 } });
    await h.db.prisma.wishlistItem.update({ where: { userId_productId: { userId: user.id, productId: later } }, data: { priceAtSaveCentavos: 279_900 } });

    const during = (await browser.get(W)).body as List;
    const item = (pid: string, list: List) => list.items.find((i) => i.productId === pid);
    expect(item(id, during)?.priceDrop).toMatchObject({ wasCentavos: 999_900, nowCentavos: 749_900, savingsPercent: 25 });
    expect(during.priceDrops.count).toBe(2);
    const soonest = item(id, during)?.card?.saleEndsAt ?? "";
    expect(soonest < (item(later, during)?.card?.saleEndsAt ?? "")).toBe(true);
    expect(during.priceDrops.dealsEndAt).toBe(soonest);

    const original = await h.db.prisma.productVariant.findMany({ where: { productId: id }, select: { id: true, saleEndsAt: true } });
    await withChange(
      () => h.db.prisma.productVariant.updateMany({ where: { productId: id }, data: { saleEndsAt: new Date(Date.now() - 60_000) } }),
      () => Promise.all(original.map((v) => h.db.prisma.productVariant.update({ where: { id: v.id }, data: { saleEndsAt: v.saleEndsAt } }))),
      async () => {
        const after = (await browser.get(W)).body as List;
        expect(item(id, after)?.card?.priceCentavos).toBe(999_900); // the deal ended: regular price again
        expect(item(id, after)?.priceDrop).toBeNull();
        expect(after.priceDrops).toEqual({ count: 1, dealsEndAt: item(later, after)?.card?.saleEndsAt });
      }
    );
  });

  it("keeps products that stop being sold, marked unavailable and never as a price drop", async () => {
    const { browser, user } = await shopper();
    const lamp = await h.idOf("clay-linen-lamp");
    const shades = await h.idOf("riviera-tortoise");
    await browser.put(`${W}/${lamp}`);
    await browser.put(`${W}/${shades}`);
    await h.db.prisma.wishlistItem.updateMany({ where: { userId: user.id }, data: { priceAtSaveCentavos: 9_999_900 } }); // would be big drops

    await withChange(
      () => Promise.all([
        h.db.prisma.product.update({ where: { id: lamp }, data: { status: "ARCHIVED" } }),
        h.db.prisma.store.update({ where: { slug: "sol-co" }, data: { status: "SUSPENDED", suspendedAt: new Date(), suspendedCause: "ADMIN" } })
      ]),
      () => Promise.all([
        h.db.prisma.product.update({ where: { id: lamp }, data: { status: "ACTIVE" } }),
        h.db.prisma.store.update({ where: { slug: "sol-co" }, data: { status: "APPROVED" } })
      ]),
      async () => {
        const list = (await browser.get(W)).body as List;
        expect(list.count).toBe(2);
        for (const item of list.items) {
          expect(item).toMatchObject({ available: false, card: null, priceDrop: null });
          expect(item.title).toBeTruthy();
          expect(item.image).not.toBeNull();
        }
        expect(list.priceDrops.count).toBe(0);
        expect((await browser.get(`${W}/ids`)).body.productIds).toHaveLength(2);
        expect((await browser.put(`${W}/${lamp}`)).status).toBe(404); // can't newly save it
      }
    );
    const back = (await browser.get(W)).body as List;
    expect(back.items.every((i) => i.available)).toBe(true);
    expect(back.priceDrops.count).toBe(2);

    expect((await browser.delete(`${W}/${lamp}`)).body).toEqual({ productId: lamp, saved: false, count: 1 });
  });

  it("refuses products shoppers can't see, and malformed ids", async () => {
    const { browser } = await shopper();
    expect((await browser.put(`${W}/${await h.idOf("boom-max-pro")}`)).status).toBe(404); // draft
    expect((await browser.put(`${W}/0193c0de-0000-7000-8000-000000000000`)).status).toBe(404);
    expect((await browser.put(`${W}/not-a-uuid`)).status).toBe(400);
    const id = await h.idOf("studio-monitor-m50");
    await withChange(
      () => h.db.prisma.productVariant.updateMany({ where: { productId: id }, data: { isActive: false } }),
      () => h.db.prisma.productVariant.updateMany({ where: { productId: id }, data: { isActive: true } }),
      async () => expect((await browser.put(`${W}/${id}`)).status).toBe(404)
    );
    expect((await browser.get(W)).body.count).toBe(0);
  });

  it("only ever touches your own list, and removing twice is fine", async () => {
    const a = await shopper();
    const b = await shopper();
    const id = await h.idOf("pocket-pal");
    await a.browser.put(`${W}/${id}`);
    expect((await b.browser.get(W)).body.count).toBe(0);
    expect((await b.browser.delete(`${W}/${id}`)).body).toEqual({ productId: id, saved: false, count: 0 });
    expect((await a.browser.get(`${W}/ids`)).body.productIds).toEqual([id]);
    expect((await a.browser.delete(`${W}/${id}`)).body.count).toBe(0);
    expect((await a.browser.delete(`${W}/${id}`)).body.count).toBe(0);
  });

  it("stores one row for a burst of simultaneous saves", async () => {
    const { browser, user } = await shopper();
    const id = await h.idOf("lakad-canvas");
    const results = await Promise.all([1, 2, 3, 4].map(() => browser.put(`${W}/${id}`)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await h.db.prisma.wishlistItem.count({ where: { userId: user.id } })).toBe(1);
  });

  it("stops at the limit, but re-saving something already there still works", async () => {
    const { user } = await shopper();
    const wishlist = new WishlistService({ prisma: h.db.prisma, catalog: new CatalogService({ prisma: h.db.prisma, kv: new MemoryKv() }), limit: 2 });
    const [a, b, c] = [await h.idOf("boom-mini"), await h.idOf("boom-max"), await h.idOf("pocket-pal")];
    await wishlist.save(user.id, a);
    await wishlist.save(user.id, b);
    await expect(wishlist.save(user.id, c)).rejects.toMatchObject({ status: 409, code: "CONFLICT" } satisfies Partial<AppError>);
    expect((await wishlist.save(user.id, a)).count).toBe(2);
  });
});
