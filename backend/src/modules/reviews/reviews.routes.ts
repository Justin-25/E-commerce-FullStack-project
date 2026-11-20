import { Router } from "express";
import { publicCache } from "../../lib/httpCache.js";
import { productIdSchema } from "../catalog/catalog.schemas.js";
import { storeSlugSchema } from "../stores/stores.schemas.js";
import { reviewQuerySchema } from "./reviews.schemas.js";
import type { ReviewService } from "./reviews.service.js";

/** Reading reviews (public). Writing one needs a delivered order, so it comes with checkout (milestone 5). */
export function reviewsRouter({ reviews }: { reviews: ReviewService }): Router {
  const router = Router();

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

  return router;
}
