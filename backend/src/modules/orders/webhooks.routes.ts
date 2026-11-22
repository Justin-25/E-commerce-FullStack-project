import express, { Router } from "express";
import { AppError } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import { parseWebhookEvent, verifyPaymongoSignature } from "../../lib/paymongo.js";
import type { OrderService } from "./orders.service.js";

/**
 * PayMongo → us. Mounted BEFORE the JSON parser and the CSRF check: the signature is
 * computed over the exact raw bytes, and PayMongo can't send our CSRF token (the
 * signature is the proof instead). Answers fast with 2xx, as PayMongo requires.
 */
export function webhooksRouter({ orders, secret, logger }: { orders: OrderService; secret: string | undefined; logger?: Logger }): Router {
  const router = Router();

  router.post("/webhooks/paymongo", express.raw({ type: () => true, limit: "512kb" }), async (req, res) => {
    if (!secret) throw new AppError(503, "SERVICE_UNAVAILABLE", "Webhooks aren't set up yet.");
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifyPaymongoSignature(req.get("paymongo-signature"), raw, secret)) {
      logger?.warn({ ip: req.ip }, "PayMongo webhook with a bad or old signature refused");
      throw new AppError(401, "UNAUTHORIZED", "Invalid signature.");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new AppError(400, "INVALID_JSON", "The body isn't valid JSON.");
    }
    const event = parseWebhookEvent(payload);
    if (!event) {
      logger?.warn("PayMongo webhook with an unknown shape ignored");
      res.json({ received: true, result: "ignored" });
      return;
    }
    res.json({ received: true, result: await orders.handleWebhook(event, payload) });
  });

  return router;
}
