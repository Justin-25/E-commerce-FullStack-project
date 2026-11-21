import { Router } from "express";
import { privateNoStore } from "../../lib/httpCache.js";
import { signedInUserId, type AuthGuards } from "../../middleware/auth.js";
import { productIdSchema } from "../catalog/catalog.schemas.js";
import type { WishlistService } from "./wishlist.service.js";

/** The signed-in shopper's wishlist. Never cached; PUT/DELETE are CSRF-checked app-wide. */
export function wishlistRouter({ wishlist, guards }: { wishlist: WishlistService; guards: AuthGuards }): Router {
  const router = Router();

  router.get("/wishlist", ...guards.requireAuth, async (req, res) => {
    const result = await wishlist.list(signedInUserId(req));
    privateNoStore(res);
    res.json(result);
  });

  router.get("/wishlist/ids", ...guards.requireAuth, async (req, res) => {
    const ids = await wishlist.ids(signedInUserId(req));
    privateNoStore(res);
    res.json({ productIds: ids });
  });

  router.put("/wishlist/:id", ...guards.requireAuth, async (req, res) => {
    const result = await wishlist.save(signedInUserId(req), productIdSchema.parse(req.params).id);
    privateNoStore(res);
    res.json(result);
  });

  router.delete("/wishlist/:id", ...guards.requireAuth, async (req, res) => {
    const result = await wishlist.remove(signedInUserId(req), productIdSchema.parse(req.params).id);
    privateNoStore(res);
    res.json(result);
  });

  return router;
}
