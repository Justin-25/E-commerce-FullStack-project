import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PayMongoError } from "../../src/lib/paymongo.js";
import { admins } from "../support/admins.js";
import type { Browser } from "../support/browser.js";
import { createCatalogHarness, type CatalogHarness } from "../support/catalogHarness.js";
import { sellers } from "../support/sellers.js";
import { shopping } from "../support/shopping.js";
import { totpCode } from "../support/authHarness.js";

let h: CatalogHarness;
let sell: ReturnType<typeof sellers>;
let shop: ReturnType<typeof shopping>;
let adm: ReturnType<typeof admins>;
beforeAll(async () => {
  h = await createCatalogHarness();
  sell = sellers(h);
  shop = shopping(h);
  adm = admins(h);
}, 120_000);
beforeEach(() => {
  h.clock.offsetMs = 0;
  h.paymongo.refundRefusal = null;
  h.paymongo.loseRefundAnswer = false;
});
afterAll(() => h?.close());

const A = "/api/v1/admin";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const refusal = () => new PayMongoError(400, "available_balance_insufficient", "Insufficient balance");
const mail = (to: string, kind: string) => h.outbox.sent.filter((m) => m.to === to && m.kind === kind);
const auditOf = (targetId: string) => h.db.prisma.auditLog.findMany({ where: { targetId }, orderBy: { createdAt: "asc" }, select: { action: true, actorId: true, metadata: true } });
type Order = { id: string; number: string; packages: { id: string; store: { slug: string } }[] };

/** An approved seller (past the fee-free days) with one ₱500 product. */
async function sellerWithProduct() {
  const seller = await sell.seller({ approve: true });
  await h.db.prisma.store.update({ where: { id: seller.store.id }, data: { approvedAt: new Date(Date.now() - 40 * DAY) } });
  const product = await sell.publish(seller.browser, { variants: [{ name: "Blue", sku: `SKU-${randomUUID().slice(0, 8)}`, priceCentavos: 50_000, stock: 40 }] });
  const sku = product.variants[0]?.sku ?? "";
  const mine = (o: Order) => o.packages.find((p) => p.store.slug === seller.store.slug)?.id ?? "";
  return { seller, sku, mine };
}

/** A payout in progress: one delivered ₱500 sale (₱475 after the fee), released 7 days later, then "Request payout". */
async function payoutInProgress() {
  const { seller, sku } = await sellerWithProduct();
  const o = await shop.order(await shop.shopper(), [[sku, 1]]);
  await shop.deliver(o.id);
  h.clock.offsetMs = 7 * DAY + HOUR;
  const res = await seller.browser.post("/api/v1/seller/payouts");
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  h.clock.offsetMs = 0;
  const payout = await h.db.prisma.payout.findFirstOrThrow({ where: { storeId: seller.store.id, status: "PROCESSING" } });
  return { seller, payout };
}

/** A refund PayMongo refuses: "retrying" (its first try just failed) or "failed" (3 days later, needs a person). */
async function refundThat(state: "retrying" | "failed") {
  const { seller, sku, mine } = await sellerWithProduct();
  const s = await shop.shopper();
  const o = (await shop.order(s, [[sku, 1]], { method: "GCASH" })) as Order;
  h.paymongo.pay(h.paymongo.latest(o.id).id);
  expect((await s.browser.get(`/api/v1/orders/${o.id}`)).body.order.status).toBe("PLACED"); // back from PayMongo: paid
  h.paymongo.refundRefusal = refusal();
  expect((await seller.browser.post(`/api/v1/seller/orders/${mine(o)}/cancel`, { reason: "OUT_OF_STOCK" })).status).toBe(200);
  let refund = await h.db.prisma.refund.findUniqueOrThrow({ where: { sellerOrderId: mine(o) } });
  if (state === "failed") {
    h.clock.offsetMs = 3 * DAY + HOUR;
    expect(await h.refunds().send(refund.id)).toBe("failed");
    h.clock.offsetMs = 0;
    refund = await h.db.prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
  }
  h.paymongo.refundRefusal = null;
  const payment = await h.db.prisma.payment.findUniqueOrThrow({ where: { id: refund.paymentId } });
  const pkgRefund = async () => ((await s.browser.get(`/api/v1/orders/${o.id}`)).body.order.packages as { id: string; refund: { status: string } | null }[]).find((p) => p.id === mine(o))?.refund;
  return { s, o, refund, paymentId: payment.id, providerPaymentId: payment.providerPaymentId ?? "", pkgRefund };
}

