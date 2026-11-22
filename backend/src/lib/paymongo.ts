import { createHmac, timingSafeEqual } from "node:crypto";
import { DependencyUnavailableError } from "./errors.js";
import type { Logger } from "./logger.js";

/**
 * Everything the shop needs from a payment provider, in one small interface, so the
 * order code never talks HTTP and tests can swap in a fake (tests/support/fakePaymongo.ts).
 */
export type OnlineMethod = "GCASH" | "MAYA" | "CARD";

export interface CheckoutRequest {
  /** "VD-21458": shown on PayMongo's page and in their dashboard. */
  referenceNumber: string;
  orderId: string;
  method: OnlineMethod;
  /** Must add up to exactly what the order charges (items and delivery fees). */
  lineItems: { name: string; amountCentavos: number; quantity: number }[];
  successUrl: string;
  cancelUrl: string;
  billing: { name: string; email: string; phone?: string | undefined };
}

export interface CheckoutSession {
  id: string;
  checkoutUrl: string;
}

export interface PaidPayment {
  paymentId: string;
  amountCentavos: number;
  paidAt: Date;
}

export interface CheckoutState {
  id: string;
  status: "active" | "expired";
  /** At most one payment of a session is "paid". */
  paid: PaidPayment | null;
}

export interface PaymentGateway {
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;
  getCheckout(sessionId: string): Promise<CheckoutState>;
  /** "refused": PayMongo won't expire it because a payment is paid, pending or processing. */
  expireCheckout(sessionId: string): Promise<"expired" | "refused">;
  refund(paymentId: string, amountCentavos: number, reason: "duplicate" | "others"): Promise<{ refundId: string }>;
}

/** Our method names → PayMongo's `payment_method_types`. */
export const PAYMONGO_METHOD: Record<OnlineMethod, string> = { GCASH: "gcash", MAYA: "paymaya", CARD: "card" };

const API = "https://api.paymongo.com";
const TIMEOUT_MS = 10_000;

/**
 * PayMongo's REST API (docs.paymongo.com, read 2026-11-22): Hosted Checkout sessions (v2 to
 * create, v1 to read and expire) and refunds. The secret key is the Basic-auth username.
 */
export class PayMongoGateway implements PaymentGateway {
  private readonly auth: string;

  constructor(
    secretKey: string,
    private readonly logger?: Logger
  ) {
    this.auth = `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`;
  }

  async createCheckout(r: CheckoutRequest): Promise<CheckoutSession> {
    const body = await this.call("POST", "/v2/checkout_sessions", {
      data: {
        attributes: {
          line_items: r.lineItems.map((l) => ({ name: l.name.slice(0, 255), amount: l.amountCentavos, currency: "PHP", quantity: l.quantity })),
          payment_method_types: [PAYMONGO_METHOD[r.method]],
          success_url: r.successUrl,
          cancel_url: r.cancelUrl,
          reference_number: r.referenceNumber,
          description: `Vendora order ${r.referenceNumber}`,
          metadata: { orderId: r.orderId },
          billing: { name: r.billing.name, email: r.billing.email, ...(r.billing.phone ? { phone: r.billing.phone } : {}) },
          send_email_receipt: false, // Vendora sends its own confirmation
          show_line_items: true
        }
      }
    });
    const data = (body as { data?: { id?: unknown; attributes?: { checkout_url?: unknown } } }).data;
    if (typeof data?.id !== "string" || typeof data.attributes?.checkout_url !== "string") throw new Error("PayMongo: unexpected checkout session response");
    return { id: data.id, checkoutUrl: data.attributes.checkout_url };
  }

  async getCheckout(sessionId: string): Promise<CheckoutState> {
    const body = await this.call("GET", `/v1/checkout_sessions/${encodeURIComponent(sessionId)}`);
    return readSession((body as { data?: unknown }).data);
  }

  async expireCheckout(sessionId: string): Promise<"expired" | "refused"> {
    try {
      await this.call("POST", `/v1/checkout_sessions/${encodeURIComponent(sessionId)}/expire`);
      return "expired";
    } catch (err) {
      if (err instanceof PayMongoError && err.status === 400) return "refused"; // already expired, paid, or a payment in progress
      throw err;
    }
  }

  async refund(paymentId: string, amountCentavos: number, reason: "duplicate" | "others"): Promise<{ refundId: string }> {
    const body = await this.call("POST", "/v1/refunds", { data: { attributes: { amount: amountCentavos, payment_id: paymentId, reason } } });
    const id = (body as { data?: { id?: unknown } }).data?.id;
    if (typeof id !== "string") throw new Error("PayMongo: unexpected refund response");
    return { refundId: id };
  }

