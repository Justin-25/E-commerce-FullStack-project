import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryKv } from "../../src/lib/kv.js";
import { DevOutbox } from "../../src/lib/email.js";
import { CartService } from "../../src/modules/cart/cart.service.js";
import { OrderService } from "../../src/modules/orders/orders.service.js";
import { CancellationService } from "../../src/modules/orders/cancellation.js";
import { RefundService } from "../../src/modules/orders/refunds.js";
import type { Browser } from "../support/browser.js";
import { createCatalogHarness, type CatalogHarness } from "../support/catalogHarness.js";
import { sign } from "../support/fakePaymongo.js";

let h: CatalogHarness;
beforeAll(async () => {
  h = await createCatalogHarness();
}, 120_000);
afterAll(() => h?.close());

type Order = {
  id: string;
  number: string;
  status: string;
  payment: { method: string; status: string; checkoutUrl: string | null; expiresAt: string | null; paidAt: string | null };
  packages: { store: { slug: string }; status: string; deliveryOption: string; deliveryCentavos: number; subtotalCentavos: number; items: { variantId: string; quantity: number; unitPriceCentavos: number; title: string }[] }[];
  itemCount: number;
  totals: { subtotalCentavos: number; deliveryCentavos: number; totalCentavos: number };
  address: { fullName: string; phone: string; city: string };
};
type Summary = {
  packages: { store: { slug: string }; subtotalCentavos: number; delivery: { option: string; feeCentavos: number; options: { option: string; feeCentavos: number }[] } }[];
  address: { id: string } | null;
  paymentMethods: { method: string; available: boolean; reason: string | null }[];
  totals: { subtotalCentavos: number; deliveryCentavos: number; totalCentavos: number };
  canPlaceOrder: boolean;
  blockers: string[];
};

const HOME = { label: "Home", fullName: "Maria Santos", phone: "0917 123 4567", region: "NCR", city: "Manila", barangay: "Ermita", street: "1350 Taft Avenue", postalCode: "1000" };
let emails = 0;
const sku = async (s: string) => (await h.db.prisma.productVariant.findFirstOrThrow({ where: { sku: s }, select: { id: true } })).id;
const stockOf = async (s: string) => (await h.db.prisma.productVariant.findFirstOrThrow({ where: { sku: s }, select: { stock: true } })).stock;
const setStock = (s: string, stock: number) => h.db.prisma.productVariant.updateMany({ where: { sku: s }, data: { stock } });

/** A signed-in shopper with an address and these items in the cart. */
async function shopperWith(items: [sku: string, quantity: number][]) {
  const s = await h.signUp({ email: `buyer${++emails}@example.com` });
  const addressId = (await s.browser.post("/api/v1/addresses", HOME)).body.address.id as string;
  for (const [code, quantity] of items) expect((await s.browser.post("/api/v1/cart/items", { variantId: await sku(code), quantity })).status).toBe(200);
  return { ...s, addressId };
}
const summary = async (b: Browser, body: object = {}) => (await b.post("/api/v1/checkout/summary", body)).body as Summary;
/** "Place order" with an Idempotency-Key, the total the shopper saw, and their choices. */
async function place(b: Browser, addressId: string, paymentMethod: string, opts: { key?: string; delivery?: Record<string, string>; expected?: number } = {}) {
  const expected = opts.expected ?? (await summary(b, { addressId, delivery: opts.delivery ?? {} })).totals.totalCentavos;
  return b.agent
    .post("/api/v1/orders")
    .set("X-CSRF-Token", b.csrfToken)
    .set("Idempotency-Key", opts.key ?? randomUUID())
    .send({ addressId, delivery: opts.delivery ?? {}, paymentMethod, expectedTotalCentavos: expected });
}
const getOrder = async (b: Browser, id: string) => (await b.get(`/api/v1/orders/${id}`)).body.order as Order;
/** Deliver a signed PayMongo webhook to the app, like PayMongo would (no cookies, no CSRF token). */
const deliver = (w: { body: string; signature: string }) => request(h.app).post("/api/v1/webhooks/paymongo").set("content-type", "application/json").set("Paymongo-Signature", w.signature).send(w.body);
const expireNow = (orderId: string) => h.db.prisma.order.update({ where: { id: orderId }, data: { expiresAt: new Date(Date.now() - 1000) } });

