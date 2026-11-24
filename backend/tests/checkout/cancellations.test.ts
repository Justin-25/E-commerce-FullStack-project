import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PayMongoError } from "../../src/lib/paymongo.js";
import { recordRefund } from "../../src/modules/orders/refunds.js";
import type { Browser } from "../support/browser.js";
import { createCatalogHarness, type CatalogHarness } from "../support/catalogHarness.js";
import { sellers } from "../support/sellers.js";
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
  h.paymongo.refundRefusal = null;
  h.paymongo.loseRefundAnswer = false;
});
afterAll(() => h?.close());

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
type Order = { id: string; number: string; packages: { id: string; store: { slug: string } }[] };
type Pkg = { id: string; status: string; cancellation: { by: string; reason: string; message: string } | null; refund: { amountCentavos: number; status: string; sentAt: string | null } | null; events: { type: string; message: string }[] };

/** An approved seller (past the fee-free days) with one product at `priceCentavos` (stock 40). */
async function sellerWithProduct(priceCentavos = 50_000) {
  const seller = await sell.seller({ approve: true });
  await h.db.prisma.store.update({ where: { id: seller.store.id }, data: { approvedAt: new Date(Date.now() - 40 * DAY) } });
  const product = await sell.publish(seller.browser, { variants: [{ name: "Blue", sku: `SKU-${randomUUID().slice(0, 8)}`, priceCentavos, stock: 40 }] });
  const sku = product.variants[0]?.sku ?? "";
  const mine = (o: Order) => o.packages.find((p) => p.store.slug === seller.store.slug)?.id ?? "";
  return { seller, product, sku, mine };
}

/** Places an order and pays it online (the shopper comes back from PayMongo). */
async function paidOrder(s: { browser: Browser; addressId: string }, items: [string, number][], method: "GCASH" | "CARD" = "GCASH") {
  const o = (await shop.order(s, items, { method })) as Order;
  h.paymongo.pay(h.paymongo.latest(o.id).id);
  expect((await s.browser.get(`/api/v1/orders/${o.id}`)).body.order.status).toBe("PLACED");
  return o;
}

const cancel = (b: Browser, id: string, reason: string) => b.post(`/api/v1/seller/orders/${id}/cancel`, { reason });
const order = async (b: Browser, id: string) => (await b.get(`/api/v1/orders/${id}`)).body.order as { status: string; canCancel: boolean; cancelUntil: string | null; placedAt: string; payment: { status: string }; packages: Pkg[] };
const pkgOf = async (b: Browser, orderId: string, packageId: string) => (await order(b, orderId)).packages.find((p) => p.id === packageId) as Pkg;
const mail = (to: string, kind: string) => h.outbox.sent.filter((m) => m.to === to && m.kind === kind);
const refundOf = (packageId: string) => h.db.prisma.refund.findUnique({ where: { sellerOrderId: packageId } });
const stockOf = async (sku: string) => (await h.db.prisma.productVariant.findFirstOrThrow({ where: { sku }, select: { stock: true } })).stock;
const ownerEmail = async (slug: string) => (await h.db.prisma.store.findUniqueOrThrow({ where: { slug }, select: { owner: { select: { email: true } } } })).owner.email;

