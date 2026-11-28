import { Router } from "express";
import { z } from "zod";
import { privateNoStore } from "../../lib/httpCache.js";
import { signedInUserId, type AuthGuards } from "../../middleware/auth.js";
import { REPORT_REASONS, type ReportService } from "./reports.service.js";

const productIdSchema = z.object({ productId: z.uuid({ error: "Listing not found" }) });
/** The "Report this listing" form. */
export const reportSchema = z.strictObject({
  reason: z.enum(REPORT_REASONS, { error: "Choose what's wrong" }),
  message: z
    .string()
    .trim()
    .max(1000, { error: "Use 1,000 characters or fewer" })
    .optional()
    .transform((v) => v || null),
  orderId: z
    .uuid({ error: "Choose one of your orders with this item" })
    .optional()
    .transform((v) => v ?? null)
});

/** Shoppers' "Report this listing" (milestone 7d): signed in, CSRF-checked app-wide, never cached. */
export function reportsRouter({ reports, guards }: { reports: ReportService; guards: AuthGuards }): Router {
  const router = Router();
  router.post("/products/:productId/report", ...guards.requireAuth, async (req, res) => {
    privateNoStore(res);
    const { productId } = productIdSchema.parse(req.params);
    res.status(201).json(await reports.report(signedInUserId(req), productId, reportSchema.parse(req.body)));
  });
  return router;
}
