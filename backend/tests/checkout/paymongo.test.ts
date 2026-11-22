import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DependencyUnavailableError } from "../../src/lib/errors.js";
import { parseWebhookEvent, PayMongoGateway, readSession, verifyPaymongoSignature } from "../../src/lib/paymongo.js";

afterEach(() => vi.unstubAllGlobals());

/** Replaces fetch: records each request and answers with the given status and JSON. */
function stubFetch(...answers: { status: number; json: unknown }[]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const a = answers.shift() ?? { status: 500, json: {} };
    return new Response(JSON.stringify(a.json), { status: a.status, headers: { "content-type": "application/json" } });
  });
  return calls;
}

const request = {
  referenceNumber: "VD-21458",
  orderId: "0193c0de-0000-7000-8000-000000000001",
  method: "MAYA" as const,
  lineItems: [
    { name: "AuraSound Pro · Midnight Black", amountCentavos: 749_900, quantity: 1 },
    { name: "Standard delivery · Glow Lab", amountCentavos: 4_900, quantity: 1 }
  ],
  successUrl: "http://localhost:5173/checkout/payment?order=1",
  cancelUrl: "http://localhost:5173/checkout/payment?order=1&cancelled=1",
  billing: { name: "Maria Santos", email: "maria@example.com", phone: "+639171234567" }
};

describe("PayMongoGateway", () => {
  it("creates a v2 Hosted Checkout session with the secret key, in centavos, for the chosen method only", async () => {
    const calls = stubFetch({ status: 200, json: { data: { id: "cs_abc123", type: "checkout_session", attributes: { checkout_url: "https://checkout.paymongo.com/cs_abc123" } } } });
    const session = await new PayMongoGateway("sk_test_abcdefghij1234").createCheckout(request);
    expect(session).toEqual({ id: "cs_abc123", checkoutUrl: "https://checkout.paymongo.com/cs_abc123" });
    const [call] = calls;
    expect(call?.url).toBe("https://api.paymongo.com/v2/checkout_sessions");
    expect(call?.method).toBe("POST");
    expect(call?.headers.authorization).toBe(`Basic ${Buffer.from("sk_test_abcdefghij1234:").toString("base64")}`);
    expect(call?.body).toMatchObject({
      data: {
        attributes: {
          line_items: [
            { name: "AuraSound Pro · Midnight Black", amount: 749_900, currency: "PHP", quantity: 1 },
            { name: "Standard delivery · Glow Lab", amount: 4_900, currency: "PHP", quantity: 1 }
          ],
          payment_method_types: ["paymaya"],
          reference_number: "VD-21458",
          success_url: request.successUrl,
          cancel_url: request.cancelUrl,
          metadata: { orderId: request.orderId },
          billing: { name: "Maria Santos", email: "maria@example.com", phone: "+639171234567" },
          send_email_receipt: false
        }
      }
    });
  });

  it("reads a session: active or expired, and the one paid payment among the attempts", async () => {
    const calls = stubFetch({
      status: 200,
      json: {
        data: {
          id: "cs_abc123",
          attributes: {
            status: "active",
            payments: [
              { id: "pay_failed1", attributes: { status: "failed", amount: 754_800 } },
              { id: "pay_good1", attributes: { status: "paid", amount: 754_800, paid_at: 1_795_000_000 } }
            ]
          }
        }
      }
    });
    const state = await new PayMongoGateway("sk_test_abcdefghij1234").getCheckout("cs_abc123");
    expect(calls[0]?.url).toBe("https://api.paymongo.com/v1/checkout_sessions/cs_abc123");
    expect(state).toEqual({ id: "cs_abc123", status: "active", paid: { paymentId: "pay_good1", amountCentavos: 754_800, paidAt: new Date(1_795_000_000_000) } });
    expect(readSession({ id: "cs_x", attributes: { status: "expired", payments: [] } })).toEqual({ id: "cs_x", status: "expired", paid: null });
  });

  it("treats PayMongo's 400 on expire as 'refused' (paid or mid-payment), and outages as temporarily unavailable", async () => {
    stubFetch({ status: 200, json: { data: { id: "cs_1" } } }, { status: 400, json: { errors: [{ code: "checkout_session_ongoing_payment", detail: "has ongoing payment" }] } });
    const gateway = new PayMongoGateway("sk_test_abcdefghij1234");
    expect(await gateway.expireCheckout("cs_1")).toBe("expired");
    expect(await gateway.expireCheckout("cs_1")).toBe("refused");

    stubFetch({ status: 503, json: {} });
    await expect(gateway.getCheckout("cs_1")).rejects.toBeInstanceOf(DependencyUnavailableError);
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(gateway.createCheckout(request)).rejects.toBeInstanceOf(DependencyUnavailableError);
  });

  it("refunds a payment by id, in centavos", async () => {
    const calls = stubFetch({ status: 200, json: { data: { id: "ref_1" } } });
    expect(await new PayMongoGateway("sk_test_abcdefghij1234").refund("pay_good1", 754_800, "duplicate")).toEqual({ refundId: "ref_1" });
    expect(calls[0]).toMatchObject({ url: "https://api.paymongo.com/v1/refunds", body: { data: { attributes: { amount: 754_800, payment_id: "pay_good1", reason: "duplicate" } } } });
  });
});

