import type { PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import { isUniqueViolation } from "../../lib/prismaErrors.js";

export const REPORT_REASONS = ["COUNTERFEIT", "MISLEADING", "PROHIBITED", "MISSING_PERMIT", "OFFENSIVE", "OTHER"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
/** What the shopper picks in the "Report this listing" Modal (and what Moderation reads). */
export const REPORT_REASON_LABEL: Record<ReportReason, string> = {
  COUNTERFEIT: "Counterfeit or fake",
  MISLEADING: "Photos or description don't match",
  PROHIBITED: "Prohibited item",
  MISSING_PERMIT: "Missing permit (e.g. FDA registration)",
  OFFENSIVE: "Offensive",
  OTHER: "Something else"
};
/** Reports one shopper can send in 24 hours (all listings together). */
export const REPORTS_PER_DAY = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * "Report this listing" (milestone 7d): any signed-in shopper, about a listing shoppers can see. They pick a
 * reason, may add a message, and may attach one of their own orders with this item (so Moderation sees
 * which reports come from buyers). One open report per listing per shopper (a partial unique index makes
 * a double click or two tabs count once), at most 10 a day, never about their own store's listing.
 */
export class ReportService {
  constructor(private readonly deps: { prisma: PrismaClient; now?: () => Date }) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  async report(userId: string, productId: string, input: { reason: ReportReason; message: string | null; orderId: string | null }): Promise<{ reported: true }> {
    const { prisma } = this.deps;
    const product = await prisma.product.findFirst({ where: { id: productId, status: "ACTIVE", store: { status: "APPROVED" } }, select: { id: true, store: { select: { ownerId: true } } } });
    if (!product) throw new AppError(404, "NOT_FOUND", "This listing isn't available.");
    if (product.store.ownerId === userId) throw new AppError(409, "CONFLICT", "You can't report your own listing.", { details: { reason: "own_listing" } });
    if (input.orderId) {
      const bought = await prisma.orderItem.findFirst({ where: { productId, sellerOrder: { order: { id: input.orderId, userId, placedAt: { not: null } } } }, select: { id: true } });
      if (!bought) throw new AppError(400, "VALIDATION_ERROR", "Some fields are invalid", { fields: [{ path: "orderId", message: "Choose one of your orders with this item." }] });
    }
    const now = this.now();
    const today = await prisma.productFlag.count({ where: { reporterId: userId, createdAt: { gt: new Date(now.getTime() - DAY_MS) } } });
    if (today >= REPORTS_PER_DAY) {
      throw new AppError(429, "RATE_LIMITED", `You've sent ${REPORTS_PER_DAY} reports today. Please try again tomorrow.`, { details: { reason: "too_many_reports" } });
    }
    try {
      await prisma.productFlag.create({ data: { productId, source: "BUYER_REPORT", reason: input.reason, message: input.message, reporterId: userId, orderId: input.orderId, createdAt: now } });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, "CONFLICT", "You've already reported this listing. We'll look into it.", { details: { reason: "already_reported" } });
      throw err;
    }
    return { reported: true };
  }
}