  private async call(method: "GET" | "POST", path: string, json?: object): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(API + path, {
        method,
        headers: { authorization: this.auth, accept: "application/json", ...(json ? { "content-type": "application/json" } : {}) },
        ...(json ? { body: JSON.stringify(json) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (cause) {
      throw new DependencyUnavailableError("paymongo", cause);
    }
    const body: unknown = await res.json().catch(() => null);
    if (res.status >= 500) throw new DependencyUnavailableError("paymongo", new Error(`PayMongo ${res.status}`));
    if (!res.ok) {
      // Their error details help us fix requests; they never contain card data.
      const detail = (body as { errors?: { code?: string; detail?: string }[] } | null)?.errors?.[0];
      this.logger?.warn({ status: res.status, path: path.replace(/cs_\w+|pay_\w+/g, ":id"), code: detail?.code, detail: detail?.detail }, "PayMongo refused a request");
      throw new PayMongoError(res.status, detail?.code ?? "unknown", detail?.detail ?? `PayMongo ${res.status}`);
    }
    return body;
  }
}

export class PayMongoError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "PayMongoError";
  }
}

/** A checkout session resource (from GET or inside a webhook) → what we need. */
export function readSession(data: unknown): CheckoutState {
  const d = data as { id?: unknown; attributes?: { status?: unknown; payments?: unknown } } | undefined;
  if (typeof d?.id !== "string") throw new Error("PayMongo: not a checkout session");
  const payments = Array.isArray(d.attributes?.payments) ? (d.attributes.payments as { id?: unknown; attributes?: { status?: unknown; amount?: unknown; paid_at?: unknown } }[]) : [];
  const paid = payments.find((p) => p.attributes?.status === "paid" && typeof p.id === "string" && typeof p.attributes.amount === "number");
  return {
    id: d.id,
    status: d.attributes?.status === "expired" ? "expired" : "active",
    paid: paid
      ? {
          paymentId: paid.id as string,
          amountCentavos: paid.attributes?.amount as number,
          paidAt: typeof paid.attributes?.paid_at === "number" ? new Date(paid.attributes.paid_at * 1000) : new Date()
        }
      : null
  };
}

// --- webhooks ------------------------------------------------------------------

/** Signed events older than this are refused (replay protection). */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

/**
 * Checks `Paymongo-Signature: t=<unix>,te=<test sig>,li=<live sig>`: HMAC-SHA256 of
 * "<t>.<raw body>" with the webhook's secret, compared in constant time.
 * The RAW body is required: re-serialized JSON would not match.
 */
export function verifyPaymongoSignature(header: string | undefined, rawBody: Buffer, secret: string, nowMs = Date.now()): boolean {
  if (!header) return false;
  const parts = new Map(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = parts.get("t") ?? "";
  if (!/^\d{1,12}$/.test(t) || Math.abs(nowMs / 1000 - Number(t)) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest();
  return [parts.get("te"), parts.get("li")].some((sig) => {
    if (!sig || !/^[0-9a-f]{64}$/i.test(sig)) return false;
    return timingSafeEqual(expected, Buffer.from(sig, "hex"));
  });
}

export interface WebhookEvent {
  /** For storing each event once: PayMongo's evt_… id, or "<type>:<resource id>" if absent. */
  eventId: string;
  type: string;
  livemode: boolean;
  resource: unknown;
}

/**
 * The docs show two payload shapes, so both are read:
 *   - classic:  { data: { id: "evt_…", attributes: { type, livemode, data: <resource> } } }
 *   - newer:    { data: { type, livemode, data: <resource> } }
 */
export function parseWebhookEvent(body: unknown): WebhookEvent | null {
  const outer = (body as { data?: Record<string, unknown> } | null)?.data;
  if (!outer || typeof outer !== "object") return null;
  const attrs = (outer.attributes ?? null) as Record<string, unknown> | null;
  const inner = attrs && typeof attrs.type === "string" ? attrs : outer;
  const type = inner.type;
  const resource = inner.data as { id?: unknown } | undefined;
  if (typeof type !== "string" || typeof resource?.id !== "string") return null;
  const eventId = typeof outer.id === "string" && outer.id.startsWith("evt_") ? outer.id : `${type}:${resource.id}`;
  return { eventId: eventId.slice(0, 100), type: type.slice(0, 80), livemode: inner.livemode === true, resource };
}
