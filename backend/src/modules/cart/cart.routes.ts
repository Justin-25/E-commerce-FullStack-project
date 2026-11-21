import { Router, type RequestHandler } from "express";
import { privateNoStore } from "../../lib/httpCache.js";
import { signedInUserId, type AuthGuards } from "../../middleware/auth.js";
import { addItemSchema, mergeSchema, previewSchema, setQuantitySchema, variantIdSchema } from "./cart.schemas.js";
import type { CartService } from "./cart.service.js";

/**
 * The cart. Signed-in carts live in the database; a guest's cart lives in their browser
 * and is shown with `GET /cart/preview`, then merged with `POST /cart/merge` at sign-in.
 * Never cached (stock and prices are live). Changes are CSRF-checked app-wide.
 */
export function cartRouter({ cart, guards }: { cart: CartService; guards: AuthGuards }): Router {
  const router = Router();
  const live: RequestHandler = (_req, res, next) => {
    privateNoStore(res);
    next();
  };

  router.get("/cart/preview", live, async (req, res) => {
    res.json({ cart: await cart.preview(previewSchema.parse(req.query).items) });
  });

  router.get("/cart", ...guards.requireAuth, live, async (req, res) => {
    res.json({ cart: await cart.get(signedInUserId(req)) });
  });

  router.post("/cart/items", ...guards.requireAuth, live, async (req, res) => {
    const { variantId, quantity } = addItemSchema.parse(req.body);
    res.json({ cart: await cart.add(signedInUserId(req), variantId, quantity) });
  });

  router.patch("/cart/items/:variantId", ...guards.requireAuth, live, async (req, res) => {
    const { variantId } = variantIdSchema.parse(req.params);
    res.json({ cart: await cart.setQuantity(signedInUserId(req), variantId, setQuantitySchema.parse(req.body).quantity) });
  });

  router.delete("/cart/items/:variantId", ...guards.requireAuth, live, async (req, res) => {
    res.json({ cart: await cart.remove(signedInUserId(req), variantIdSchema.parse(req.params).variantId) });
  });

  router.post("/cart/merge", ...guards.requireAuth, live, async (req, res) => {
    res.json(await cart.merge(signedInUserId(req), mergeSchema.parse(req.body).items));
  });

  return router;
}
