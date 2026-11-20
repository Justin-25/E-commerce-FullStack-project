import { Router, type Response } from "express";
import { productIdSchema, searchQuerySchema } from "./catalog.schemas.js";
import type { CatalogService } from "./catalog.service.js";

/**
 * Public catalog: no sign-in, same answer for everyone, so browsers and CDNs
 * may keep it briefly (prices and stock can change, hence only 60 seconds).
 */
const shortCache = (res: Response, seconds = 60) => res.set("Cache-Control", `public, max-age=${seconds}`);

export function catalogRouter({ catalog }: { catalog: CatalogService }): Router {
  const router = Router();

  router.get("/categories", async (_req, res) => {
    shortCache(res, 300);
    res.json({ categories: await catalog.categories() });
  });

  router.get("/products", async (req, res) => {
    const result = await catalog.search(searchQuerySchema.parse(req.query));
    shortCache(res);
    res.json(result);
  });

  router.get("/products/:id", async (req, res) => {
    const product = await catalog.product(productIdSchema.parse(req.params).id);
    shortCache(res);
    res.json({ product });
  });

  router.get("/products/:id/related", async (req, res) => {
    const products = await catalog.related(productIdSchema.parse(req.params).id);
    shortCache(res);
    res.json({ products });
  });

  return router;
}