describe("the seller's Cancel order", () => {
  it("cancels with a reason: stock back, the items and delivery fee refunded through PayMongo, the buyer told why; again changes nothing", async () => {
    const { seller, product, sku, mine } = await sellerWithProduct(50_000); // ₱500 + ₱49 delivery
    const maria = await shop.shopper();
    const o = await paidOrder(maria, [[sku, 1]]);
    const id = mine(o);
    expect(await stockOf(sku)).toBe(39);

    for (const body of [{}, { reason: "CHANGED_MY_MIND" }, { reason: "BUYER_CANCELLED" }, { reason: "OUT_OF_STOCK", note: "x" }]) {
      expect((await seller.browser.post(`/api/v1/seller/orders/${id}/cancel`, body)).status, JSON.stringify(body)).toBe(400);
    }
    const stranger = await sell.seller({ approve: true });
    expect((await cancel(stranger.browser, id, "BUYER_ASKED")).status).toBe(404); // another store's package
    expect((await h.db.prisma.sellerOrder.findUniqueOrThrow({ where: { id } })).status).toBe("PREPARING");
    const res = await cancel(seller.browser, id, "BUYER_ASKED");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.order).toMatchObject({
      status: "CANCELLED",
      canCancel: false,
      canShip: false,
      autoCancelAt: null,
      cancellation: { by: "seller", reason: "BUYER_ASKED", message: "You cancelled it · the buyer asked to cancel" },
      earnings: { status: "cancelled" },
      next: null
    });
    expect(await stockOf(sku)).toBe(40);
    expect((await h.db.prisma.product.findUniqueOrThrow({ where: { id: product.id } })).soldCount).toBe(0);

    // The refund: the package's items and its delivery fee, sent through PayMongo with our id.
    const refund = await refundOf(id);
    expect(refund).toMatchObject({ amountCentavos: 54_900, reason: "PACKAGE_CANCELLED", status: "SENT", attempts: 1 });
    expect(h.paymongo.refunds.filter((r) => r.metadata.vendoraRefundId === refund?.id)).toEqual([
      expect.objectContaining({ amountCentavos: 54_900, reason: "others", id: refund?.providerRefundId })
    ]);
    const view = await order(maria.browser, o.id);
    expect(view).toMatchObject({ status: "CANCELLED", payment: { status: "REFUNDED" }, canCancel: false });
    expect(view.packages[0]).toMatchObject({
      status: "CANCELLED",
      cancellation: { by: "seller", reason: "BUYER_ASKED", message: "Cancelled by the seller · you asked to cancel" },
      refund: { amountCentavos: 54_900, status: "sent" }
    });
    expect(view.packages[0]?.events.slice(0, 2).map((e) => [e.type, e.message])).toEqual([
      ["refund", "Refund of ₱549 sent to your GCash"],
      ["cancelled", "Cancelled by the seller · you asked to cancel"]
    ]);
    const [told] = mail(maria.user.email, "package-cancelled");
    expect(told?.text).toContain("because you asked the seller to cancel it");
    expect(told?.text).toContain("We're refunding ₱549 (the items and their delivery fee) to your GCash");
    expect(mail(maria.user.email, "refund-sent")).toHaveLength(1);
    expect(mail(seller.user.email, "seller-order-cancelled")).toHaveLength(0); // their own doing
    expect(await h.db.prisma.ledgerEntry.count({ where: { sellerOrderId: id } })).toBe(0); // never earned

    expect((await cancel(seller.browser, id, "OUT_OF_STOCK")).status).toBe(200);
    expect(await h.db.prisma.refund.count({ where: { sellerOrderId: id } })).toBe(1);
    expect(await stockOf(sku)).toBe(40);
  });

  it('"out of stock" sets the stock to 0; in a two-store order only this package is refunded and the order goes on', async () => {
    const { seller, sku, mine } = await sellerWithProduct(150_000); // free delivery from ₱999
    const s = await shop.shopper();
    const o = await paidOrder(s, [[sku, 2], ["SC-POCKET-BLK", 1]], "CARD");
    expect((await cancel(seller.browser, mine(o), "OUT_OF_STOCK")).status).toBe(200);
    expect(await stockOf(sku)).toBe(0);
    expect(await refundOf(mine(o))).toMatchObject({ amountCentavos: 300_000, status: "SENT" });
    let view = await order(s.browser, o.id);
    expect(view).toMatchObject({ status: "PLACED", payment: { status: "PAID" } }); // partly refunded
    expect((await pkgOf(s.browser, o.id, mine(o))).cancellation?.message).toBe("Cancelled by the seller · out of stock");

    const other = o.packages.find((p) => p.id !== mine(o))?.id ?? "";
    await shop.ship(other);
    await h.delivery().deliver(other, new Date(), "BUYER");
    view = await order(s.browser, o.id);
    expect(view.status).toBe("COMPLETED");
  });

  it("cash on delivery: nothing to refund, the courier collects less; with every package cancelled, nothing to collect", async () => {
    const { seller, sku, mine } = await sellerWithProduct(50_000);
    const s = await shop.shopper();
    const two = (await shop.order(s, [[sku, 1], ["NW-TINY-PNK", 1]])) as Order;
    const before = await h.db.prisma.payment.findFirstOrThrow({ where: { orderId: two.id } });
    expect((await cancel(seller.browser, mine(two), "CANNOT_SHIP_TO_ADDRESS")).status).toBe(200);
    expect(await refundOf(mine(two))).toBeNull();
    expect((await h.db.prisma.payment.findFirstOrThrow({ where: { orderId: two.id } })).amountCentavos).toBe(before.amountCentavos - 54_900);
    expect(mail(s.user.email, "package-cancelled").at(-1)?.text).toContain("there's nothing to pay for these items");
    await shop.deliver(two.id);
    expect(await h.db.prisma.payment.findFirstOrThrow({ where: { orderId: two.id } })).toMatchObject({ status: "PAID", amountCentavos: before.amountCentavos - 54_900 });

    const one = (await shop.order(s, [[sku, 1]])) as Order;
    expect((await cancel(seller.browser, mine(one), "OUT_OF_STOCK")).status).toBe(200);
    expect((await order(s.browser, one.id)).status).toBe("CANCELLED");
    expect((await h.db.prisma.payment.findFirstOrThrow({ where: { orderId: one.id } })).status).toBe("EXPIRED");
  });

  it("can't cancel what has shipped; a cancel and a Mark as shipped at the same moment: exactly one wins", async () => {
    const { seller, sku, mine } = await sellerWithProduct();
    const a = await paidOrder(await shop.shopper(), [[sku, 1]]);
    expect((await seller.browser.put(`/api/v1/seller/orders/${mine(a)}/shipment`, { courier: "LBC", trackingNumber: `LBC${Date.now()}` })).status).toBe(200);
    const late = await cancel(seller.browser, mine(a), "OUT_OF_STOCK");
    expect([late.status, late.body.error?.details?.reason]).toEqual([409, "already_shipped"]);

    const b = await paidOrder(await shop.shopper(), [[sku, 1]]);
    const [shipped, cancelled] = await Promise.all([
      seller.browser.put(`/api/v1/seller/orders/${mine(b)}/shipment`, { courier: "LBC", trackingNumber: `LBC${Date.now()}1` }),
      cancel(seller.browser, mine(b), "OUT_OF_STOCK")
    ]);
    expect([shipped.status, cancelled.status].sort()).toEqual([200, 409]);
    const final = await h.db.prisma.sellerOrder.findUniqueOrThrow({ where: { id: mine(b) } });
    expect(await refundOf(mine(b))).toEqual(final.status === "CANCELLED" ? expect.objectContaining({ status: "SENT" }) : null);
  });
});