describe("Checkout summary", () => {
  it("shows each store's package with Standard and Express, the address, the payment methods and the totals", async () => {
    const s = await shopperWith([["SC-AURA-PRO-BLK", 1], ["GL-TONER-150", 1]]); // ₱7,499 + ₱599
    const standard = await summary(s.browser);
    expect(standard.address?.id).toBe(s.addressId);
    expect(standard.canPlaceOrder).toBe(true);
    const glow = standard.packages.find((p) => p.store.slug === "glow-lab");
    expect(glow?.delivery).toMatchObject({ option: "STANDARD", feeCentavos: 4_900, options: [{ option: "STANDARD", feeCentavos: 4_900 }, { option: "EXPRESS", feeCentavos: 12_900 }] });
    expect(standard.totals).toEqual({ subtotalCentavos: 809_800, deliveryCentavos: 4_900, discountCentavos: 0, totalCentavos: 814_700, savingsCentavos: 250_000 });

    const express = await summary(s.browser, { delivery: { "soundcraft-audio": "EXPRESS" } });
    expect(express.totals.deliveryCentavos).toBe(4_900 + 12_900);
    // Over ₱5,000: no cash on delivery, as designed.
    expect(express.paymentMethods).toEqual([
      { method: "GCASH", available: true, reason: null },
      { method: "MAYA", available: true, reason: null },
      { method: "CARD", available: true, reason: null },
      { method: "COD", available: false, reason: "Not available for orders over ₱5,000" }
    ]);
  });

  it("says what's missing before an order can be placed", async () => {
    const s = await h.signUp({ email: `buyer${++emails}@example.com` });
    expect((await summary(s.browser)).blockers).toEqual(["cart_empty", "no_address"]);
    await s.browser.post("/api/v1/cart/items", { variantId: await sku("GL-TONER-150") });
    await setStock("GL-TONER-150", 0);
    try {
      expect((await summary(s.browser)).blockers).toEqual(["cart_issues", "no_address"]);
    } finally {
      await setStock("GL-TONER-150", 120);
    }
    expect((await request(h.app).post("/api/v1/checkout/summary").send({})).status).toBe(403); // no CSRF token, not signed in
  });
});

