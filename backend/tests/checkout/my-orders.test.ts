import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DELIVERY } from "../../src/lib/delivery.js";
import { Browser } from "../support/browser.js";
import { createCatalogHarness, type CatalogHarness } from "../support/catalogHarness.js";
import { shipByFor } from "../../src/modules/orders/deadlines.js";
import { HOME_ADDRESS, shopping, trackingNumber } from "../support/shopping.js";

let h: CatalogHarness;
let shop: ReturnType<typeof shopping>;
beforeAll(async () => {
  h = await createCatalogHarness();
  shop = shopping(h);
}, 120_000);
afterAll(() => h?.close());

type Card = {
  id: string;
  number: string;
  status: string;
  placedAt: string | null;
  paymentMethod: string;
  totalCentavos: number;
  itemCount: number;
  packages: {
    id: string;
    store: { slug: string; name: string };
    status: string;
    itemCount: number;
    items: { title: string; variantName: string; imageUrl: string | null; quantity: number }[];
    moreItems: number;
    estimatedDelivery: { earliest: string; latest: string } | null;
    courier: string | null;
    trackingNumber: string | null;
    shippedAt: string | null;
    deliveredAt: string | null;
    reviewableItems: number;
  }[];
};
type OrderList = { items: Card[]; counts: { all: number; toShip: number; onTheWay: number; delivered: number }; page: number; pageSize: number; totalItems: number; totalPages: number };
type Tracking = {
  id: string;
  status: string;
  createdAt: string;
  placedAt: string | null;
  packages: {
    id: string;
    store: { slug: string; name: string; logoUrl: string | null; rating: { avg: number; count: number } };
    status: string;
    courier: string | null;
    trackingNumber: string | null;
    shipBy: string | null;
    shippedAt: string | null;
    deliveredAt: string | null;
    estimatedDelivery: { earliest: string; latest: string } | null;
    steps: { step: string; at: string | null }[];
    events: { type: string; message: string; location: string | null; at: string }[];
    items: { id: string; review: unknown; canReview: boolean }[];
  }[];
};

const list = async (b: Browser, query = "") => (await b.get(`/api/v1/orders${query}`)).body as OrderList;
const getOrder = async (b: Browser, id: string) => (await b.get(`/api/v1/orders/${id}`)).body.order as Tracking;
const plusDays = (iso: string, days: number) => new Date(Date.parse(iso) + days * 24 * 60 * 60 * 1000).toISOString();
const deliverWebhook = (w: { body: string; signature: string }) =>
  request(h.app).post("/api/v1/webhooks/paymongo").set("content-type", "application/json").set("Paymongo-Signature", w.signature).send(w.body);

