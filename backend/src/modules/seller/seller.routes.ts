import { Router, type RequestHandler } from "express";
import type { Config } from "../../config/env.js";
import { privateNoStore } from "../../lib/httpCache.js";
import { signedInUserId, type AuthGuards } from "../../middleware/auth.js";
import { clientInfoFrom } from "../auth/events.js";
import type { SecurityService } from "../auth/security.service.js";
import type { OnboardingService } from "./onboarding.service.js";
import { documentIdSchema, documentSchema, logoSchema, payoutAccountSchema, storeDetailsSchema, uploadTicketSchema, verificationSchema } from "./seller.schemas.js";

/**
 * Seller Center: becoming a seller (milestone 6a). Signed in, never cached; changes are
 * CSRF-checked app-wide. Every change answers with the whole onboarding state, so the page
 * always shows what's done and what's missing.
 */
export function sellerRouter({
  onboarding,
  security,
  guards,
  config
}: {
  onboarding: OnboardingService;
  security: Pick<SecurityService, "requireConfirmed">;
  guards: AuthGuards;
  config: Pick<Config, "GEO_HEADERS">;
}): Router {
  const router = Router();
  const live: RequestHandler = (_req, res, next) => {
    privateNoStore(res);
    next();
  };
  const auth = [...guards.requireAuth, live];

  router.get("/seller/store", ...auth, async (req, res) => {
    res.json(await onboarding.view(signedInUserId(req)));
  });

  router.put("/seller/store", ...auth, async (req, res) => {
    res.json(await onboarding.saveDetails(signedInUserId(req), storeDetailsSchema.parse(req.body)));
  });

  router.put("/seller/store/logo", ...auth, async (req, res) => {
    res.json(await onboarding.setLogo(signedInUserId(req), logoSchema.parse(req.body).publicId));
  });

  router.delete("/seller/store/logo", ...auth, async (req, res) => {
    res.json(await onboarding.removeLogo(signedInUserId(req)));
  });

  router.put("/seller/store/verification", ...auth, async (req, res) => {
    res.json(await onboarding.saveVerification(signedInUserId(req), verificationSchema.parse(req.body)));
  });

  router.post("/seller/store/documents", ...auth, async (req, res) => {
    res.json(await onboarding.addDocument(signedInUserId(req), documentSchema.parse(req.body)));
  });

  router.delete("/seller/store/documents/:id", ...auth, async (req, res) => {
    res.json(await onboarding.removeDocument(signedInUserId(req), documentIdSchema.parse(req.params).id));
  });

  router.put("/seller/store/payout-account", ...auth, async (req, res) => {
    const input = payoutAccountSchema.parse(req.body);
    const claims = req.auth;
    res.json(
      await onboarding.setPayoutAccount(signedInUserId(req), input, {
        ensureConfirmed: () => (claims ? security.requireConfirmed(claims) : Promise.reject(new Error("not signed in"))),
        client: clientInfoFrom(req, config.GEO_HEADERS)
      })
    );
  });

  router.post("/seller/store/submit", ...auth, async (req, res) => {
    res.json(await onboarding.submit(signedInUserId(req)));
  });

  router.post("/seller/uploads", ...auth, async (req, res) => {
    res.json({ upload: await onboarding.uploadTicket(signedInUserId(req), uploadTicketSchema.parse(req.body).purpose) });
  });

  return router;
}
