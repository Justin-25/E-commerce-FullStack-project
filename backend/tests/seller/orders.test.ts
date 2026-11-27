import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { autoConfirmAt, manilaDayStart, manilaTime, shipByFor } from "../../src/modules/orders/deadlines.js";
import type { Browser } from "../support/browser.js";
import { createCatalogHarness, type CatalogHarness } from "../support/catalogHarness.js";
import { sellers } from "../support/sellers.js";
import { HOME_ADDRESS, shopping } from "../support/shopping.js";

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
const DAY = 24 * HOUR;
const S = "/api/v1/seller/orders";

type Row = {
  id: string;
  number: string;
  late: boolean;
  status: string;
  customer: { name: string; city: string };
  items: { first: { title: string; variantName: string; quantity: number }; moreLines: number; units: number };
  subtotalCentavos: number;
};
type OrderList = { items: Row[]; counts: Record<string, number>; alerts: { dueToday: number; dueBy: string; late: number }; totalItems: number };
type SellerOrder = {
  id: string;
  number: string;
  status: string;
  placedAt: string;
  shipBy: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  autoConfirmAt: string | null;
  shipment: { courier: string; trackingNumber: string; packageWeightGrams: number | null } | null;
  shipTo: Record<string, unknown>;
  earnings: { status: string; availableAt: string | null; netCentavos: number };
  timeline: { type: string; message: string; at: string }[];
  next: { message: string; by: string } | null;
  [key: string]: unknown;
};

/** An approved seller (past the 30 fee-free days, so Vendora's 5% applies) with one published product at ₱1,500. */
async function sellerWithProduct(opts: { weightGrams?: number | null; stock?: number } = {}) {
  const seller = await sell.seller({ approve: true });
  await h.db.prisma.store.update({ where: { id: seller.store.id }, data: { approvedAt: new Date(Date.now() - 40 * DAY) } });
  const product = await sell.publish(seller.browser, {
    variants: [{ name: "Midnight Black", sku: `SKU-${randomUUID().slice(0, 8)}`, priceCentavos: 150_000, stock: opts.stock ?? 40 }],
    weightGrams: opts.weightGrams ?? null
  });
  const sku = product.variants[0]?.sku ?? "";
  /** My package in an order (an order can have packages from several stores). */
  const mine = (o: { packages: { id: string; store: { slug: string } }[] }) => o.packages.find((p) => p.store.slug === seller.store.slug)?.id ?? "";
  return { seller, product, sku, mine };
}