describe("Your orders", () => {
  it("lists my orders newest first, with each package's status, first items and arrival, and the tab counts", async () => {
    const s = await shop.shopper();
    const a = await shop.order(s, [["GL-TONER-150", 2]]);
    await shop.deliver(a.id);
    const b = await shop.order(s, [["SC-POCKET-BLK", 1], ["NW-TINY-PNK", 1]]); // two stores = two packages
    const soundcraft = b.packages.find((p) => p.store.slug === "soundcraft-audio");
    await shop.ship(soundcraft?.id ?? "", { courier: "LBC", trackingNumber: "8841 2201" });
    const c = await shop.order(s, [["SC-POCKET-BLK", 1], ["SC-POCKET-MNT", 1], ["SC-POCKET-LIL", 1], ["SC-BOOM-MINI-CRL", 1]]);

    const res = await s.browser.get("/api/v1/orders");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const body = res.body as OrderList;
    expect(body.items.map((o) => o.id)).toEqual([c.id, b.id, a.id]);
    // b is in two tabs at once: one package shipped, the other still to ship.
    expect(body.counts).toEqual({ all: 3, toShip: 2, onTheWay: 1, delivered: 1 });
    expect(body).toMatchObject({ page: 1, pageSize: 10, totalItems: 3, totalPages: 1 });

    const [cc, bb, aa] = body.items;
    // 4 items in one package: the card shows the first 3 and "+ 1 more", and when it should arrive.
    expect(cc).toMatchObject({ number: c.number, status: "PLACED", paymentMethod: "COD", itemCount: 4, totalCentavos: 3 * 79_900 + 249_900 });
    expect(cc?.packages[0]).toMatchObject({ status: "PREPARING", itemCount: 4, moreItems: 1, reviewableItems: 0, courier: null, deliveredAt: null });
    // Items keep the cart's order (newest added first): 3 of the 4 on the card.
    expect(cc?.packages[0]?.items.map((i) => i.variantName)).toEqual(["Coral", "Lilac", "Mint"]);
    const placedAt = cc?.placedAt ?? "";
    expect(cc?.packages[0]?.estimatedDelivery).toEqual({ earliest: plusDays(placedAt, DELIVERY.standardDays.min), latest: plusDays(placedAt, DELIVERY.standardDays.max) });

    // Packages keep the cart's order too (the store added to most recently first).
    expect(bb?.packages.map((p) => [p.store.slug, p.status, p.courier, p.trackingNumber])).toEqual([
      ["nova-wearables", "PREPARING", null, null],
      ["soundcraft-audio", "SHIPPED", "LBC", "8841 2201"]
    ]);
    // Delivered: no more estimate; its one line can be reviewed.
    expect(aa?.packages[0]).toMatchObject({ status: "DELIVERED", estimatedDelivery: null, reviewableItems: 1, itemCount: 2 });
    expect(aa?.packages[0]?.items).toEqual([{ title: expect.stringContaining("Toner"), variantName: expect.any(String), imageUrl: expect.any(String), quantity: 2 }]);

    expect((await list(s.browser, "?tab=to_ship")).items.map((o) => o.id)).toEqual([c.id, b.id]);
    expect((await list(s.browser, "?tab=on_the_way")).items.map((o) => o.id)).toEqual([b.id]);
    expect((await list(s.browser, "?tab=delivered")).items.map((o) => o.id)).toEqual([a.id]);
    expect((await list(s.browser, "?tab=all")).totalItems).toBe(3);
  });

  it("finds an order by its number (VD-…, #VD-…, digits) or by a product's name; % and _ are plain text", async () => {
    const s = await shop.shopper();
    const toner = await shop.order(s, [["GL-TONER-150", 1]]);
    const speaker = await shop.order(s, [["SC-POCKET-LIL", 1]]);
    const digits = toner.number.replace("VD-", "");
    for (const q of [toner.number, `#${toner.number}`, digits, toner.number.toLowerCase(), ` ${toner.number} `]) {
      expect((await list(s.browser, `?q=${encodeURIComponent(q)}`)).items.map((o) => o.id), q).toEqual([toner.id]);
    }
    expect((await list(s.browser, "?q=TONER")).items.map((o) => o.id)).toEqual([toner.id]);
    expect((await list(s.browser, "?q=pocket%20pal")).items.map((o) => o.id)).toEqual([speaker.id]);
    expect((await list(s.browser, "?q=pocket%20pal&tab=delivered")).items).toEqual([]);
    for (const q of ["%", "_", "%25", "nothing like this"]) expect((await list(s.browser, `?q=${encodeURIComponent(q)}`)).items, q).toEqual([]);
    // The counts are for the tabs, not the search.
    expect((await list(s.browser, "?q=TONER")).counts.all).toBe(2);
  });

  it("pages through orders 10 at a time", async () => {
    const s = await shop.shopper();
    const { prisma } = h.db;
    const v = await prisma.productVariant.findFirstOrThrow({ where: { sku: "GL-TONER-150" }, include: { product: true } });
    const start = Date.now() - 24 * 60 * 60 * 1000;
    for (let i = 0; i < 12; i++) {
      await prisma.order.create({
        data: {
          userId: s.user.id,
          status: "COMPLETED",
          paymentMethod: "COD",
          subtotalCentavos: 59_900,
          deliveryCentavos: 4_900,
          totalCentavos: 64_800,
          shippingAddress: HOME_ADDRESS,
          createdAt: new Date(start + i * 60_000),
          placedAt: new Date(start + i * 60_000),
          sellerOrders: {
            create: {
              storeId: v.product.storeId,
              status: "DELIVERED",
              subtotalCentavos: 59_900,
              deliveryCentavos: 4_900,
              courier: "LBC",
              trackingNumber: trackingNumber(),
              shippedAt: new Date(start + i * 60_000 + 60_000),
              deliveredAt: new Date(),
              items: { create: { variantId: v.id, productId: v.productId, productTitle: v.product.title, variantName: v.name, unitPriceCentavos: 59_900, quantity: 1 } }
            }
          }
        }
      });
    }
    const first = await list(s.browser);
    const second = await list(s.browser, "?page=2");
    expect(first).toMatchObject({ page: 1, pageSize: 10, totalItems: 12, totalPages: 2 });
    expect(first.items).toHaveLength(10);
    expect(second.items).toHaveLength(2);
    const all = [...first.items, ...second.items];
    expect(new Set(all.map((o) => o.id)).size).toBe(12);
    const times = all.map((o) => Date.parse(o.placedAt ?? ""));
    expect(times).toEqual([...times].sort((x, y) => y - x));
    expect((await list(s.browser, "?page=3")).items).toEqual([]);
  });

  it("shows unpaid and cancelled orders too, without an arrival estimate", async () => {
    const s = await shop.shopper();
    const o = await shop.order(s, [["NW-TINY-BLU", 1]], { method: "GCASH" });
    let card = (await list(s.browser)).items[0];
    expect(card).toMatchObject({ id: o.id, status: "PENDING_PAYMENT", paymentMethod: "GCASH", placedAt: null });
    expect(card?.packages[0]).toMatchObject({ status: "AWAITING_PAYMENT", estimatedDelivery: null });
    expect((await list(s.browser, "?tab=to_ship")).items).toEqual([]);

    expect((await s.browser.post(`/api/v1/orders/${o.id}/cancel`)).status).toBe(200);
    card = (await list(s.browser)).items[0];
    expect(card).toMatchObject({ id: o.id, status: "CANCELLED" });
    expect(card?.packages[0]).toMatchObject({ status: "CANCELLED", estimatedDelivery: null, reviewableItems: 0 });
  });

  it("only ever shows my own orders", async () => {
    const owner = await shop.shopper();
    const o = await shop.order(owner, [["GL-TONER-150", 1]]);
    await shop.deliver(o.id);
    const other = await shop.shopper("Jose Rizal");
    const theirs = await list(other.browser, `?q=${o.number}`);
    expect(theirs.items).toEqual([]);
    expect(theirs.counts).toEqual({ all: 0, toShip: 0, onTheWay: 0, delivered: 0 });
    expect((await other.browser.get(`/api/v1/orders/${o.id}`)).status).toBe(404);
    expect((await other.browser.post(`/api/v1/orders/${o.id}/buy-again`)).status).toBe(404);
  });

  it("needs sign-in, and refuses unknown tabs and bad pages", async () => {
    const guest = await Browser.open(h.app);
    expect((await guest.get("/api/v1/orders")).status).toBe(401);
    expect((await guest.post("/api/v1/orders/00000000-0000-7000-8000-000000000000/buy-again")).status).toBe(401);
    const s = await shop.shopper();
    for (const q of ["?tab=returns", "?page=0", "?page=51", "?page=two", `?q=${"a".repeat(101)}`]) expect((await s.browser.get(`/api/v1/orders${q}`)).status, q).toBe(400);
  });
});