/** A refund made by hand in PayMongo's dashboard (no Vendora id in its metadata). */
function dashboardRefund(providerPaymentId: string, amountCentavos: number) {
  const id = `ref_dash${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  h.paymongo.refunds.push({ id, amountCentavos, status: "succeeded", metadata: {}, paymentId: providerPaymentId, reason: "others" });
  return id;
}

async function finance(name = "Fe Finance") {
  return adm.admin(["FINANCE"], { name });
}
type Who = { browser: Browser; user: { id: string }; manualKey: string };

describe("Payouts", () => {
  it("are Finance's: in progress oldest first, with tabs, counts and search", async () => {
    const support = await adm.admin(["SUPPORT"]);
    for (const path of [`${A}/payouts`, `${A}/refunds`]) {
      const res = await support.browser.get(path);
      expect([res.status, res.body.error?.details?.reason, res.body.error?.details?.role]).toEqual([403, "missing_role", "FINANCE"]);
    }
    const first = await payoutInProgress();
    const second = await payoutInProgress();
    const fin = await finance();
    const res = await fin.browser.get(`${A}/payouts`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const ids = (res.body.items as { id: string }[]).map((p) => p.id);
    expect(ids.indexOf(first.payout.id)).toBeLessThan(ids.indexOf(second.payout.id));
    expect(res.body.items.find((p: { id: string }) => p.id === first.payout.id)).toMatchObject({
      reference: first.payout.reference,
      status: "PROCESSING",
      amountCentavos: 47_500,
      orders: 1,
      method: "GCASH",
      accountLast4: "4567",
      accountChanged: false,
      store: { name: first.seller.store.name }
    });
    expect(res.body.counts.inProgress).toBeGreaterThanOrEqual(2);
    expect(res.body.inProgressCentavos).toBeGreaterThanOrEqual(95_000);
    const byRef = await fin.browser.get(`${A}/payouts?q=${second.payout.reference.toLowerCase()}`);
    expect(byRef.body.items.map((p: { id: string }) => p.id)).toEqual([second.payout.id]);
    const byStore = await fin.browser.get(`${A}/payouts?q=${encodeURIComponent(first.seller.store.name)}`);
    expect(byStore.body.items.map((p: { id: string }) => p.id)).toEqual([first.payout.id]);
    expect((await fin.browser.get(`${A}/payouts?tab=paid&q=${first.payout.reference}`)).body.items).toEqual([]);
    expect((await fin.browser.get(`${A}/payouts?tab=nope`)).status).toBe(400);
  });

  it("Show account: the full number for the transfer, logged; never an account the seller changed after the payout", async () => {
    const { seller, payout } = await payoutInProgress();
    const fin = await finance();
    const res = await fin.browser.post(`${A}/payouts/${payout.id}/account`);
    expect(res.status).toBe(200);
    expect(res.body.account).toEqual({ method: "GCASH", bankName: null, accountName: "Ana Maria Reyes", accountNumber: "+639171234567" });
    expect((await auditOf(payout.id)).map((r) => [r.action, r.actorId])).toEqual([["payout.view_account", fin.user.id]]);

    // The seller changes where their money goes: the payout was made for the old account.
    await h.allowCodeReuse(seller.user.id);
    expect((await seller.browser.post("/api/v1/auth/confirm", { code: totpCode(seller.manualKey) })).status).toBe(200);
    expect((await seller.browser.put("/api/v1/seller/store/payout-account", { method: "BANK", bankName: "BPI", accountName: "Ana Maria Reyes", accountNumber: "1234-5678-90" })).status).toBe(200);
    const row = (await fin.browser.get(`${A}/payouts?q=${payout.reference}`)).body.items[0];
    expect(row.accountChanged).toBe(true);
    const refused = await fin.browser.post(`${A}/payouts/${payout.id}/account`);
    expect([refused.status, refused.body.error?.details?.reason]).toEqual([409, "account_changed"]);
    expect(JSON.stringify(refused.body)).not.toContain("1234567890");
    expect((await auditOf(payout.id)).length).toBe(1);

    // An account that's being checked (not verified yet) isn't shown either.
    const other = await payoutInProgress();
    await h.db.prisma.payoutAccount.update({ where: { storeId: other.seller.store.id }, data: { verifiedAt: null } });
    expect((await fin.browser.get(`${A}/payouts?q=${other.payout.reference}`)).body.items[0].accountChanged).toBe(true);
    expect((await fin.browser.post(`${A}/payouts/${other.payout.id}/account`)).body.error?.details?.reason).toBe("account_changed");
  });

  it('Mark paid needs "Confirm it\'s you" and the transfer\'s reference; the seller sees it; only once, even by two admins at once', async () => {
    const { seller, payout } = await payoutInProgress();
    const fin = await finance("Fe Finance");
    const path = `${A}/payouts/${payout.id}/paid`;
    expect((await fin.browser.post(path, {})).status).toBe(400);
    expect((await fin.browser.post(path, { transferReference: "<script>" })).status).toBe(400);
    const unconfirmed = await fin.browser.post(path, { transferReference: "GCASH 9012 3456 7890" });
    expect([unconfirmed.status, unconfirmed.body.error?.code]).toEqual([403, "REAUTH_REQUIRED"]);
    expect((await h.db.prisma.payout.findUniqueOrThrow({ where: { id: payout.id } })).status).toBe("PROCESSING");

    await adm.confirm(fin);
    const res = await fin.browser.post(path, { transferReference: "GCASH 9012 3456 7890" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.payout).toMatchObject({ status: "PAID", transferReference: "GCASH 9012 3456 7890", handledBy: "Fe Finance" });
    const history = (await seller.browser.get("/api/v1/seller/payouts")).body.history.items[0];
    expect(history).toMatchObject({ reference: payout.reference, status: "PAID", transferReference: "GCASH 9012 3456 7890" });
    expect(mail(seller.user.email, "seller-payout-paid").at(-1)?.text).toContain("Transfer reference: GCASH 9012 3456 7890");
    const log = await auditOf(payout.id);
    expect(log.map((r) => [r.action, r.actorId])).toEqual([["payout.mark_paid", fin.user.id]]);
    expect(log[0]?.metadata).toMatchObject({ reference: payout.reference, transferReference: "GCASH 9012 3456 7890", amountCentavos: 47_500 });
    for (const again of [await fin.browser.post(path, { transferReference: "GCASH 1111" }), await fin.browser.post(`${A}/payouts/${payout.id}/failed`, { reason: "The GCash account is closed" })]) {
      expect([again.status, again.body.error?.details?.reason]).toEqual([409, "not_processing"]);
    }
    expect((await fin.browser.post(`${A}/payouts/${payout.id}/account`)).body.error?.details?.reason).toBe("not_processing"); // nothing left to transfer

    // Two Finance admins mark the same payout at the same moment: one wins, one audit row, one email.
    const next = await payoutInProgress();
    const other = await finance("Fin Two");
    await adm.confirm(other);
    const [a, b] = await Promise.all([
      fin.browser.post(`${A}/payouts/${next.payout.id}/paid`, { transferReference: "BPI 0001" }),
      other.browser.post(`${A}/payouts/${next.payout.id}/paid`, { transferReference: "BPI 0002" })
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await auditOf(next.payout.id)).length).toBe(1);
    expect(mail(next.seller.user.email, "seller-payout-paid")).toHaveLength(1);
  });

  it("Mark failed: a reason, and the money is back in the seller's balance", async () => {
    const { seller, payout } = await payoutInProgress();
    const fin = await finance();
    const unconfirmed = await fin.browser.post(`${A}/payouts/${payout.id}/failed`, { reason: "The GCash account is closed" });
    expect([unconfirmed.status, unconfirmed.body.error?.code]).toEqual([403, "REAUTH_REQUIRED"]);
    await adm.confirm(fin);
    expect((await fin.browser.post(`${A}/payouts/${payout.id}/failed`, { reason: "closed" })).status).toBe(400);
    const res = await fin.browser.post(`${A}/payouts/${payout.id}/failed`, { reason: "The GCash account is closed" });
    expect(res.status).toBe(200);
    expect(res.body.payout).toMatchObject({ status: "FAILED", failureReason: "The GCash account is closed", handledBy: "Fe Finance", transferReference: null });
    h.clock.offsetMs = 7 * DAY + 2 * HOUR; // the store's money is still released, only from the failed payout
    const view = (await seller.browser.get("/api/v1/seller/payouts")).body;
    expect(view).toMatchObject({ available: { centavos: 47_500 }, canRequest: true });
    expect(mail(seller.user.email, "seller-payout-failed").at(-1)?.text).toContain("The GCash account is closed");
    expect((await auditOf(payout.id)).map((r) => r.action)).toEqual(["payout.mark_failed"]);
    expect((await fin.browser.get(`${A}/payouts?tab=failed&q=${payout.reference}`)).body.items.map((p: { id: string }) => p.id)).toEqual([payout.id]);
  });
});

describe("Refunds PayMongo kept refusing", () => {
  it("the list: needing a person oldest first, retrying, sent; search by order number or email", async () => {
    const a = await refundThat("failed");
    const b = await refundThat("failed");
    const c = await refundThat("retrying");
    const fin = await finance();
    const res = await fin.browser.get(`${A}/refunds`);
    expect(res.status).toBe(200);
    const ids = (res.body.items as { id: string }[]).map((r) => r.id);
    expect(ids.indexOf(a.refund.id)).toBeLessThan(ids.indexOf(b.refund.id));
    expect(ids).not.toContain(c.refund.id);
    expect(res.body.items.find((r: { id: string }) => r.id === a.refund.id)).toMatchObject({
      order: { id: a.o.id, number: a.o.number },
      amountCentavos: 54_900,
      reason: "PACKAGE_CANCELLED",
      paymentMethod: "GCASH",
      status: "FAILED",
      lastError: "Insufficient balance",
      sentVia: null
    });
    expect(res.body.counts.needsPerson).toBeGreaterThanOrEqual(2);
    expect((await fin.browser.get(`${A}/refunds?tab=retrying`)).body.items.map((r: { id: string }) => r.id)).toContain(c.refund.id);
    expect((await fin.browser.get(`${A}/refunds?q=${a.o.number}`)).body.items.map((r: { id: string }) => r.id)).toEqual([a.refund.id]);
    const buyer = await h.db.prisma.user.findUniqueOrThrow({ where: { id: (await h.db.prisma.order.findUniqueOrThrow({ where: { id: b.o.id } })).userId } });
    expect((await fin.browser.get(`${A}/refunds?q=${encodeURIComponent(buyer.email)}`)).body.items.map((r: { id: string }) => r.id)).toEqual([b.refund.id]);
  });

  it('Try again now: "Confirm it\'s you", one try; sent → the buyer gets the promised email (and no second "delayed" one)', async () => {
    const { s, refund, providerPaymentId, pkgRefund } = await refundThat("failed");
    expect(await pkgRefund()).toMatchObject({ status: "delayed" });
    const fin = await finance();
    const path = `${A}/refunds/${refund.id}/retry`;
    expect((await fin.browser.post(path)).body.error?.code).toBe("REAUTH_REQUIRED");
    await adm.confirm(fin);
    const res = await fin.browser.post(path);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ result: "sent", refund: { status: "SENT", sentVia: "PAYMONGO_API" } });
    expect(h.paymongo.refunds.filter((r) => r.paymentId === providerPaymentId)).toHaveLength(1);
    expect(await pkgRefund()).toMatchObject({ status: "sent" });
    expect(mail(s.user.email, "refund-sent")).toHaveLength(1);
    expect(mail(s.user.email, "refund-delayed")).toHaveLength(1);
    expect((await auditOf(refund.id)).map((r) => [r.action, r.actorId])).toEqual([["refund.retry", fin.user.id]]);
    expect([(await fin.browser.post(path)).status, (await fin.browser.post(path)).body.error?.details?.reason]).toEqual([409, "already_sent"]);
  });

  it("Try again now still failing: back to needing a person, no second email; a refund being tried right now is left alone", async () => {
    const failed = await refundThat("failed");
    const fin = await finance();
    await adm.confirm(fin);
    h.paymongo.refundRefusal = refusal();
    const res = await fin.browser.post(`${A}/refunds/${failed.refund.id}/retry`);
    expect(res.body).toMatchObject({ result: "still_failing", refund: { status: "FAILED", attempts: failed.refund.attempts + 1 } });
    expect(mail(failed.s.user.email, "refund-delayed")).toHaveLength(1);

    const retrying = await refundThat("retrying"); // its first try failed a moment ago
    h.paymongo.refundRefusal = refusal();
    const busy = await fin.browser.post(`${A}/refunds/${retrying.refund.id}/retry`);
    expect([busy.status, busy.body.error?.details?.reason]).toEqual([409, "busy"]);
    h.clock.offsetMs = 3 * MINUTE; // no longer in the middle of a try
    const later = await fin.browser.post(`${A}/refunds/${retrying.refund.id}/retry`);
    expect(later.body).toMatchObject({ result: "still_failing", refund: { status: "PENDING", attempts: 2 } }); // still retried hourly
    expect(mail(retrying.s.user.email, "refund-delayed")).toHaveLength(0);
  });

  it("a refund made in PayMongo's dashboard that we never recorded stops every retry, manual or automatic (never refunded twice)", async () => {
    const a = await refundThat("failed");
    dashboardRefund(a.providerPaymentId, a.refund.amountCentavos);
    const fin = await finance();
    await adm.confirm(fin);
    const res = await fin.browser.post(`${A}/refunds/${a.refund.id}/retry`);
    expect([res.status, res.body.error?.details?.reason]).toEqual([409, "unrecorded_refund"]);
    expect(h.paymongo.refunds.filter((r) => r.paymentId === a.providerPaymentId)).toHaveLength(1); // only the dashboard one
    expect((await h.db.prisma.refund.findUniqueOrThrow({ where: { id: a.refund.id } })).status).toBe("FAILED");

    // The hourly job finds one on a refund it's still retrying: it stops and hands it to a person.
    const b = await refundThat("retrying");
    dashboardRefund(b.providerPaymentId, b.refund.amountCentavos);
    h.clock.offsetMs = HOUR + MINUTE;
    expect(await h.refunds().send(b.refund.id)).toBe("failed");
    const stopped = await h.db.prisma.refund.findUniqueOrThrow({ where: { id: b.refund.id } });
    expect(stopped).toMatchObject({ status: "FAILED", nextAttemptAt: null });
    expect(stopped.lastError).toContain("PayMongo shows a refund we didn't record");
    expect(h.paymongo.refunds.filter((r) => r.paymentId === b.providerPaymentId)).toHaveLength(1);
    expect(mail(b.s.user.email, "refund-delayed")).toHaveLength(1);
  });

  it("Mark as refunded with PayMongo's refund id: checked with PayMongo (this payment, this amount), then the buyer is emailed", async () => {
    const a = await refundThat("failed");
    const other = await refundThat("failed");
    const fin = await finance("Fe Finance");
    const path = `${A}/refunds/${a.refund.id}/refunded`;
    const right = dashboardRefund(a.providerPaymentId, a.refund.amountCentavos);
    expect((await fin.browser.post(path, { via: "PAYMONGO_DASHBOARD", providerRefundId: right })).body.error?.code).toBe("REAUTH_REQUIRED");
    await adm.confirm(fin);
    const field = async (body: object) => {
      const res = await fin.browser.post(path, body);
      expect(res.status).toBe(400);
      return res.body.error.fields?.[0]?.message as string;
    };
    expect(await field({ via: "PAYMONGO_DASHBOARD", providerRefundId: "pay_123456789" })).toContain("ref_");
    expect(await field({ via: "PAYMONGO_DASHBOARD", providerRefundId: "ref_unknown123" })).toContain("PayMongo has no refund ref_unknown123");
    expect(await field({ via: "PAYMONGO_DASHBOARD", providerRefundId: dashboardRefund(other.providerPaymentId, other.refund.amountCentavos) })).toContain("PayMongo has no refund");
    expect(await field({ via: "PAYMONGO_DASHBOARD", providerRefundId: dashboardRefund(a.providerPaymentId, 10_000) })).toBe("That refund is ₱100; this one is ₱549.");
    expect(await h.db.prisma.refund.findUniqueOrThrow({ where: { id: a.refund.id } })).toMatchObject({ status: "FAILED" });

    const res = await fin.browser.post(path, { via: "PAYMONGO_DASHBOARD", providerRefundId: right });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.refund).toMatchObject({ status: "SENT", sentVia: "PAYMONGO_DASHBOARD", providerRefundId: right, handledBy: "Fe Finance" });
    expect(await a.pkgRefund()).toMatchObject({ status: "sent" });
    expect(mail(a.s.user.email, "refund-sent")).toHaveLength(1);
    expect((await h.db.prisma.payment.findUniqueOrThrow({ where: { id: a.paymentId } })).status).toBe("REFUNDED"); // all of it is back
    const log = await auditOf(a.refund.id);
    expect(log.map((r) => [r.action, r.actorId])).toEqual([["refund.mark_sent", fin.user.id]]);
    expect(log[0]?.metadata).toMatchObject({ via: "PAYMONGO_DASHBOARD", providerRefundId: right, amountCentavos: 54_900 });

    // The same PayMongo refund can't close another refund, and a sent one can't be closed again.
    const again = await fin.browser.post(`${A}/refunds/${other.refund.id}/refunded`, { via: "PAYMONGO_DASHBOARD", providerRefundId: right });
    expect(again.status).toBe(400);
    expect([(await fin.browser.post(path, { via: "OTHER_TRANSFER", reference: "GCASH 1234" })).body.error?.details?.reason]).toEqual(["already_sent"]);
  });

  it("Mark as refunded by another transfer: its reference; only refunds that need a person; two admins at once close it once", async () => {
    const retrying = await refundThat("retrying");
    const fin = await finance();
    await adm.confirm(fin);
    const early = await fin.browser.post(`${A}/refunds/${retrying.refund.id}/refunded`, { via: "OTHER_TRANSFER", reference: "GCASH 9012 3456" });
    expect([early.status, early.body.error?.details?.reason]).toEqual([409, "not_failed"]);

    const b = await refundThat("failed");
    const path = `${A}/refunds/${b.refund.id}/refunded`;
    expect((await fin.browser.post(path, { via: "OTHER_TRANSFER" })).status).toBe(400);
    expect((await fin.browser.post(path, { via: "CASH", reference: "1234" })).status).toBe(400);
    const second: Who = await finance("Fin Two");
    await adm.confirm(second);
    const body = { via: "OTHER_TRANSFER", reference: "GCASH 9012 3456 7890", note: "Sent to the buyer's GCash 0917 555 0101 after a call." };
    const [x, y] = await Promise.all([fin.browser.post(path, body), second.browser.post(path, body)]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const done = (x.status === 200 ? x : y).body.refund;
    expect(done).toMatchObject({ status: "SENT", sentVia: "OTHER_TRANSFER", manualReference: "GCASH 9012 3456 7890", providerRefundId: null });
    expect(await b.pkgRefund()).toMatchObject({ status: "sent" });
    expect(mail(b.s.user.email, "refund-sent-by-hand")).toHaveLength(1);
    expect(mail(b.s.user.email, "refund-sent-by-hand")[0]?.text).toContain("Transfer reference: GCASH 9012 3456 7890");
    const log = await auditOf(b.refund.id);
    expect(log).toHaveLength(1);
    expect(log[0]?.metadata).toMatchObject({ via: "OTHER_TRANSFER", reference: "GCASH 9012 3456 7890", note: body.note });
    expect(h.paymongo.refunds.filter((r) => r.paymentId === b.providerPaymentId)).toHaveLength(0); // nothing went through PayMongo
  });

  it("a refund closed with a PayMongo dashboard refund doesn't block the other refund of the same payment", async () => {
    const one = await sellerWithProduct();
    const two = await sellerWithProduct();
    const s = await shop.shopper();
    const o = (await shop.order(s, [[one.sku, 1], [two.sku, 1]], { method: "GCASH" })) as Order; // one payment, two stores' packages
    h.paymongo.pay(h.paymongo.latest(o.id).id);
    expect((await s.browser.get(`/api/v1/orders/${o.id}`)).body.order.status).toBe("PLACED");
    h.paymongo.refundRefusal = refusal();
    for (const x of [one, two]) expect((await x.seller.browser.post(`/api/v1/seller/orders/${x.mine(o)}/cancel`, { reason: "OUT_OF_STOCK" })).status).toBe(200);
    const [ra, rb] = await Promise.all([one, two].map((x) => h.db.prisma.refund.findUniqueOrThrow({ where: { sellerOrderId: x.mine(o) } })));
    h.clock.offsetMs = 3 * DAY + HOUR;
    for (const r of [ra, rb]) expect(await h.refunds().send(r?.id ?? "")).toBe("failed");
    h.clock.offsetMs = 0;
    h.paymongo.refundRefusal = null;
    const payment = await h.db.prisma.payment.findUniqueOrThrow({ where: { id: ra?.paymentId ?? "" } });
    const fin = await finance();
    await adm.confirm(fin);
    const dash = dashboardRefund(payment.providerPaymentId ?? "", ra?.amountCentavos ?? 0);
    expect((await fin.browser.post(`${A}/refunds/${ra?.id}/refunded`, { via: "PAYMONGO_DASHBOARD", providerRefundId: dash })).status).toBe(200);
    const res = await fin.browser.post(`${A}/refunds/${rb?.id}/retry`); // the dashboard refund is recorded now: not "unrecorded"
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result).toBe("sent");
    expect(h.paymongo.refunds.filter((r) => r.paymentId === payment.providerPaymentId)).toHaveLength(2);
    expect((await h.db.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe("REFUNDED");
  });

  it("Try again now never sends alongside the job: if the job claims it during the PayMongo check, the admin's try is refused", async () => {
    const r = await refundThat("retrying");
    h.clock.offsetMs = 3 * MINUTE; // not in the middle of a try when the admin opens it
    const fin = await finance();
    await adm.confirm(fin);
    const list = h.paymongo.listRefunds.bind(h.paymongo);
    h.paymongo.listRefunds = async (paymentId: string) => {
      await h.db.prisma.refund.update({ where: { id: r.refund.id }, data: { attempts: { increment: 1 } } }); // the job's claim, right now
      return list(paymentId);
    };
    try {
      const res = await fin.browser.post(`${A}/refunds/${r.refund.id}/retry`);
      expect([res.status, res.body.error?.details?.reason]).toEqual([409, "changed"]);
    } finally {
      h.paymongo.listRefunds = list;
    }
    expect(h.paymongo.refunds.filter((x) => x.paymentId === r.providerPaymentId)).toHaveLength(0);
    expect(await auditOf(r.refund.id)).toHaveLength(0);
  });

  it("Mark as refunded never closes it twice: another admin closing it during the PayMongo check wins", async () => {
    const a = await refundThat("failed");
    const fin = await finance();
    await adm.confirm(fin);
    const right = dashboardRefund(a.providerPaymentId, a.refund.amountCentavos);
    const list = h.paymongo.listRefunds.bind(h.paymongo);
    h.paymongo.listRefunds = async (paymentId: string) => {
      await h.db.prisma.refund.update({ where: { id: a.refund.id }, data: { status: "SENT", sentAt: new Date(), sentVia: "OTHER_TRANSFER", manualReference: "OTHER ADMIN 1" } });
      return list(paymentId);
    };
    try {
      const res = await fin.browser.post(`${A}/refunds/${a.refund.id}/refunded`, { via: "PAYMONGO_DASHBOARD", providerRefundId: right });
      expect([res.status, res.body.error?.details?.reason]).toEqual([409, "not_failed"]);
    } finally {
      h.paymongo.listRefunds = list;
    }
    expect(await h.db.prisma.refund.findUniqueOrThrow({ where: { id: a.refund.id } })).toMatchObject({ manualReference: "OTHER ADMIN 1", providerRefundId: null, sentVia: "OTHER_TRANSFER" });
    expect(await auditOf(a.refund.id)).toHaveLength(0);
    expect(mail(a.s.user.email, "refund-sent")).toHaveLength(0);
  });

  it("if PayMongo can't say what was already refunded, nothing is sent or recorded", async () => {
    const a = await refundThat("failed");
    const fin = await finance();
    await adm.confirm(fin);
    const list = h.paymongo.listRefunds.bind(h.paymongo);
    h.paymongo.listRefunds = async () => {
      throw new PayMongoError(400, "resource_not_found", "No such payment");
    };
    try {
      const retry = await fin.browser.post(`${A}/refunds/${a.refund.id}/retry`);
      expect(retry.status).toBe(503);
      expect(retry.body.error.message).toContain("nothing was sent");
      const mark = await fin.browser.post(`${A}/refunds/${a.refund.id}/refunded`, { via: "PAYMONGO_DASHBOARD", providerRefundId: "ref_whatever123" });
      expect([mark.status, mark.body.error.fields?.[0]?.path]).toEqual([400, "providerRefundId"]);
      expect(mark.body.error.fields?.[0]?.message).toContain("couldn't be asked");
    } finally {
      h.paymongo.listRefunds = list;
    }
    expect(await h.db.prisma.refund.findUniqueOrThrow({ where: { id: a.refund.id } })).toMatchObject({ status: "FAILED", attempts: a.refund.attempts });
    expect(h.paymongo.refunds.filter((x) => x.paymentId === a.providerPaymentId)).toHaveLength(0);
    expect(await auditOf(a.refund.id)).toHaveLength(0);
  });
});
