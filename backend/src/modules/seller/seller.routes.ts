import { Router, type RequestHandler } from "express";
import type { Config } from "../../config/env.js";
import { privateNoStore } from "../../lib/httpCache.js";
import { signedInUserId, type AuthGuards } from "../../middleware/auth.js";
import { clientInfoFrom } from "../auth/events.js";
import type { SecurityService } from "../auth/security.service.js";
import type { OnboardingService } from "./onboarding.service.js";
import { productIdSchema, productInputSchema, sellerProductListSchema } from "./products.schemas.js";
import type { SellerProductService } from "./products.service.js";
import { documentIdSchema, documentSchema, logoSchema, payoutAccountSchema, storeDetailsSchema, uploadTicketSchema, verificationSchema } from "./seller.schemas.js";

/**
 * Seller Center: becoming a seller (6a) and products (6b). Signed in, never cached; changes
 * are CSRF-checked app-wide. Onboarding changes answer with the whole onboarding state, so
 * the page always shows what's done and what's missing; product changes with the product.
 */
export function sellerRouter({
  onboarding,
  products,
  security,
  guards,
  config
}: {
  onboarding: OnboardingService;
  products: SellerProductService;
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
    const { purpose } = uploadTicketSchema.parse(req.body);
    const userId = signedInUserId(req);
    res.json({ upload: purpose === "product_photo" ? await products.uploadTicket(userId) : await onboarding.uploadTicket(userId, purpose) });
  });

  // --- products (6b) ---

  router.get("/seller/products", ...auth, async (req, res) => {
    res.json(await products.list(signedInUserId(req), sellerProductListSchema.parse(req.query)));
  });

  router.post("/seller/products", ...auth, async (req, res) => {
    res.status(201).json({ product: await products.create(signedInUserId(req), productInputSchema.parse(req.body)) });
  });

  router.get("/seller/products/:id", ...auth, async (req, res) => {
    res.json({ product: await products.view(signedInUserId(req), productIdSchema.parse(req.params).id) });
  });

  router.put("/seller/products/:id", ...auth, async (req, res) => {
    const { id } = productIdSchema.parse(req.params);
    res.json({ product: await products.update(signedInUserId(req), id, productInputSchema.parse(req.body)) });
  });

  router.delete("/seller/products/:id", ...auth, async (req, res) => {
    res.json(await products.remove(signedInUserId(req), productIdSchema.parse(req.params).id));
  });

  return router;
}
