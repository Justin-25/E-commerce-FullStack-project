import { Router, type Request, type RequestHandler } from "express";
import { privateNoStore } from "../../lib/httpCache.js";
import { signedInUserId, type AuthGuards } from "../../middleware/auth.js";
import type { SecurityService } from "../auth/security.service.js";
import {
  applicationListSchema,
  approveSchema,
  documentParamsSchema,
  markFailedSchema,
  markPaidSchema,
  markRefundedSchema,
  payoutIdSchema,
  payoutListSchema,
  refundIdSchema,
  refundListSchema,
  reviewNoteSchema,
  storeIdSchema
} from "./admin.schemas.js";
import type { ApplicationService } from "./applications.service.js";
import type { AdminDashboardService } from "./dashboard.service.js";
import type { MoneyService } from "./money.service.js";

/**
 * The admin pages (milestone 7). Signed in, never cached; changes are CSRF-checked app-wide.
 * Each service checks the admin and their role in the database. Looking at sensitive data (a full
 * TIN, a private document, a payout account number) is a POST: it's recorded in the audit log.
 */
export function adminRouter({
  dashboard,
  applications,
  money,
  security,
  guards
}: {
  dashboard: AdminDashboardService;
  applications: ApplicationService;
  money: MoneyService;
  security: Pick<SecurityService, "requireConfirmed">;
  guards: AuthGuards;
}): Router {
  const router = Router();
  const live: RequestHandler = (_req, res, next) => {
    privateNoStore(res);
    next();
  };
  const auth = [...guards.requireAuth, live];
  const ip = (req: Request) => req.ip ?? null;
  /** "Confirm it's you" (re-authentication, milestone 3) before actions that decide where money goes. */
  const confirmed = (req: Request) => () => (req.auth ? security.requireConfirmed(req.auth) : Promise.reject(new Error("not signed in")));

  router.get("/admin/dashboard", ...auth, async (req, res) => {
    res.json(await dashboard.view(signedInUserId(req)));
  });

  // --- seller approvals (Support) ---

  router.get("/admin/applications", ...auth, async (req, res) => {
    res.json(await applications.list(signedInUserId(req), applicationListSchema.parse(req.query)));
  });

  router.get("/admin/applications/:storeId", ...auth, async (req, res) => {
    res.json({ application: await applications.view(signedInUserId(req), storeIdSchema.parse(req.params).storeId) });
  });

  router.post("/admin/applications/:storeId/tin", ...auth, async (req, res) => {
    res.json(await applications.revealTin(signedInUserId(req), storeIdSchema.parse(req.params).storeId, ip(req)));
  });

  router.post("/admin/applications/:storeId/documents/:documentId/link", ...auth, async (req, res) => {
    const { storeId, documentId } = documentParamsSchema.parse(req.params);
    res.json(await applications.documentLink(signedInUserId(req), storeId, documentId, ip(req)));
  });

  router.post("/admin/applications/:storeId/approve", ...auth, async (req, res) => {
    const { storeId } = storeIdSchema.parse(req.params);
    const input = approveSchema.parse(req.body);
    res.json({ application: await applications.approve(signedInUserId(req), storeId, input, { ensureConfirmed: confirmed(req), ip: ip(req) }) });
  });

  router.post("/admin/applications/:storeId/request-changes", ...auth, async (req, res) => {
    const { storeId } = storeIdSchema.parse(req.params);
    res.json({ application: await applications.requestChanges(signedInUserId(req), storeId, reviewNoteSchema.parse(req.body).note, ip(req)) });
  });

  router.post("/admin/applications/:storeId/reject", ...auth, async (req, res) => {
    const { storeId } = storeIdSchema.parse(req.params);
    res.json({ application: await applications.reject(signedInUserId(req), storeId, reviewNoteSchema.parse(req.body).note, ip(req)) });
  });

  // --- payout accounts changed after approval (Support) ---

  router.get("/admin/payout-accounts", ...auth, async (req, res) => {
    res.json(await applications.payoutAccounts(signedInUserId(req)));
  });

  router.post("/admin/payout-accounts/:storeId/number", ...auth, async (req, res) => {
    res.json(await applications.revealPayoutNumber(signedInUserId(req), storeIdSchema.parse(req.params).storeId, ip(req)));
  });

  router.post("/admin/payout-accounts/:storeId/verify", ...auth, async (req, res) => {
    const { storeId } = storeIdSchema.parse(req.params);
    res.json(await applications.verifyPayoutAccount(signedInUserId(req), storeId, { ensureConfirmed: confirmed(req), ip: ip(req) }));
  });

  // --- payouts & refunds (Finance, milestone 7b) ---

  router.get("/admin/payouts", ...auth, async (req, res) => {
    res.json(await money.payouts(signedInUserId(req), payoutListSchema.parse(req.query)));
  });

  router.post("/admin/payouts/:payoutId/account", ...auth, async (req, res) => {
    res.json(await money.payoutAccount(signedInUserId(req), payoutIdSchema.parse(req.params).payoutId, ip(req)));
  });

  router.post("/admin/payouts/:payoutId/paid", ...auth, async (req, res) => {
    const { payoutId } = payoutIdSchema.parse(req.params);
    const { transferReference } = markPaidSchema.parse(req.body);
    res.json(await money.markPayoutPaid(signedInUserId(req), payoutId, transferReference, { ensureConfirmed: confirmed(req), ip: ip(req) }));
  });

  router.post("/admin/payouts/:payoutId/failed", ...auth, async (req, res) => {
    const { payoutId } = payoutIdSchema.parse(req.params);
    const { reason } = markFailedSchema.parse(req.body);
    res.json(await money.markPayoutFailed(signedInUserId(req), payoutId, reason, { ensureConfirmed: confirmed(req), ip: ip(req) }));
  });

  router.get("/admin/refunds", ...auth, async (req, res) => {
    res.json(await money.refunds(signedInUserId(req), refundListSchema.parse(req.query)));
  });

  router.post("/admin/refunds/:refundId/retry", ...auth, async (req, res) => {
    const { refundId } = refundIdSchema.parse(req.params);
    res.json(await money.retryRefund(signedInUserId(req), refundId, { ensureConfirmed: confirmed(req), ip: ip(req) }));
  });

  router.post("/admin/refunds/:refundId/refunded", ...auth, async (req, res) => {
    const { refundId } = refundIdSchema.parse(req.params);
    const input = markRefundedSchema.parse(req.body);
    res.json(await money.markRefunded(signedInUserId(req), refundId, input, { ensureConfirmed: confirmed(req), ip: ip(req) }));
  });

  return router;
}
