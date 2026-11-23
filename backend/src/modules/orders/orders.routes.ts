import { Router, type RequestHandler } from "express";
import { privateNoStore } from "../../lib/httpCache.js";
import { signedInUserId, type AuthGuards } from "../../middleware/auth.js";
import type { DeliveryService } from "./delivery.js";
import { idempotencyKeySchema, orderIdSchema, orderListSchema, packageIdSchema, placeOrderSchema, retryPaymentSchema, summarySchema } from "./orders.schemas.js";
import type { OrderService } from "./orders.service.js";

/** Checkout and the shopper's orders. Signed in, never cached; changes are CSRF-checked app-wide. */
export function ordersRouter({ orders, delivery, guards }: { orders: OrderService; delivery: DeliveryService; guards: AuthGuards }): Router {
  const router = Router();
  const live: RequestHandler = (_req, res, next) => {
    privateNoStore(res);
    next();
  };

  router.post("/checkout/summary", ...guards.requireAuth, live, async (req, res) => {
    res.json(await orders.summary(signedInUserId(req), summarySchema.parse(req.body)));
  });

  router.post("/orders", ...guards.requireAuth, live, async (req, res) => {
    const key = idempotencyKeySchema.parse(req.get("idempotency-key"));
    const result = await orders.place(signedInUserId(req), key, placeOrderSchema.parse(req.body));
    res.status(result.replayed ? 200 : 201).json({ order: result.order, nextAction: result.nextAction });
  });

  router.get("/orders", ...guards.requireAuth, live, async (req, res) => {
    res.json(await orders.list(signedInUserId(req), orderListSchema.parse(req.query)));
  });

  router.get("/orders/:id", ...guards.requireAuth, live, async (req, res) => {
    res.json({ order: await orders.get(signedInUserId(req), orderIdSchema.parse(req.params).id) });
  });

  router.post("/orders/:id/buy-again", ...guards.requireAuth, live, async (req, res) => {
    res.json(await orders.buyAgain(signedInUserId(req), orderIdSchema.parse(req.params).id));
  });

  router.post("/orders/:id/payment", ...guards.requireAuth, live, async (req, res) => {
    const { id } = orderIdSchema.parse(req.params);
    res.json(await orders.retryPayment(signedInUserId(req), id, retryPaymentSchema.parse(req.body).paymentMethod));
  });

  router.post("/orders/:id/cancel", ...guards.requireAuth, live, async (req, res) => {
    res.json({ order: await orders.cancel(signedInUserId(req), orderIdSchema.parse(req.params).id) });
  });

  // "Order received" for one package (milestone 6c): it's delivered, and the seller is credited.
  router.post("/orders/:id/packages/:packageId/received", ...guards.requireAuth, live, async (req, res) => {
    const { id, packageId } = packageIdSchema.parse(req.params);
    const userId = signedInUserId(req);
    await delivery.confirmReceived(userId, id, packageId);
    res.json({ order: await orders.get(userId, id) });
  });

  return router;
}
