import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { privateNoStore } from "../../lib/httpCache.js";
import { signedInUserId, type AuthGuards } from "../../middleware/auth.js";
import type { PriceDropService } from "./priceDrops.service.js";

const tokenSchema = z.object({ token: z.string({ error: "Missing the unsubscribe token" }).regex(/^[0-9a-f-]{36}\.[0-9a-f]{64}$/, { error: "This unsubscribe link isn't valid" }) });
const preferencesSchema = z.strictObject({ priceDrops: z.boolean({ error: "Choose on or off" }) });

/**
 * Email settings (the account's "Notifications" page) and the one-click unsubscribe link in
 * price-drop emails. The unsubscribe POST needs no sign-in or CSRF token: mail apps send it
 * themselves (RFC 8058), and the signed token in the link is the proof.
 */
export function notificationsRouter({ priceDrops, guards }: { priceDrops: PriceDropService; guards: AuthGuards }): Router {
  const router = Router();
  const live: RequestHandler = (_req, res, next) => {
    privateNoStore(res);
    next();
  };

  router.post("/notifications/unsubscribe", live, async (req, res) => {
    await priceDrops.unsubscribe(tokenSchema.parse(req.query).token);
    res.json({ priceDrops: false });
  });

  router.get("/notifications/preferences", ...guards.requireAuth, live, async (req, res) => {
    res.json(await priceDrops.preferences(signedInUserId(req)));
  });

  router.put("/notifications/preferences", ...guards.requireAuth, live, async (req, res) => {
    res.json(await priceDrops.setPreferences(signedInUserId(req), preferencesSchema.parse(req.body)));
  });

  return router;
}
