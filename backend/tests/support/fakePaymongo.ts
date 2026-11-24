import { createHmac } from "node:crypto";
import { DependencyUnavailableError } from "../../src/lib/errors.js";
import {
  PayMongoError,
  type CheckoutRequest,
  type CheckoutSession,
  type CheckoutState,
  type PaidPayment,
  type PaymentGateway,
  type ProviderRefund,
  type RefundRequest
} from "../../src/lib/paymongo.js";

/** The webhook secret the test app is configured with. */
export const TEST_WEBHOOK_SECRET = "whsk_testsecret1234567890";

interface Session {
  id: string;
  request: CheckoutRequest;
  status: "active" | "expired";
  paid: PaidPayment | null;
  /** PayMongo is processing a payment: it refuses to expire the session. */
  busy: boolean;
}

/**
 * A stand-in for PayMongo with the behaviour the order code depends on (sessions that
 * only expire when asked, refusing while a payment is in progress, refunds), plus
 * buttons for tests: pay, fail, go down, and send a correctly signed webhook.
 */
export class FakePaymongo implements PaymentGateway {
  readonly sessions = new Map<string, Session>();
  readonly refunds: (ProviderRefund & { paymentId: string; reason: string })[] = [];
  /** Simulate PayMongo being unreachable. */
  down = false;
  /** Refunds are refused with this (like "available_balance_insufficient" in a test account). */
  refundRefusal: PayMongoError | null = null;
  /** The refund goes through, but the answer never arrives (a timeout after PayMongo did it). */
  loseRefundAnswer = false;
  private seq = 0;

  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    this.check();
    const id = `cs_test_${++this.seq}${"x".repeat(8)}`;
    this.sessions.set(id, { id, request, status: "active", paid: null, busy: false });
    return { id, checkoutUrl: `https://checkout.paymongo.test/${id}` };
  }

  async getCheckout(sessionId: string): Promise<CheckoutState> {
    this.check();
    const s = this.session(sessionId);
    return { id: s.id, status: s.status, paid: s.paid };
  }

  async expireCheckout(sessionId: string): Promise<"expired" | "refused"> {
    this.check();
    const s = this.session(sessionId);
    if (s.status === "expired" || s.paid || s.busy) return "refused";
    s.status = "expired";
    return "expired";
  }

  async refund(r: RefundRequest): Promise<ProviderRefund> {
    this.check();
    if (this.refundRefusal) throw this.refundRefusal;
    // Like PayMongo: all of a payment's refunds add up to at most what was paid.
    const paid = [...this.sessions.values()].find((x) => x.paid?.paymentId === r.paymentId)?.paid;
    if (!paid) throw new PayMongoError(404, "resource_not_found", "No such payment");
    const already = this.refunds.filter((x) => x.paymentId === r.paymentId).reduce((sum, x) => sum + x.amountCentavos, 0);
    if (already + r.amountCentavos > paid.amountCentavos) throw new PayMongoError(400, "parameter_above_maximum", "The refund is more than what's left of the payment");
    const refund = { id: `ref_test_${++this.seq}`, amountCentavos: r.amountCentavos, status: "pending", metadata: { ...r.metadata } };
    this.refunds.push({ ...refund, paymentId: r.paymentId, reason: r.reason });
    if (this.loseRefundAnswer) throw new DependencyUnavailableError("paymongo", new Error("fake PayMongo: the answer was lost"));
    return refund;
  }

  async listRefunds(paymentId: string): Promise<ProviderRefund[]> {
    this.check();
    return this.refunds.filter((r) => r.paymentId === paymentId).map(({ id, amountCentavos, status, metadata }) => ({ id, amountCentavos, status, metadata }));
  }

  // --- test buttons -------------------------------------------------------------

  /** The shopper pays on PayMongo's page (an expired session can't be paid, unless forced to simulate a race). */
  pay(sessionId: string, opts: { amountCentavos?: number; force?: boolean } = {}): PaidPayment {
    const s = this.session(sessionId);
    if (s.status === "expired" && !opts.force) throw new Error(`fake PayMongo: ${sessionId} is expired`);
    s.paid = { paymentId: `pay_test_${++this.seq}${"y".repeat(8)}`, amountCentavos: opts.amountCentavos ?? total(s.request), paidAt: new Date() };
    s.busy = false;
    return s.paid;
  }

  /** The newest session, or the newest for one order. */
  latest(orderId?: string): Session {
    const all = [...this.sessions.values()].filter((s) => !orderId || s.request.orderId === orderId);
    const last = all.at(-1);
    if (!last) throw new Error("fake PayMongo: no session");
    return last;
  }

  /**
   * A webhook exactly as PayMongo would send it, signed with `secret`:
   * "classic" = { data: { id: evt_…, attributes: { type, data } } }, "docs" = { data: { type, data } }.
   */
  webhook(sessionId: string, opts: { secret?: string; shape?: "classic" | "docs"; ageSeconds?: number; eventId?: string } = {}): { body: string; signature: string } {
    const s = this.session(sessionId);
    if (!s.paid) throw new Error("fake PayMongo: pay the session first");
    const resource = {
      id: s.id,
      type: "checkout_session",
      attributes: {
        status: s.status,
        reference_number: s.request.referenceNumber,
        metadata: { orderId: s.request.orderId },
        payments: [{ id: s.paid.paymentId, type: "payment", attributes: { amount: s.paid.amountCentavos, currency: "PHP", status: "paid", paid_at: Math.floor(s.paid.paidAt.getTime() / 1000) } }]
      }
    };
    const payload =
      opts.shape === "docs"
        ? { event_type: "send.webhook", data: { type: "checkout_session.payment.paid", resource: "checkout_session", livemode: false, data: resource } }
        : { data: { id: opts.eventId ?? `evt_test_${++this.seq}`, type: "event", attributes: { type: "checkout_session.payment.paid", livemode: false, data: resource } } };
    const body = JSON.stringify(payload);
    return { body, signature: sign(body, opts.secret ?? TEST_WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - (opts.ageSeconds ?? 0)) };
  }

  private session(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new PayMongoError(404, "resource_not_found", "No such checkout session");
    return s;
  }

  private check() {
    if (this.down) throw new DependencyUnavailableError("paymongo", new Error("fake PayMongo is down"));
  }
}

/** `Paymongo-Signature` for a test-mode event. */
export function sign(body: string, secret: string, t: number): string {
  return `t=${t},te=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")},li=`;
}

const total = (r: CheckoutRequest) => r.lineItems.reduce((s, l) => s + l.amountCentavos * l.quantity, 0);
