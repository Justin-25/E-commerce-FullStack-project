import { Router } from "express";
import { publicCache } from "../../lib/httpCache.js";
import { cardsQuerySchema, productIdSchema, searchQuerySchema } from "./catalog.schemas.js";
import type { CatalogService } from "./catalog.service.js";

/** Public catalog: no sign-in, same answer for everyone, so browsers and CDNs may keep it briefly. */
export function catalogRouter({ catalog }: { catalog: CatalogService }): Router {
  const router = Router();

  router.get("/categories", async (_req, res) => {
    publicCache(res, 300);
    res.json({ categories: await catalog.categories() });
  });

  router.get("/products", async (req, res) => {
    const result = await catalog.search(searchQuerySchema.parse(req.query));
    publicCache(res);
    res.json(result);
  });

  // Before "/products/:id", or Express would read "cards" as a product id.
  router.get("/products/cards", async (req, res) => {
    const products = await catalog.cardsByIds(cardsQuerySchema.parse(req.query).ids);
    publicCache(res);
    res.json({ products });
  });

  router.get("/products/:id", async (req, res) => {
    const product = await catalog.product(productIdSchema.parse(req.params).id);
    publicCache(res);
    res.json({ product });
  });

  router.get("/products/:id/related", async (req, res) => {
    const products = await catalog.related(productIdSchema.parse(req.params).id);
    publicCache(res);
    res.json({ products });
  });

  return router;
}