describe("Order tracking", () => {
  it("follows a package from ordered to delivered: 4 steps with dates, the courier, and a timeline", async () => {
    const s = await shop.shopper();
    const o = await shop.order(s, [["NW-TINY-PNK", 1]], { delivery: { "nova-wearables": "EXPRESS" } });
    let view = await getOrder(s.browser, o.id);
    const placedAt = view.placedAt ?? "";
    let p = view.packages[0];
    const store = await h.db.prisma.store.findUniqueOrThrow({ where: { slug: "nova-wearables" } });
    expect(p?.store).toEqual({ slug: "nova-wearables", name: "Nova Wearables", logoUrl: store.logoUrl, rating: { avg: Number(store.ratingAvg), count: store.ratingCount } });
    expect(p?.steps).toEqual([
      { step: "ORDERED", at: view.createdAt },
      { step: "PREPARING", at: placedAt },
      { step: "SHIPPED", at: null },
      { step: "DELIVERED", at: null }
    ]);
    // Express: 1–2 days from when it was placed; the seller must ship by 6:00 PM (Manila) 2 days later.
    expect(p?.estimatedDelivery).toEqual({ earliest: plusDays(placedAt, DELIVERY.expressDays.min), latest: plusDays(placedAt, DELIVERY.expressDays.max) });
    expect(p?.shipBy).toBe(shipByFor(new Date(placedAt)).toISOString());
    expect(new Date(p?.shipBy ?? "").getUTCHours()).toBe(10); // 6:00 PM in Manila = 10:00 UTC
    expect(p?.events).toEqual([{ type: "placed", message: "Order placed · pay cash on delivery", location: null, at: placedAt }]);
    expect(p?.items[0]).toMatchObject({ review: null, canReview: false });

    const shippedAt = new Date(Date.parse(placedAt) + 60 * 60 * 1000);
    await shop.ship(p?.id ?? "", { courier: "J&T Express", trackingNumber: "JT0001", at: shippedAt });
    const hub = new Date(shippedAt.getTime() + 60 * 60 * 1000);
    await h.db.prisma.shipmentEvent.create({ data: { sellerOrderId: p?.id ?? "", status: "IN_TRANSIT", message: "Arrived at Manila sorting hub", location: "Pasay City", occurredAt: hub } });
    view = await getOrder(s.browser, o.id);
    p = view.packages[0];
    expect(p).toMatchObject({ status: "SHIPPED", courier: "J&T Express", trackingNumber: "JT0001", shippedAt: shippedAt.toISOString() });
    expect(p?.estimatedDelivery).not.toBeNull();
    expect(p?.steps.map((x) => x.at)).toEqual([view.createdAt, placedAt, shippedAt.toISOString(), null]);
    expect(p?.events.map((e) => [e.type, e.message, e.location])).toEqual([
      ["update", "Arrived at Manila sorting hub", "Pasay City"],
      ["shipped", "Shipped with J&T Express · tracking JT0001", null],
      ["placed", "Order placed · pay cash on delivery", null]
    ]);

    const deliveredAt = new Date(hub.getTime() + 24 * 60 * 60 * 1000);
    await h.db.prisma.sellerOrder.update({ where: { id: p?.id ?? "" }, data: { status: "DELIVERED", deliveredAt } });
    view = await getOrder(s.browser, o.id);
    p = view.packages[0];
    expect(p?.estimatedDelivery).toBeNull();
    expect(p?.steps.map((x) => x.at)).toEqual([view.createdAt, placedAt, shippedAt.toISOString(), deliveredAt.toISOString()]);
    expect(p?.events.map((e) => [e.type, e.at])).toEqual([
      ["delivered", deliveredAt.toISOString()],
      ["update", hub.toISOString()],
      ["shipped", shippedAt.toISOString()],
      ["placed", placedAt]
    ]);
    expect(p?.items[0]).toMatchObject({ review: null, canReview: true });
  });

  it("shows an online order waiting for payment, then paid with the method's name", async () => {
    const s = await shop.shopper();
    const o = await shop.order(s, [["NW-TINY-BLU", 1]], { method: "GCASH" });
    let view = await getOrder(s.browser, o.id);
    let p = view.packages[0];
    expect(p?.steps.map((x) => x.at)).toEqual([view.createdAt, null, null, null]);
    expect(p?.events).toEqual([{ type: "placed", message: "Order placed · waiting for payment", location: null, at: view.createdAt }]);

    const session = h.paymongo.latest(o.id);
    h.paymongo.pay(session.id);
    expect((await deliverWebhook(h.paymongo.webhook(session.id))).status).toBe(200);
    view = await getOrder(s.browser, o.id);
    p = view.packages[0];
    expect(view.status).toBe("PLACED");
    expect(p?.steps.map((x) => x.at)).toEqual([view.createdAt, view.placedAt, null, null]);
    expect(p?.events).toEqual([{ type: "placed", message: "Order placed and paid with GCash", location: null, at: view.placedAt }]);
  });

  it("shows a cancelled order as cancelled", async () => {
    const s = await shop.shopper();
    const o = await shop.order(s, [["NW-TINY-BLU", 1]], { method: "CARD" });
    await s.browser.post(`/api/v1/orders/${o.id}/cancel`);
    const p = (await getOrder(s.browser, o.id)).packages[0];
    expect(p).toMatchObject({ status: "CANCELLED", estimatedDelivery: null });
    expect(p?.events.map((e) => e.message)).toEqual(["Order cancelled", "Order placed · waiting for payment"]);
  });
});

