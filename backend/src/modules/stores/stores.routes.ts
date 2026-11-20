import { Router, type Request } from "express";
import { AppError } from "../../lib/errors.js";
import { privateNoStore, publicCache } from "../../lib/httpCache.js";
import type { AuthGuards } from "../../middleware/auth.js";
import { storeSlugSchema } from "./stores.schemas.js";
import type { StoreService } from "./stores.service.js";

const signedInUser = (req: Request): string => {
  if (!req.auth) throw new AppError(401, "UNAUTHORIZED", "Please sign in.");
  return req.auth.userId;
};

/**
 * The store page is public and the same for everyone (cacheable). Whether YOU follow
 * it is a separate, signed-in question, so a shared cache can never show one person's
 * "Following" to someone else. Follow/unfollow are PUT/DELETE: CSRF-checked app-wide.
 */
export function storesRouter({ stores, guards }: { stores: StoreService; guards: AuthGuards }): Router {
  const router = Router();

  router.get("/stores/:slug", async (req, res) => {
    const store = await stores.page(storeSlugSchema.parse(req.params).slug);
    publicCache(res);
    res.json({ store });
  });

  router.get("/stores/:slug/follow", ...guards.requireAuth, async (req, res) => {
    const state = await stores.followState(signedInUser(req), storeSlugSchema.parse(req.params).slug);
    privateNoStore(res);
    res.json(state);
  });

  router.put("/stores/:slug/follow", ...guards.requireAuth, async (req, res) => {
    const state = await stores.follow(signedInUser(req), storeSlugSchema.parse(req.params).slug);
    privateNoStore(res);
    res.json(state);
  });

  router.delete("/stores/:slug/follow", ...guards.requireAuth, async (req, res) => {
    const state = await stores.unfollow(signedInUser(req), storeSlugSchema.parse(req.params).slug);
    privateNoStore(res);
    res.json(state);
  });

  return router;
}