describe("webhook signatures", () => {
  const secret = "whsk_abcdefghij1234";
  const body = Buffer.from('{"data":{"id":"evt_1"}}');
  const at = (t: number, which: "te" | "li" = "te", key = secret, payload = body) => {
    const sig = createHmac("sha256", key).update(`${t}.`).update(payload).digest("hex");
    return which === "te" ? `t=${t},te=${sig},li=` : `t=${t},te=,li=${sig}`;
  };
  const now = 1_800_000_000_000;
  const t = now / 1000;

  it("accepts test-mode (te) and live-mode (li) signatures over the raw body", () => {
    expect(verifyPaymongoSignature(at(t), body, secret, now)).toBe(true);
    expect(verifyPaymongoSignature(at(t, "li"), body, secret, now)).toBe(true);
  });

  it("refuses wrong keys, changed bodies, old timestamps and broken headers", () => {
    expect(verifyPaymongoSignature(at(t, "te", "whsk_otherkey12345"), body, secret, now)).toBe(false);
    expect(verifyPaymongoSignature(at(t), Buffer.from('{"data":{"id":"evt_2"}}'), secret, now)).toBe(false);
    expect(verifyPaymongoSignature(at(t - 301), body, secret, now)).toBe(false);
    expect(verifyPaymongoSignature(at(t + 301), body, secret, now)).toBe(false);
    for (const header of [undefined, "", "t=abc,te=00", `t=${t},te=zz,li=`, `te=${"a".repeat(64)}`, `t=${t},te=${"a".repeat(63)}`]) {
      expect(verifyPaymongoSignature(header, body, secret, now), String(header)).toBe(false);
    }
  });
});

describe("webhook payloads", () => {
  const session = { id: "cs_1", type: "checkout_session", attributes: { payments: [] } };
  it("reads both documented shapes", () => {
    expect(parseWebhookEvent({ data: { id: "evt_9", type: "event", attributes: { type: "checkout_session.payment.paid", livemode: false, data: session } } })).toEqual({
      eventId: "evt_9",
      type: "checkout_session.payment.paid",
      livemode: false,
      resource: session
    });
    expect(parseWebhookEvent({ event_type: "send.webhook", data: { type: "checkout_session.payment.paid", livemode: true, data: session } })).toEqual({
      eventId: "checkout_session.payment.paid:cs_1",
      type: "checkout_session.payment.paid",
      livemode: true,
      resource: session
    });
  });

  it("ignores anything else", () => {
    for (const body of [null, {}, { data: "x" }, { data: { type: "payment.paid" } }, { data: { attributes: { type: 5, data: session } } }]) expect(parseWebhookEvent(body)).toBeNull();
  });
});
