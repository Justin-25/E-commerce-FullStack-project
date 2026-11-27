import { Router } from "express";
import { AppError } from "../../lib/errors.js";
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
    const { slug } = storeSlugSchema.parse(req.params);
    let store: Awaited<ReturnType<StoreService["page"]>>;
    try {
      store = await stores.page(slug);
    } catch (err) {
      // Not a live store's address: maybe the old address of a store Support renamed (7c-2) → a permanent redirect.
      const movedTo = err instanceof AppError && err.status === 404 ? await stores.movedTo(slug) : null;
      if (!movedTo) throw err;
      publicCache(res);
      res.redirect(301, `/api/v1/stores/${movedTo}`);
      return;
    }
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