const list = async (b: Browser, query = "") => {
  const res = await b.get(`${S}${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as OrderList;
};
const view = async (b: Browser, id: string) => {
  const res = await b.get(`${S}/${id}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.order as SellerOrder;
};
const ship = (b: Browser, id: string, body: Record<string, unknown> = {}) => b.put(`${S}/${id}/shipment`, { courier: "LBC", trackingNumber: `LBC${randomUUID().slice(0, 8)}`, ...body });
const mailTo = (to: string, kind: string) => h.outbox.sent.filter((m) => m.to === to && m.kind === kind);

describe("Seller Center → Orders list", () => {
  it("lists only my paid packages: To ship most urgent first, tab counts, today's 6:00 PM deadline and late ones", async () => {
    const { seller, product, sku, mine } = await sellerWithProduct();
    const a = await shop.order(await shop.shopper("Maria Santos"), [[sku, 2]]);
    const b = await shop.order(await shop.shopper("Jun dela Cruz"), [[sku, 1], ["SC-POCKET-BLK", 1]]); // two stores: only my package
    const unpaid = await shop.order(await shop.shopper(), [[sku, 1]], { method: "GCASH" }); // still waiting for payment

    // 9:00 AM in Manila today: the older order (a) was due an hour ago, the newer one (b) is due by 6:00 PM today.
    const nineAm = manilaDayStart(new Date()).getTime() + 9 * HOUR;
    const sixPm = nineAm + 9 * HOUR;
    h.clock.offsetMs = nineAm - Date.now();
    await h.db.prisma.sellerOrder.update({ where: { id: mine(a) }, data: { shipBy: new Date(nineAm - HOUR) } });
    await h.db.prisma.sellerOrder.update({ where: { id: mine(b) }, data: { shipBy: new Date(sixPm) } });

    const res = await seller.browser.get(S);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const body = res.body as OrderList;
    expect(body.items.map((r) => r.number)).toEqual([a.number, b.number]); // the late one first, though it's older
    expect(body.counts).toEqual({ toShip: 2, shipped: 0, delivered: 0, all: 2 });
    expect(body.alerts).toEqual({ dueToday: 1, dueBy: new Date(sixPm).toISOString(), late: 1 });
    expect(body.items[0]).toMatchObject({ id: mine(a), late: true, status: "PREPARING", customer: { name: "Maria S.", city: "Manila" }, items: { units: 2 }, subtotalCentavos: 300_000 });
    expect(body.items[1]).toMatchObject({
      id: mine(b),
      late: false,
      customer: { name: "Jun C.", city: "Manila" },
      items: { first: { title: product.title, variantName: "Midnight Black", quantity: 1 }, moreLines: 0, units: 1 },
      subtotalCentavos: 150_000 // my part only: not SoundCraft's item, not the delivery fee
    });
    expect(JSON.stringify(body)).not.toContain(unpaid.number);

    // Search: by order number (any spelling) or by product name; % is plain text.
    for (const q of [a.number, a.number.replace("VD-", ""), `#${a.number}`]) expect((await list(seller.browser, `?q=${encodeURIComponent(q)}`)).items.map((r) => r.number)).toEqual([a.number]);
    expect((await list(seller.browser, `?q=${encodeURIComponent(product.title.slice(0, 12))}`)).totalItems).toBe(2);
    expect((await list(seller.browser, "?q=%25")).totalItems).toBe(0);
    // Other tabs: newest first.
    expect((await list(seller.browser, "?tab=all")).items.map((r) => r.number)).toEqual([b.number, a.number]);
    expect((await list(seller.browser, "?tab=shipped")).items).toEqual([]);
    expect((await seller.browser.get(`${S}?tab=returns`)).status).toBe(400);
  });

  it("emails the seller about each new order once it's paid: cash on delivery right away, online once PayMongo confirms", async () => {
    const { seller, product, sku, mine } = await sellerWithProduct();
    const maria = await shop.shopper();
    const cod = await shop.order(maria, [[sku, 2]]);
    let mail = mailTo(seller.user.email, "seller-new-order");
    expect(mail).toHaveLength(1);
    const shipBy = (await view(seller.browser, mine(cod))).shipBy ?? "";
    expect(mail[0]?.subject).toBe(`New order ${cod.number}: ship by ${manilaTime.format(new Date(shipBy))}`);
    expect(mail[0]?.text).toContain(`2 × ${product.title} · Midnight Black`);
    expect(mail[0]?.text).toContain(`/seller/orders/${mine(cod)}`);

    const online = await shop.order(maria, [[sku, 1]], { method: "GCASH" });
    expect(mailTo(seller.user.email, "seller-new-order")).toHaveLength(1); // not paid yet
    const session = h.paymongo.latest(online.id);
    h.paymongo.pay(session.id);
    expect((await maria.browser.get(`/api/v1/orders/${online.id}`)).body.order.status).toBe("PLACED"); // confirmed on return
    const hook = h.paymongo.webhook(session.id); // ...and reported again by the webhook
    expect((await request(h.app).post("/api/v1/webhooks/paymongo").set("content-type", "application/json").set("Paymongo-Signature", hook.signature).send(hook.body)).status).toBe(200);
    mail = mailTo(seller.user.email, "seller-new-order");
    expect(mail.map((m) => m.subject.split(":")[0])).toEqual([`New order ${cod.number}`, `New order ${online.number}`]);
    // Online orders get the same deadline rule, counted from when they were paid.
    const paid = await view(seller.browser, mine(online));
    expect(paid.shipBy).toBe(shipByFor(new Date(paid.placedAt)).toISOString());
    expect(new Date(paid.shipBy ?? "").getUTCHours()).toBe(10); // 6:00 PM in Manila
  });

  it("is only for sellers: signed out 401, shoppers 403, another store's order 404", async () => {
    const { seller, sku, mine } = await sellerWithProduct();
    const o = await shop.order(await shop.shopper(), [[sku, 1]]);
    const other = await sell.seller({ approve: true });
    const shopper = await shop.shopper();
    for (const path of [S, `${S}/export`, `${S}/${mine(o)}`]) {
      expect((await request(h.app).get(path)).status).toBe(401);
      const res = await shopper.browser.get(path);
      expect([res.status, res.body.error?.details?.reason]).toEqual([403, "not_a_seller"]);
    }
    expect((await shopper.browser.put(`${S}/${mine(o)}/shipment`, { courier: "LBC", trackingNumber: "LBC12345678" })).status).toBe(403);
    expect((await other.browser.get(`${S}/${mine(o)}`)).status).toBe(404);
    expect((await ship(other.browser, mine(o))).status).toBe(404);
    expect((await view(seller.browser, mine(o))).status).toBe("PREPARING"); // and nothing changed
    expect((await other.browser.get(`${S}/not-a-uuid`)).status).toBe(400);
    expect((await list(other.browser, "?tab=all")).totalItems).toBe(0);
    expect((await seller.browser.get(`${S}/${mine(o)}`)).status).toBe(200);
  });
});

describe("Seller Center → one order", () => {
  it("shows my items only, the full address while it needs shipping, what I earn (5% fee) and what's next", async () => {
    const { seller, product, sku, mine } = await sellerWithProduct({ weightGrams: 450 });
    const maria = await shop.shopper("Maria Santos");
    const o = await shop.order(maria, [[sku, 2], ["SC-POCKET-BLK", 1]]);
    const soundcraftItem = await h.db.prisma.productVariant.findFirstOrThrow({ where: { sku: "SC-POCKET-BLK" }, include: { product: true } });

    const order = await view(seller.browser, mine(o));
    expect(order).toMatchObject({
      number: o.number,
      status: "PREPARING",
      late: false,
      paymentMethod: "COD",
      canShip: true,
      canEditShipment: false,
      shipment: null,
      suggestedWeightGrams: 900, // 2 × 450 g
      autoConfirmAt: null,
      customer: { name: "Maria S.", ordersWithStore: 1 },
      shipTo: { name: "Maria Santos", phone: "+639171234567", street: HOME_ADDRESS.street, barangay: "Ermita", city: "Manila", region: "NCR", postalCode: "1000", hidden: false },
      earnings: { subtotalCentavos: 300_000, feeCentavos: 15_000, feePercent: 5, netCentavos: 285_000, status: "after_delivery", availableAt: null },
      store: { name: seller.store.name, shipsFrom: "Manila" }
    });
    expect(order.items).toEqual([
      {
        id: expect.any(String),
        productId: product.id,
        variantId: product.variants[0]?.id,
        title: product.title,
        variantName: "Midnight Black",
        sku,
        imageUrl: expect.any(String),
        unitPriceCentavos: 150_000,
        quantity: 2,
        lineTotalCentavos: 300_000
      }
    ]);
    expect(order.shipBy).toBe(shipByFor(new Date(order.placedAt)).toISOString());
    expect(order.timeline).toEqual([{ type: "placed", message: "Ordered with cash on delivery (the courier collects the payment)", at: order.placedAt }]);
    expect(order.next).toEqual({ message: "Waiting for you to ship", by: order.shipBy });
    // Never another store's items, nor the buyer's whole order.
    expect(JSON.stringify(order)).not.toContain(soundcraftItem.product.title);

    await shop.order(maria, [[sku, 1]]);
    expect((await view(seller.browser, mine(o))).customer).toEqual({ name: "Maria S.", ordersWithStore: 2 });
  });

  it("after delivery: the address is hidden (name and city only), the earnings are on hold 7 days, then available", async () => {
    const { seller, sku, mine } = await sellerWithProduct();
    const maria = await shop.shopper("Maria Santos");
    const o = await shop.order(maria, [[sku, 1]]);
    expect((await ship(seller.browser, mine(o), { courier: "Ninja Van", trackingNumber: "NV-0001-2345" })).status).toBe(200);
    expect((await maria.browser.post(`/api/v1/orders/${o.id}/packages/${mine(o)}/received`)).status).toBe(200);

    let order = await view(seller.browser, mine(o));
    const deliveredAt = order.deliveredAt ?? "";
    const availableAt = new Date(Date.parse(deliveredAt) + 7 * DAY).toISOString();
    expect(order).toMatchObject({ status: "DELIVERED", deliveryConfirmedBy: "buyer", canShip: false, canEditShipment: false });
    expect(order.shipTo).toEqual({ name: "Maria S.", phone: null, street: null, barangay: null, city: "Manila", province: null, region: "NCR", postalCode: null, hidden: true });
    expect(order.earnings).toMatchObject({ netCentavos: 142_500, status: "on_hold", availableAt });
    expect(order.next).toEqual({ message: "Your earnings are released to your payout balance", by: availableAt });
    expect(order.timeline.map((t) => [t.type, t.message])).toEqual([
      ["placed", "Ordered with cash on delivery (the courier collects the payment)"],
      ["shipped", "Shipped with Ninja Van · tracking NV00012345"],
      ["delivered", "Delivered · the buyer confirmed it"]
    ]);

    h.clock.offsetMs = 7 * DAY + HOUR;
    order = await view(seller.browser, mine(o));
    expect(order.earnings).toMatchObject({ status: "available", availableAt });
    expect(order.next).toBeNull();
  });
});

describe("Mark as shipped", () => {
  it("ships with the courier and tracking number (kept as letters and digits), and emails the buyer the tracking", async () => {
    const { seller, product, sku, mine } = await sellerWithProduct();
    const maria = await shop.shopper();
    const o = await shop.order(maria, [[sku, 1]]);
    const id = mine(o);

    for (const [body, field] of [
      [{ courier: "DHL", trackingNumber: "LBC12345678" }, "courier"],
      [{ courier: "LBC", trackingNumber: "12" }, "trackingNumber"],
      [{ courier: "LBC", trackingNumber: "LBC 1234 <5678>" }, "trackingNumber"],
      [{ courier: "LBC" }, "trackingNumber"],
      [{ courier: "LBC", trackingNumber: "LBC12345678", packageWeightGrams: 0 }, "packageWeightGrams"],
      [{ courier: "LBC", trackingNumber: "LBC12345678", packageWeightGrams: 100_001 }, "packageWeightGrams"]
    ] as const) {
      const res = await seller.browser.put(`${S}/${id}/shipment`, body);
      expect([res.status, res.body.error?.fields?.[0]?.path], JSON.stringify(body)).toEqual([400, field]);
    }
    expect((await seller.browser.put(`${S}/${id}/shipment`, { courier: "LBC", trackingNumber: "LBC12345678", status: "DELIVERED" })).status).toBe(400); // strict

    const res = await seller.browser.put(`${S}/${id}/shipment`, { courier: "LBC", trackingNumber: "7720 1934-5512", packageWeightGrams: 900 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const order = res.body.order as SellerOrder;
    expect(order).toMatchObject({ status: "SHIPPED", canShip: false, canEditShipment: true, shipment: { courier: "LBC", trackingNumber: "772019345512", packageWeightGrams: 900 } });
    expect(order.autoConfirmAt).toBe(autoConfirmAt(new Date(order.shippedAt ?? "")).toISOString());
    expect(order.next).toEqual({ message: "Waiting for the buyer to confirm delivery", by: order.autoConfirmAt });

    const [mail] = mailTo(maria.user.email, "package-shipped");
    expect(mail?.subject).toBe(`Your package from ${seller.store.name} is on its way (${o.number})`);
    expect(mail?.text).toContain("Courier: LBC");
    expect(mail?.text).toContain("Tracking number: 772019345512");
    expect(mail?.text).toContain(`1 × ${product.title} · Midnight Black`);

    // The buyer's tracking page: shipped, with "Order received" and the automatic date.
    const pkg = (await maria.browser.get(`/api/v1/orders/${o.id}`)).body.order.packages[0];
    expect(pkg).toMatchObject({ status: "SHIPPED", courier: "LBC", trackingNumber: "772019345512", canConfirmReceived: true, autoConfirmAt: order.autoConfirmAt });
    expect(pkg.events[0]).toMatchObject({ type: "shipped", message: "Shipped with LBC · tracking 772019345512" });
  });

  it("a double click changes nothing; a typo can be fixed until delivery (the buyer gets the new number); then it's locked", async () => {
    const { seller, sku, mine } = await sellerWithProduct();
    const maria = await shop.shopper();
    const o = await shop.order(maria, [[sku, 1]]);
    const id = mine(o);
    const details = { courier: "J&T Express", trackingNumber: "JT1234567890" };

    // Two clicks at the same moment: shipped once, one email.
    const [first, second] = await Promise.all([seller.browser.put(`${S}/${id}/shipment`, details), seller.browser.put(`${S}/${id}/shipment`, details)]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(first.body.order.shippedAt).toBe(second.body.order.shippedAt);
    expect(mailTo(maria.user.email, "package-shipped")).toHaveLength(1);
    expect(mailTo(maria.user.email, "package-tracking-updated")).toHaveLength(0);

    const fixed = await seller.browser.put(`${S}/${id}/shipment`, { courier: "J&T Express", trackingNumber: "JT1234567809", packageWeightGrams: 500 });
    expect(fixed.status).toBe(200);
    expect(fixed.body.order).toMatchObject({ shippedAt: first.body.order.shippedAt, shipment: { trackingNumber: "JT1234567809", packageWeightGrams: 500 } });
    const [update] = mailTo(maria.user.email, "package-tracking-updated");
    expect(update?.text).toContain("Tracking number: JT1234567809");

    expect((await maria.browser.post(`/api/v1/orders/${o.id}/packages/${id}/received`)).status).toBe(200);
    const late = await seller.browser.put(`${S}/${id}/shipment`, details);
    expect([late.status, late.body.error?.details?.reason]).toEqual([409, "already_delivered"]);
  });

  it("refuses another package's tracking number for the same courier (another courier's is fine)", async () => {
    const { seller, sku, mine } = await sellerWithProduct();
    const a = await shop.order(await shop.shopper(), [[sku, 1]]);
    const b = await shop.order(await shop.shopper(), [[sku, 1]]);
    expect((await ship(seller.browser, mine(a), { courier: "LBC", trackingNumber: "LBC55550001" })).status).toBe(200);
    const taken = await ship(seller.browser, mine(b), { courier: "LBC", trackingNumber: "lbc 5555 0001" });
    expect([taken.status, taken.body.error?.details?.reason, taken.body.error?.fields?.[0]?.path]).toEqual([409, "tracking_in_use", "trackingNumber"]);
    expect((await view(seller.browser, mine(b))).status).toBe("PREPARING");
    expect((await ship(seller.browser, mine(b), { courier: "Flash Express", trackingNumber: "LBC55550001" })).status).toBe(200);
  });

  it("a suspended store can still ship orders that are already paid (the buyers are waiting)", async () => {
    const { seller, sku, mine } = await sellerWithProduct();
    const o = await shop.order(await shop.shopper(), [[sku, 1]]);
    await h.db.prisma.store.update({ where: { id: seller.store.id }, data: { status: "SUSPENDED", suspendedAt: new Date(), suspendedCause: "ADMIN", suspendedReason: "Test: suspended" } });
    expect((await ship(seller.browser, mine(o))).status).toBe(200);
    expect((await list(seller.browser, "?tab=shipped")).totalItems).toBe(1);
  });
});

describe("Export CSV", () => {
  it("exports orders with Philippine times and pesos, buyers as 'Maria S.' only, and defuses spreadsheet formulas", async () => {
    const { seller, product, sku, mine } = await sellerWithProduct();
    const maria = await shop.shopper("Maria Santos");
    const a = await shop.order(maria, [[sku, 2]]);
    await ship(seller.browser, mine(a), { courier: "LBC", trackingNumber: "LBC77770001" });
    // A buyer who put a formula in their name and city, hoping the seller opens the file in Excel.
    const eve = await shop.shopper("Eve");
    const address = await eve.browser.post("/api/v1/addresses", { ...HOME_ADDRESS, fullName: '=HYPERLINK("http://evil.test","Refund") Cruz', city: "+Manila" });
    expect(address.status).toBe(201);
    const b = await shop.order({ browser: eve.browser, addressId: address.body.address.id as string }, [[sku, 1]]);

    const res = await seller.browser.get(`${S}/export`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename=vendora-orders-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const text = res.text.slice(1);
    expect(res.text.charCodeAt(0)).toBe(0xfeff); // so Excel reads ₱ and ñ as UTF-8
    const lines = text.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "Order,Placed (PH time),Status,Customer,City,Items,Units,Items subtotal (PHP),Vendora fee (PHP),You receive (PHP),Delivery,Payment,Ship by (PH time),Courier,Tracking number,Shipped (PH time),Delivered (PH time)"
    );
    expect(lines).toHaveLength(3);
    const [rowB, rowA] = lines.slice(1); // newest first
    expect(rowA).toMatch(new RegExp(`^${a.number},\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2},Shipped,Maria S\\.,Manila,2 × ${product.title} \\(Midnight Black\\),2,3000\\.00,150\\.00,2850\\.00,Standard,Cash on delivery,`));
    expect(rowA).toContain(",LBC,LBC77770001,");
    expect(rowB?.startsWith(`${b.number},`)).toBe(true);
    expect(rowB).toContain(`,"'=HYPERLINK(""http://evil.test"",""Refund"") C.",'+Manila,`);
    expect(text).not.toContain(HOME_ADDRESS.street);
    expect(text).not.toContain("917");

    const shipped = await seller.browser.get(`${S}/export?tab=shipped`);
    expect(shipped.text.trimEnd().split("\r\n")).toHaveLength(2);
    expect((await seller.browser.get(`${S}/export?tab=nope`)).status).toBe(400);
  });
});
