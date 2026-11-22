import { Router, type RequestHandler } from "express";
import { privateNoStore, publicCache } from "../../lib/httpCache.js";
import { signedInUserId, type AuthGuards } from "../../middleware/auth.js";
import { productIdSchema } from "../catalog/catalog.schemas.js";
import { storeSlugSchema } from "../stores/stores.schemas.js";
import { editReviewSchema, reviewIdSchema, reviewQuerySchema, writeReviewSchema } from "./reviews.schemas.js";
import type { ReviewService } from "./reviews.service.js";

/**
 * Reading reviews (public, briefly cacheable) and writing your own (signed in, never cached;
 * changes are CSRF-checked app-wide). Writing needs a delivered item from one of your orders.
 */
export function reviewsRouter({ reviews, guards }: { reviews: ReviewService; guards: AuthGuards }): Router {
  const router = Router();
  const live: RequestHandler = (_req, res, next) => {
    privateNoStore(res);
    next();
  };

  router.get("/products/:id/reviews", async (req, res) => {
    const { id } = productIdSchema.parse(req.params);
    const result = await reviews.forProduct(id, reviewQuerySchema.parse(req.query));
    publicCache(res);
    res.json(result);
  });

  router.get("/stores/:slug/reviews", async (req, res) => {
    const { slug } = storeSlugSchema.parse(req.params);
    const result = await reviews.forStore(slug, reviewQuerySchema.parse(req.query));
    publicCache(res);
    res.json(result);
  });

  router.post("/reviews", ...guards.requireAuth, live, async (req, res) => {
    res.status(201).json({ review: await reviews.write(signedInUserId(req), writeReviewSchema.parse(req.body)) });
  });

  router.patch("/reviews/:id", ...guards.requireAuth, live, async (req, res) => {
    const { id } = reviewIdSchema.parse(req.params);
    res.json({ review: await reviews.edit(signedInUserId(req), id, editReviewSchema.parse(req.body)) });
  });

  router.delete("/reviews/:id", ...guards.requireAuth, live, async (req, res) => {
    await reviews.remove(signedInUserId(req), reviewIdSchema.parse(req.params).id);
    res.status(204).end();
  });

  return router;
}
