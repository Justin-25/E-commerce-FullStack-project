import { Router } from "express";
import { privateNoStore, publicCache } from "../../lib/httpCache.js";
import { signedInUserId as signedInUser, type AuthGuards } from "../../middleware/auth.js";
import { storeSlugSchema } from "./stores.schemas.js";
import type { StoreService } from "./stores.service.js";
import type { VisitService } from "./visits.js";

/**
 * The store page is public and the same for everyone (cacheable). Whether YOU follow
 * it is a separate, signed-in question, so a shared cache can never show one person's
 * "Following" to someone else. Follow/unfollow are PUT/DELETE: CSRF-checked app-wide.
 */
export function storesRouter({ stores, guards, visits }: { stores: StoreService; guards: AuthGuards; visits: VisitService }): Router {
  const router = Router();

  router.get("/stores/:slug", async (req, res) => {
    const store = await stores.page(storeSlugSchema.parse(req.params).slug);
    void visits.record(store.id, { ip: req.ip, userAgent: req.get("user-agent") }); // the seller's "Store visits"
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