describe("Buy again", () => {
  it("puts a past order's items back in the cart, as far as stock allows, and says what couldn't be added", async () => {
    const { prisma } = h.db;
    const s = await shop.shopper();
    const o = await shop.order(s, [["GL-TONER-150", 2], ["SC-POCKET-MNT", 1], ["PO-RUNFREE-VLT", 1], ["NW-TINY-PNK", 1]]);
    await shop.deliver(o.id);
    // Since then: only 1 toner left, the mint speaker sold out, and the neckband's store stopped selling it.
    const before = await prisma.productVariant.findMany({ where: { sku: { in: ["GL-TONER-150", "SC-POCKET-MNT", "PO-RUNFREE-VLT"] } }, select: { id: true, sku: true, stock: true, isActive: true } });
    await prisma.productVariant.updateMany({ where: { sku: "GL-TONER-150" }, data: { stock: 1 } });
    await prisma.productVariant.updateMany({ where: { sku: "SC-POCKET-MNT" }, data: { stock: 0 } });
    await prisma.productVariant.updateMany({ where: { sku: "PO-RUNFREE-VLT" }, data: { isActive: false } });
    try {
      const res = await s.browser.post(`/api/v1/orders/${o.id}/buy-again`);
      expect(res.status).toBe(200);
      const id = async (sku: string) => shop.variantId(sku);
      expect(res.body.merge).toEqual({
        added: 2,
        adjusted: [{ variantId: await id("GL-TONER-150"), quantity: 1 }],
        skipped: expect.arrayContaining([
          { variantId: await id("SC-POCKET-MNT"), reason: "sold_out" },
          { variantId: await id("PO-RUNFREE-VLT"), reason: "unavailable" }
        ])
      });
      expect(res.body.merge.skipped).toHaveLength(2);
      const lines = (res.body.cart.groups as { items: { variantId: string; quantity: number }[] }[]).flatMap((g) => g.items.map((i) => [i.variantId, i.quantity]));
      expect(lines.sort()).toEqual([[await id("GL-TONER-150"), 1], [await id("NW-TINY-PNK"), 1]].sort());
    } finally {
      for (const v of before) await prisma.productVariant.update({ where: { id: v.id }, data: { stock: v.stock, isActive: v.isActive } });
    }
  });

  it("refuses while the order is still waiting for payment", async () => {
    const s = await shop.shopper();
    const o = await shop.order(s, [["NW-TINY-BLU", 1]], { method: "MAYA" });
    const res = await s.browser.post(`/api/v1/orders/${o.id}/buy-again`);
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ reason: "not_paid" });
  });
});