describe("Place order (online payment)", () => {
  it("reserves the stock, copies the order details, and sends the shopper to PayMongo", async () => {
    const s = await shopperWith([["SC-BOOM-MINI-CRL", 2], ["GL-TONER-150", 1]]);
    const before = await stockOf("SC-BOOM-MINI-CRL");
    const res = await place(s.browser, s.addressId, "GCASH");
    expect(res.status).toBe(201);
    const order = res.body.order as Order;
    expect(order).toMatchObject({ status: "PENDING_PAYMENT", payment: { method: "GCASH", status: "AWAITING_ACTION" }, itemCount: 3 });
    expect(order.number).toMatch(/^VD-\d+$/);
    expect(order.address).toMatchObject({ fullName: "Maria Santos", phone: "+639171234567", city: "Manila" });
    expect(order.packages.map((p) => [p.store.slug, p.status])).toEqual([["glow-lab", "AWAITING_PAYMENT"], ["soundcraft-audio", "AWAITING_PAYMENT"]].sort());
    expect(Date.parse(order.payment.expiresAt ?? "") - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(await stockOf("SC-BOOM-MINI-CRL")).toBe(before - 2);

    const session = h.paymongo.latest(order.id);
    expect(res.body.nextAction).toEqual({ type: "redirect", url: `https://checkout.paymongo.test/${session.id}` });
    expect(session.request).toMatchObject({ method: "GCASH", referenceNumber: order.number, billing: { email: s.user.email } });
    // What PayMongo charges adds up to exactly the order total, delivery included.
    expect(session.request.lineItems.reduce((sum, l) => sum + l.amountCentavos * l.quantity, 0)).toBe(order.totals.totalCentavos);
    expect(session.request.lineItems.some((l) => /delivery · Glow Lab/.test(l.name))).toBe(true);
    // The cart stays until payment succeeds.
    expect((await s.browser.get("/api/v1/cart")).body.cart.summary.itemCount).toBe(3);
  });

  it("gives one order for one Idempotency-Key, even for simultaneous clicks", async () => {
    const s = await shopperWith([["GL-VITC-30", 1]]);
    const key = randomUUID();
    const before = await stockOf("GL-VITC-30");
    const results = await Promise.all([1, 2, 3].map(() => place(s.browser, s.addressId, "CARD", { key })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(new Set(results.map((r) => r.body.order.id)).size).toBe(1);
    expect(await h.db.prisma.order.count({ where: { userId: s.user.id } })).toBe(1);
    expect(await stockOf("GL-VITC-30")).toBe(before - 1);
    expect((await place(s.browser, s.addressId, "CARD", { key })).body.nextAction.url).toBe(results[0]?.body.nextAction.url);
  });

  it("places nothing when the total changed since the shopper looked", async () => {
    const s = await shopperWith([["GL-VITC-30", 1]]);
    const real = (await summary(s.browser, { addressId: s.addressId })).totals.totalCentavos;
    const before = await stockOf("GL-VITC-30");
    const res = await place(s.browser, s.addressId, "GCASH", { expected: real - 100 });
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ reason: "total_changed", totalCentavos: real });
    expect(await h.db.prisma.order.count({ where: { userId: s.user.id } })).toBe(0);
    expect(await stockOf("GL-VITC-30")).toBe(before);
  });

  it("checks the request: key, address, method, ownership", async () => {
    const s = await shopperWith([["GL-TONER-150", 1]]);
    const other = await shopperWith([]);
    const noKey = await s.browser.agent.post("/api/v1/orders").set("X-CSRF-Token", s.browser.csrfToken).send({ addressId: s.addressId, paymentMethod: "GCASH", expectedTotalCentavos: 1 });
    expect(noKey.status).toBe(400);
    expect((await place(s.browser, other.addressId, "GCASH", { expected: 64_800 })).status).toBe(404); // someone else's address
    expect((await place(s.browser, s.addressId, "BITCOIN", { expected: 64_800 })).status).toBe(400);
    expect((await place(other.browser, other.addressId, "GCASH", { expected: 0 })).body.error.details).toEqual({ reason: "cart_empty" });
  });

  it("lets only one of two shoppers buy the last unit", async () => {
    await setStock("SC-AURA-PRO-SND", 1);
    try {
      const a = await shopperWith([["SC-AURA-PRO-SND", 1]]);
      const b = await shopperWith([["SC-AURA-PRO-SND", 1]]);
      const [ta, tb] = await Promise.all([summary(a.browser), summary(b.browser)]);
      const results = await Promise.all([
        place(a.browser, a.addressId, "GCASH", { expected: ta.totals.totalCentavos }),
        place(b.browser, b.addressId, "GCASH", { expected: tb.totals.totalCentavos })
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await stockOf("SC-AURA-PRO-SND")).toBe(0);
    } finally {
      await setStock("SC-AURA-PRO-SND", 9);
    }
  });

  it("undoes the order when PayMongo can't be reached: nothing charged, stock back, cart kept", async () => {
    const s = await shopperWith([["GL-NIA-30", 2]]);
    const before = await stockOf("GL-NIA-30");
    h.paymongo.down = true;
    try {
      const res = await place(s.browser, s.addressId, "MAYA");
      expect(res.status).toBe(503);
    } finally {
      h.paymongo.down = false;
    }
    expect(await stockOf("GL-NIA-30")).toBe(before);
    expect((await h.db.prisma.order.findFirstOrThrow({ where: { userId: s.user.id } })).status).toBe("CANCELLED");
    expect((await s.browser.get("/api/v1/cart")).body.cart.summary.itemCount).toBe(2);
  });
});

describe("Confirming a payment", () => {
  it("on the shopper's return: the order is placed, the bought items leave the cart, sold counts go up, an email goes out", async () => {
    const s = await shopperWith([["GL-SPF50-50", 2]]);
    await s.browser.post("/api/v1/cart/items", { variantId: await sku("GL-CALAMANSI-20") }); // stays in the cart? no: it's bought too
    const productId = (await h.db.prisma.productVariant.findFirstOrThrow({ where: { sku: "GL-SPF50-50" }, select: { productId: true } })).productId;
    const sold = (await h.db.prisma.product.findUniqueOrThrow({ where: { id: productId } })).soldCount;
    const order = (await place(s.browser, s.addressId, "GCASH")).body.order as Order;

    h.paymongo.pay(h.paymongo.latest(order.id).id);
    const after = await getOrder(s.browser, order.id);
    expect(after).toMatchObject({ status: "PLACED", payment: { status: "PAID", checkoutUrl: null, expiresAt: null } });
    expect(after.packages.every((p) => p.status === "PREPARING")).toBe(true);
    expect((await s.browser.get("/api/v1/cart")).body.cart.groups).toEqual([]);
    expect((await h.db.prisma.product.findUniqueOrThrow({ where: { id: productId } })).soldCount).toBe(sold + 2);
    const mail = h.outbox.lastTo(s.user.email);
    expect(mail?.subject).toBe(`Your Vendora order ${order.number} is confirmed`);
  });

  it("by webhook, in both payload shapes; a repeated webhook changes nothing", async () => {
    for (const shape of ["classic", "docs"] as const) {
      const s = await shopperWith([["PO-HYDRA-750-NVY", 1]]);
      const order = (await place(s.browser, s.addressId, "CARD")).body.order as Order;
      const session = h.paymongo.latest(order.id);
      h.paymongo.pay(session.id);
      const hook = h.paymongo.webhook(session.id, { shape });
      const first = await deliver(hook);
      expect(first.status, shape).toBe(200);
      expect(first.body).toEqual({ received: true, result: "processed" });
      expect((await getOrder(s.browser, order.id)).status).toBe("PLACED");
      expect((await deliver(hook)).body.result).toBe("duplicate");
      expect(await h.db.prisma.payment.count({ where: { orderId: order.id, status: "PAID" } })).toBe(1);
    }
  });

  it("refuses webhooks with a bad, old or missing signature, or a changed body", async () => {
    const s = await shopperWith([["PO-HYDRA-750-SAGE", 1]]);
    const order = (await place(s.browser, s.addressId, "GCASH")).body.order as Order;
    const session = h.paymongo.latest(order.id);
    h.paymongo.pay(session.id);
    const good = h.paymongo.webhook(session.id);
    expect((await deliver({ ...good, signature: sign(good.body, "whsk_wrongsecret123456", Math.floor(Date.now() / 1000)) })).status).toBe(401);
    expect((await deliver(h.paymongo.webhook(session.id, { ageSeconds: 600 }))).status).toBe(401);
    expect((await deliver({ body: good.body.replace(/"amount":\d+/, '"amount":1'), signature: good.signature })).status).toBe(401);
    expect((await request(h.app).post("/api/v1/webhooks/paymongo").set("content-type", "application/json").send(good.body)).status).toBe(401);
    // Read the database directly: opening the order page would itself ask PayMongo and find the payment.
    expect((await h.db.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PENDING_PAYMENT");
    expect((await deliver(good)).body.result).toBe("processed");

    const noSecret = h.buildApp({ PAYMONGO_WEBHOOK_SECRET: "" });
    expect((await request(noSecret).post("/api/v1/webhooks/paymongo").set("Paymongo-Signature", good.signature).send(good.body)).status).toBe(503);
  });

  it("doesn't accept a payment for the wrong amount", async () => {
    const s = await shopperWith([["PO-TUMBLER-BLK", 1]]);
    const order = (await place(s.browser, s.addressId, "GCASH")).body.order as Order;
    const session = h.paymongo.latest(order.id);
    h.paymongo.pay(session.id, { amountCentavos: 100 });
    await deliver(h.paymongo.webhook(session.id));
    expect((await getOrder(s.browser, order.id)).status).toBe("PENDING_PAYMENT");
    expect((await h.db.prisma.payment.findFirstOrThrow({ where: { orderId: order.id } })).failureReason).toMatch(/Amount mismatch/);
  });

  it("counts a payment once when the webhook and the shopper's return arrive together", async () => {
    const s = await shopperWith([["PO-KIDSBTL-DINO", 3]]);
    const productId = (await h.db.prisma.productVariant.findFirstOrThrow({ where: { sku: "PO-KIDSBTL-DINO" }, select: { productId: true } })).productId;
    const sold = (await h.db.prisma.product.findUniqueOrThrow({ where: { id: productId } })).soldCount;
    const order = (await place(s.browser, s.addressId, "GCASH")).body.order as Order;
    const session = h.paymongo.latest(order.id);
    const paid = h.paymongo.pay(session.id);
    await Promise.all([deliver(h.paymongo.webhook(session.id)), deliver(h.paymongo.webhook(session.id)), getOrder(s.browser, order.id)]);
    expect(h.paymongo.refunds.filter((r) => r.paymentId === paid.paymentId)).toEqual([]); // reported 3 times, never "refunded as a duplicate"
    expect((await h.db.prisma.product.findUniqueOrThrow({ where: { id: productId } })).soldCount).toBe(sold + 3);
    expect(h.outbox.sent.filter((m) => m.to === s.user.email && m.kind === "order-confirmed")).toHaveLength(1);
  });
});

describe("Failed payments and the 15-minute window", () => {
  it("lets the shopper try again with another method; the old PayMongo page is stopped", async () => {
    const s = await shopperWith([["PO-PILATES-LAV", 1]]);
    const order = (await place(s.browser, s.addressId, "GCASH")).body.order as Order;
    const first = h.paymongo.latest(order.id);
    const retry = await s.browser.post(`/api/v1/orders/${order.id}/payment`, { paymentMethod: "CARD" });
    expect(retry.status).toBe(200);
    const second = h.paymongo.latest(order.id);
    expect(second.id).not.toBe(first.id);
    expect(first.status).toBe("expired");
    expect(retry.body.nextAction.url).toContain(second.id);
    expect(retry.body.order.payment).toMatchObject({ method: "CARD", status: "AWAITING_ACTION" });
  });

  it("can switch to cash on delivery when eligible: the order is placed right away", async () => {
    const s = await shopperWith([["PO-PILATES-GRY", 1]]); // ₱999
    const order = (await place(s.browser, s.addressId, "MAYA")).body.order as Order;
    const res = await s.browser.post(`/api/v1/orders/${order.id}/payment`, { paymentMethod: "COD" });
    expect(res.body.order).toMatchObject({ status: "PLACED", payment: { method: "COD", status: "PENDING" } });
    expect(h.paymongo.latest(order.id).status).toBe("expired");
    expect(res.body.nextAction).toBeNull();
  });

  it("won't start a new attempt while PayMongo is still processing one", async () => {
    const s = await shopperWith([["PO-TRAVELMAT-SND", 1]]);
    const order = (await place(s.browser, s.addressId, "CARD")).body.order as Order;
    h.paymongo.latest(order.id).busy = true;
    const res = await s.browser.post(`/api/v1/orders/${order.id}/payment`, { paymentMethod: "GCASH" });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("payment_in_progress");
  });

  it("cancels unpaid orders after 15 minutes and returns the stock; the cart is still there", async () => {
    const s = await shopperWith([["GL-RETINOL-30", 2]]);
    const before = await stockOf("GL-RETINOL-30");
    const order = (await place(s.browser, s.addressId, "GCASH")).body.order as Order;
    expect(await stockOf("GL-RETINOL-30")).toBe(before - 2);
    await expireNow(order.id);
    expect(await h.orders().expireDue()).toBeGreaterThanOrEqual(1);
    const after = await getOrder(s.browser, order.id);
    expect(after).toMatchObject({ status: "CANCELLED", payment: { status: "EXPIRED", checkoutUrl: null } });
    expect(after.packages.every((p) => p.status === "CANCELLED")).toBe(true);
    expect(await stockOf("GL-RETINOL-30")).toBe(before);
    expect(h.paymongo.latest(order.id).status).toBe("expired");
    expect((await s.browser.get("/api/v1/cart")).body.cart.summary.itemCount).toBe(2);
    expect((await s.browser.post(`/api/v1/orders/${order.id}/payment`, { paymentMethod: "CARD" })).body.error.details.reason).toBe("order_closed");
  });

  it("waits a little longer while PayMongo is mid-payment, but never holds stock past 45 minutes", async () => {
    const s = await shopperWith([["GL-CALAMANSI-20", 1]]);
    const order = (await place(s.browser, s.addressId, "CARD")).body.order as Order;
    h.paymongo.latest(order.id).busy = true;
    await expireNow(order.id);
    await h.orders().expireDue();
    const extended = await h.db.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(extended.status).toBe("PENDING_PAYMENT");
    expect((extended.expiresAt?.getTime() ?? 0) - Date.now()).toBeGreaterThan(4 * 60_000);

    await h.db.prisma.order.update({ where: { id: order.id }, data: { createdAt: new Date(Date.now() - 50 * 60_000), expiresAt: new Date(Date.now() - 1000) } });
    await h.orders().expireDue();
    expect((await h.db.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("CANCELLED");
  });

  it("finds a payment that went through but wasn't reported, instead of cancelling", async () => {
    const s = await shopperWith([["GL-TONER-150", 1]]);
    const order = (await place(s.browser, s.addressId, "GCASH")).body.order as Order;
    h.paymongo.pay(h.paymongo.latest(order.id).id);
    await expireNow(order.id);
    await h.orders().expireDue();
    expect((await h.db.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PLACED");
  });

  it("revives an order paid after the window if everything is still in stock", async () => {
    const s = await shopperWith([["SC-BOOM-MAX-BLK", 1]]);
    const order = (await place(s.browser, s.addressId, "GCASH")).body.order as Order;
    const session = h.paymongo.latest(order.id);
    session.busy = true; // the shopper is mid-payment when the window closes
    await h.db.prisma.order.update({ where: { id: order.id }, data: { createdAt: new Date(Date.now() - 50 * 60_000), expiresAt: new Date(Date.now() - 1000) } });
    await h.orders().expireDue();
    const stockAfterCancel = await stockOf("SC-BOOM-MAX-BLK");
    expect((await h.db.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("CANCELLED");

    h.paymongo.pay(session.id);
    await deliver(h.paymongo.webhook(session.id));
    expect((await getOrder(s.browser, order.id)).status).toBe("PLACED");
    expect(await stockOf("SC-BOOM-MAX-BLK")).toBe(stockAfterCancel - 1);
    expect(h.paymongo.refunds.filter((r) => r.paymentId === session.paid?.paymentId)).toEqual([]);
  });

  it("refunds a late payment in full when the items sold out meanwhile, and tells the shopper", async () => {
    const s = await shopperWith([["SC-RAPTOR-71", 1]]);
    const order = (await place(s.browser, s.addressId, "CARD")).body.order as Order;
    const session = h.paymongo.latest(order.id);
    session.busy = true;
    await h.db.prisma.order.update({ where: { id: order.id }, data: { createdAt: new Date(Date.now() - 50 * 60_000), expiresAt: new Date(Date.now() - 1000) } });
    await h.orders().expireDue();
    const stock = await stockOf("SC-RAPTOR-71");
    await setStock("SC-RAPTOR-71", 0);
    try {
      const paid = h.paymongo.pay(session.id);
      await deliver(h.paymongo.webhook(session.id));
      expect((await getOrder(s.browser, order.id)).status).toBe("CANCELLED");
      expect(h.paymongo.refunds).toContainEqual(expect.objectContaining({ paymentId: paid.paymentId, amountCentavos: order.totals.totalCentavos, reason: "others" }));
      expect(await h.db.prisma.refund.findFirst({ where: { payment: { providerRef: session.id } } })).toMatchObject({ reason: "LATE_PAYMENT_SOLD_OUT", status: "SENT", attempts: 1 });
      expect((await h.db.prisma.payment.findFirstOrThrow({ where: { providerRef: session.id } })).status).toBe("REFUNDED");
      expect(h.outbox.lastTo(s.user.email)?.kind).toBe("payment-refunded");
    } finally {
      await setStock("SC-RAPTOR-71", stock);
    }
  });

  it("refunds a second payment for an order that's already paid", async () => {
    const s = await shopperWith([["PO-FLOW-SAGE", 1]]);
    const order = (await place(s.browser, s.addressId, "GCASH")).body.order as Order;
    const first = h.paymongo.latest(order.id);
    await s.browser.post(`/api/v1/orders/${order.id}/payment`, { paymentMethod: "CARD" });
    const second = h.paymongo.latest(order.id);
    h.paymongo.pay(second.id);
    await deliver(h.paymongo.webhook(second.id));
    expect((await getOrder(s.browser, order.id)).status).toBe("PLACED");
    // PayMongo race: the first page got paid just as we stopped it.
    const late = h.paymongo.pay(first.id, { force: true });
    await deliver(h.paymongo.webhook(first.id));
    expect(h.paymongo.refunds).toContainEqual(expect.objectContaining({ paymentId: late.paymentId, amountCentavos: order.totals.totalCentavos, reason: "duplicate" }));
    expect(await h.db.prisma.refund.findFirst({ where: { payment: { providerPaymentId: late.paymentId } } })).toMatchObject({ reason: "DUPLICATE_PAYMENT", status: "SENT" });
    expect(await h.db.prisma.payment.count({ where: { orderId: order.id, status: "PAID" } })).toBe(1);
  });

  it("lets the shopper cancel an unpaid order, which returns the stock", async () => {
    const s = await shopperWith([["NW-TINY-BLU", 2]]);
    const before = await stockOf("NW-TINY-BLU");
    const order = (await place(s.browser, s.addressId, "GCASH")).body.order as Order;
    const res = await s.browser.post(`/api/v1/orders/${order.id}/cancel`);
    expect(res.body.order.status).toBe("CANCELLED");
    expect(await stockOf("NW-TINY-BLU")).toBe(before);
    expect((await s.browser.post(`/api/v1/orders/${order.id}/cancel`)).body.error.details.reason).toBe("not_pending");
  });
});

describe("Cash on delivery", () => {
  it("places the order right away, up to ₱5,000", async () => {
    const s = await shopperWith([["NW-TINY-PNK", 2]]); // ₱1,798
    const res = await place(s.browser, s.addressId, "COD");
    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({ status: "PLACED", payment: { method: "COD", status: "PENDING" } });
    expect(res.body.nextAction).toBeNull();
    expect((res.body.order as Order).packages.every((p) => p.status === "PREPARING")).toBe(true);
    expect((await s.browser.get("/api/v1/cart")).body.cart.groups).toEqual([]);
    expect(h.outbox.lastTo(s.user.email)?.kind).toBe("order-confirmed");
  });

  it("refuses orders over ₱5,000, and a third open COD order", async () => {
    const big = await shopperWith([["SC-AURA-PRO-BLK", 1]]);
    expect((await place(big.browser, big.addressId, "COD")).body.error.details.reason).toBe("cod_over_limit");

    const s = await shopperWith([["GL-TONER-150", 1]]);
    for (let i = 0; i < 2; i++) {
      expect((await place(s.browser, s.addressId, "COD")).status).toBe(201);
      await s.browser.post("/api/v1/cart/items", { variantId: await sku("GL-TONER-150") });
    }
    expect((await summary(s.browser)).paymentMethods.find((m) => m.method === "COD")).toEqual({ method: "COD", available: false, reason: "You already have 2 cash-on-delivery orders on the way" });
    expect((await place(s.browser, s.addressId, "COD")).body.error.details.reason).toBe("cod_too_many");
  });
});

describe("Orders are private", () => {
  it("someone else's order answers 404", async () => {
    const a = await shopperWith([["GL-TONER-150", 1]]);
    const b = await shopperWith([]);
    const order = (await place(a.browser, a.addressId, "GCASH")).body.order as Order;
    expect((await b.browser.get(`/api/v1/orders/${order.id}`)).status).toBe(404);
    expect((await b.browser.post(`/api/v1/orders/${order.id}/payment`, { paymentMethod: "CARD" })).status).toBe(404);
    expect((await b.browser.post(`/api/v1/orders/${order.id}/cancel`)).status).toBe(404);
    expect((await a.browser.get(`/api/v1/orders/not-a-uuid`)).status).toBe(400);
  });
});

describe("Without a PayMongo key", () => {
  it("offers cash on delivery only, and refuses online payment clearly", async () => {
    const s = await shopperWith([["GL-TONER-150", 1]]);
    const email = new DevOutbox();
    const refunds = new RefundService({ prisma: h.db.prisma, gateway: null, email, appUrl: "http://localhost:5173" });
    const cancellation = new CancellationService({ prisma: h.db.prisma, refunds, email, appUrl: "http://localhost:5173" });
    const orders = new OrderService({ prisma: h.db.prisma, cart: new CartService({ prisma: h.db.prisma }), gateway: null, email, kv: new MemoryKv(), appUrl: "http://localhost:5173", refunds, cancellation });
    const view = await orders.summary(s.user.id, { delivery: {} });
    expect(view.paymentMethods.filter((m) => m.available).map((m) => m.method)).toEqual(["COD"]);
    await expect(orders.place(s.user.id, randomUUID(), { addressId: s.addressId, delivery: {}, paymentMethod: "GCASH", expectedTotalCentavos: view.totals.totalCentavos })).rejects.toMatchObject({ status: 503 });
  });
});