describe("the buyer's Cancel order (within an hour of paying)", () => {
  it("cancels and refunds every package not shipped yet; one that shipped stays on its way; the seller is told", async () => {
    const s = await shop.shopper();
    const o = await paidOrder(s, [["SC-POCKET-MNT", 1], ["GL-TONER-150", 1]]);
    let view = await order(s.browser, o.id);
    expect(view.canCancel).toBe(true);
    expect(view.cancelUntil).toBe(new Date(Date.parse(view.placedAt) + HOUR).toISOString());
    const [shippedPkg, openPkg] = o.packages;
    await shop.ship(shippedPkg?.id ?? "");

    const res = await s.browser.post(`/api/v1/orders/${o.id}/cancel`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    view = res.body.order;
    expect(view).toMatchObject({ status: "PLACED", canCancel: false, cancelUntil: null });
    expect(view.packages.find((p) => p.id === shippedPkg?.id)?.status).toBe("SHIPPED");
    expect(view.packages.find((p) => p.id === openPkg?.id)).toMatchObject({ status: "CANCELLED", cancellation: { by: "buyer", message: "You cancelled this order" }, refund: { status: "sent" } });
    const refund = await refundOf(openPkg?.id ?? "");
    expect(h.paymongo.refunds.find((r) => r.metadata.vendoraRefundId === refund?.id)?.reason).toBe("requested_by_customer");
    expect(mail(await ownerEmail(openPkg?.store.slug ?? ""), "seller-order-cancelled").at(-1)?.text).toContain("The buyer cancelled order");

    const again = await s.browser.post(`/api/v1/orders/${o.id}/cancel`);
    expect([again.status, again.body.error?.details?.reason]).toEqual([409, "already_shipped"]);
  });

  it("is refused after the hour; cash on delivery can be cancelled too (nothing to refund); not someone else's", async () => {
    const s = await shop.shopper();
    const o = await paidOrder(s, [["NW-TINY-BLU", 1]]);
    h.clock.offsetMs = HOUR + MINUTE;
    expect((await order(s.browser, o.id)).canCancel).toBe(false);
    const late = await s.browser.post(`/api/v1/orders/${o.id}/cancel`);
    expect([late.status, late.body.error?.details?.reason]).toEqual([409, "cancel_window_over"]);
    h.clock.offsetMs = 0;

    const cod = (await shop.order(s, [["NW-TINY-BLU", 1]])) as Order;
    expect((await shop.shopper("Jose Rizal").then((other) => other.browser.post(`/api/v1/orders/${cod.id}/cancel`))).status).toBe(404);
    const res = await s.browser.post(`/api/v1/orders/${cod.id}/cancel`);
    expect(res.body.order).toMatchObject({ status: "CANCELLED", packages: [{ status: "CANCELLED", refund: null }] });
    expect((await h.db.prisma.payment.findFirstOrThrow({ where: { orderId: cod.id } })).status).toBe("EXPIRED");
  });
});

describe("the automatic cancel", () => {
  it("warns the seller when late and the day before (once each), then cancels 3 days after ship-by and refunds", async () => {
    const s = await shop.shopper();
    const o = await paidOrder(s, [["SC-BOOM-MINI-CRL", 1]]);
    const p = o.packages[0]?.id ?? "";
    const owner = await ownerEmail("soundcraft-audio");
    const shipBy = new Date(Date.now() - HOUR);
    await h.db.prisma.sellerOrder.update({ where: { id: p }, data: { shipBy } });
    const lateBefore = mail(owner, "seller-order-late").length;

    await h.cancellation().runDue();
    await h.cancellation().runDue();
    const late = mail(owner, "seller-order-late");
    expect(late).toHaveLength(lateBefore + 1);
    expect(late.at(-1)?.subject).toBe(`${o.number} is late: please ship it today`);

    h.clock.offsetMs = 2 * DAY; // ship-by + 2 days: the day before
    const warnBefore = mail(owner, "seller-order-cancel-warning").length;
    await h.cancellation().runDue();
    await h.cancellation().runDue();
    expect(mail(owner, "seller-order-cancel-warning")).toHaveLength(warnBefore + 1);
    expect((await h.db.prisma.sellerOrder.findUniqueOrThrow({ where: { id: p } })).status).toBe("PREPARING");

    h.clock.offsetMs = 3 * DAY;
    expect((await h.cancellation().runDue()).cancelled).toBeGreaterThanOrEqual(1);
    const pkg = await pkgOf(s.browser, o.id, p);
    expect(pkg).toMatchObject({ status: "CANCELLED", cancellation: { by: "system", reason: "NOT_SHIPPED_IN_TIME", message: "Cancelled automatically · the seller didn't ship in time" }, refund: { status: "sent" } });
    expect(mail(s.user.email, "package-cancelled").at(-1)?.text).toContain("because the seller didn't ship it in time");
    expect(mail(owner, "seller-order-cancelled").at(-1)?.text).toContain("cancelled automatically");
  });
});

describe("refunds", () => {
  it("a refund PayMongo refuses is tried again every hour; after 3 days it's marked for a manual refund and the buyer told", async () => {
    const { seller, sku, mine } = await sellerWithProduct();
    const s = await shop.shopper();
    const a = await paidOrder(s, [[sku, 1]]);
    h.paymongo.refundRefusal = new PayMongoError(400, "available_balance_insufficient", "Insufficient balance");
    const res = await cancel(seller.browser, mine(a), "BUYER_ASKED");
    expect(res.status, JSON.stringify(res.body)).toBe(200); // the cancel itself still works
    expect(await refundOf(mine(a))).toMatchObject({ status: "PENDING", attempts: 1, lastError: "Insufficient balance" });
    expect((await pkgOf(s.browser, a.id, mine(a))).refund).toMatchObject({ status: "processing", sentAt: null });

    expect(await h.refunds().sendDue()).toBe(0); // not due yet: an hour later
    expect((await refundOf(mine(a)))?.attempts).toBe(1);
    h.clock.offsetMs = HOUR + MINUTE;
    await h.refunds().sendDue();
    expect(await refundOf(mine(a))).toMatchObject({ status: "PENDING", attempts: 2 });

    h.paymongo.refundRefusal = null; // the balance came in
    h.clock.offsetMs = 2 * HOUR + 2 * MINUTE;
    expect(await h.refunds().sendDue()).toBeGreaterThanOrEqual(1);
    expect(await refundOf(mine(a))).toMatchObject({ status: "SENT", attempts: 3, lastError: null });
    expect(mail(s.user.email, "refund-sent")).toHaveLength(1);

    // Another that never goes through: 3 days later it's FAILED, "needs a manual refund".
    h.clock.offsetMs = 0;
    const b = await paidOrder(s, [[sku, 1]]);
    h.paymongo.refundRefusal = new PayMongoError(400, "available_balance_insufficient", "Insufficient balance");
    await cancel(seller.browser, mine(b), "BUYER_ASKED");
    h.clock.offsetMs = 3 * DAY + HOUR;
    await h.refunds().sendDue();
    expect(await refundOf(mine(b))).toMatchObject({ status: "FAILED", attempts: 2, nextAttemptAt: null });
    expect((await pkgOf(s.browser, b.id, mine(b))).refund?.status).toBe("delayed");
    expect(mail(s.user.email, "refund-delayed")).toHaveLength(1);
    h.clock.offsetMs = 4 * DAY;
    await h.refunds().sendDue();
    expect((await refundOf(mine(b)))?.attempts).toBe(2); // given up: no more tries
    // The one that was sent days ago is left alone: still one refund at PayMongo, one email.
    const sentOne = await refundOf(mine(a));
    expect(sentOne).toMatchObject({ status: "SENT", attempts: 3 });
    expect(h.paymongo.refunds.filter((r) => r.metadata.vendoraRefundId === sentOne?.id)).toHaveLength(1);
    expect(mail(s.user.email, "refund-sent")).toHaveLength(1);
  });

  it("is never sent twice: a retry finds a refund whose answer was lost, and two runs at once send it once", async () => {
    const { seller, sku, mine } = await sellerWithProduct();
    const s = await shop.shopper();
    const a = await paidOrder(s, [[sku, 1]]);
    h.paymongo.loseRefundAnswer = true; // PayMongo did it, but we never heard back
    await cancel(seller.browser, mine(a), "OUT_OF_STOCK");
    const lost = await refundOf(mine(a));
    expect(lost).toMatchObject({ status: "PENDING", attempts: 1 });
    h.paymongo.loseRefundAnswer = false;
    h.clock.offsetMs = HOUR + MINUTE;
    await Promise.all([h.refunds().sendDue(), h.refunds().sendDue()]);
    const atPayMongo = h.paymongo.refunds.filter((r) => r.metadata.vendoraRefundId === lost?.id);
    expect(atPayMongo).toHaveLength(1);
    expect(await refundOf(mine(a))).toMatchObject({ status: "SENT", providerRefundId: atPayMongo[0]?.id });
    expect(mail(s.user.email, "refund-sent")).toHaveLength(1);
  });

  it("never refunds more than was paid (checked with the payment row locked)", async () => {
    const s = await shop.shopper();
    const o = await paidOrder(s, [["NW-TINY-PNK", 1]]);
    const payment = await h.db.prisma.payment.findFirstOrThrow({ where: { orderId: o.id, status: "PAID" } });
    const record = (amountCentavos: number) => h.db.prisma.$transaction((tx) => recordRefund(tx, { paymentId: payment.id, amountCentavos, reason: "DUPLICATE_PAYMENT" }, new Date()));
    await record(payment.amountCentavos - 100);
    await expect(record(101)).rejects.toThrow(/more than was paid/);
    await record(100);
    expect(await h.db.prisma.refund.count({ where: { paymentId: payment.id } })).toBe(2);
  });

  it("one package cancelled and another delivered at the same moment: the order closes once, as completed", async () => {
    const s = await shop.shopper();
    const o = await paidOrder(s, [["SC-POCKET-LIL", 1], ["GL-TONER-150", 1]]);
    const [a, b] = o.packages;
    await shop.ship(b?.id ?? "");
    const [cancelled, delivered] = await Promise.all([h.cancellation().cancelPackage(a?.id ?? "", "SELLER", "OUT_OF_STOCK"), h.delivery().deliver(b?.id ?? "", new Date(), "BUYER")]);
    expect([cancelled, delivered]).toEqual([true, true]);
    expect((await h.db.prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("COMPLETED");
  });

  it("a second payment for an order the buyer already cancelled is refunded; the order never comes back", async () => {
    const s = await shop.shopper();
    const o = (await shop.order(s, [["PO-FLOW-SAGE", 1]], { method: "GCASH" })) as Order;
    const first = h.paymongo.latest(o.id);
    await s.browser.post(`/api/v1/orders/${o.id}/payment`, { paymentMethod: "CARD" });
    h.paymongo.pay(h.paymongo.latest(o.id).id);
    await s.browser.get(`/api/v1/orders/${o.id}`);
    expect((await s.browser.post(`/api/v1/orders/${o.id}/cancel`)).body.order.status).toBe("CANCELLED");
    const stock = await stockOf("PO-FLOW-SAGE");

    const late = h.paymongo.pay(first.id, { force: true }); // the first page got paid after all
    await h.orders().settle(first.id, late);
    expect((await order(s.browser, o.id)).status).toBe("CANCELLED");
    expect(await stockOf("PO-FLOW-SAGE")).toBe(stock);
    expect(await h.db.prisma.refund.findFirst({ where: { payment: { providerPaymentId: late.paymentId } } })).toMatchObject({ reason: "DUPLICATE_PAYMENT", status: "SENT" });
    expect(await h.db.prisma.payment.count({ where: { orderId: o.id, status: "REFUNDED" } })).toBe(2);
  });
});
