import type { PayoutStatus, Prisma, PrismaClient, RefundStatus } from "../../generated/prisma/client.js";
import { createFieldCipher, type FieldCipher } from "../../lib/encryption.js";
import { AppError } from "../../lib/errors.js";
import { likeLiteral } from "../../lib/like.js";
import type { ByHand, RefundService } from "../orders/refunds.js";
import type { PayoutService } from "../seller/payouts.service.js";
import { adminUser } from "./access.js";
import { ADMIN_PAGE_SIZE, type PayoutListQuery, type PayoutTab, type RefundListQuery, type RefundTab } from "./admin.schemas.js";
import { audit } from "./audit.js";

const PAYOUT_STATUS: Record<PayoutTab, PayoutStatus> = { in_progress: "PROCESSING", failed: "FAILED", paid: "PAID" };
const REFUND_STATUS: Record<RefundTab, RefundStatus> = { needs_person: "FAILED", retrying: "PENDING", sent: "SENT" };
const payoutContext = (storeId: string) => `store:${storeId}:payout`;
const conflict = (reason: string, message: string) => new AppError(409, "CONFLICT", message, { details: { reason } });
const payoutNotFound = () => new AppError(404, "NOT_FOUND", "This payout doesn't exist.");
const refundNotFound = () => new AppError(404, "NOT_FOUND", "This refund doesn't exist.");
const notProcessing = () => conflict("not_processing", "This payout isn't in progress any more (it was marked paid or failed). Reload to see it.");
const paymentsOff = () => new AppError(503, "SERVICE_UNAVAILABLE", "Online payments aren't set up (no PayMongo key), so PayMongo can't be asked.");

const PAYOUT_INCLUDE = {
  store: { select: { id: true, name: true, slug: true, payoutAccount: { select: { method: true, last4: true, verifiedAt: true } } } },
  handledBy: { select: { name: true } }
} satisfies Prisma.PayoutInclude;
type PayoutRow = Prisma.PayoutGetPayload<{ include: typeof PAYOUT_INCLUDE }>;

const REFUND_INCLUDE = {
  payment: { select: { method: true, order: { select: { id: true, orderNumber: true, user: { select: { name: true, email: true } } } } } },
  sellerOrder: { select: { store: { select: { name: true } } } },
  handledBy: { select: { name: true } }
} satisfies Prisma.RefundInclude;
type RefundRow = Prisma.RefundGetPayload<{ include: typeof REFUND_INCLUDE }>;

/** The seller's account isn't the one this payout was made for (changed since, or not checked yet). */
const accountChanged = (p: { method: string; accountLast4: string; store: { payoutAccount: { method: string; last4: string; verifiedAt: Date | null } | null } }) => {
  const a = p.store.payoutAccount;
  return !a || a.method !== p.method || a.last4 !== p.accountLast4 || !a.verifiedAt;
};

/**
 * Admin → Payouts & refunds (milestone 7b, Finance role). Every money action asks "Confirm it's you"
 * first and is written to the audit log in the same transaction as the change.
 *
 * Payouts: Finance transfers the money (bank or GCash) and marks the payout paid with the transfer's
 * reference, or failed with a reason (the money goes back to the seller's balance). "Show account"
 * reveals the full number for the transfer (logged), but never an account the seller changed after
 * the payout was made: that payout is marked failed and paid again once Support verified the new one.
 *
 * Refunds PayMongo kept refusing: "Try again now", or "Mark as refunded" with the id of a refund
 * made in PayMongo's dashboard (checked with PayMongo) or another transfer's reference.
 */
export class MoneyService {
  private readonly cipher: FieldCipher;

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      payouts: PayoutService;
      refunds: RefundService;
      config: { DATA_ENCRYPTION_KEY: string };
    }
  ) {
    this.cipher = createFieldCipher(deps.config.DATA_ENCRYPTION_KEY);
  }

  // --- payouts --------------------------------------------------------------------

  async payouts(adminId: string, query: PayoutListQuery) {
    const { prisma } = this.deps;
    await adminUser(prisma, adminId, "FINANCE");
    const search: Prisma.PayoutWhereInput = query.q
      ? { OR: [{ reference: { contains: likeLiteral(query.q.toUpperCase()) } }, { store: { name: { contains: likeLiteral(query.q), mode: "insensitive" } } }] }
      : {};
    const where: Prisma.PayoutWhereInput = { AND: [{ status: PAYOUT_STATUS[query.tab] }, search] };
    const orderBy: Prisma.PayoutOrderByWithRelationInput[] =
      query.tab === "in_progress" ? [{ createdAt: "asc" }, { id: "asc" }] : query.tab === "paid" ? [{ paidAt: "desc" }, { id: "desc" }] : [{ updatedAt: "desc" }, { id: "desc" }];
    const count = (tab: PayoutTab) => prisma.payout.count({ where: { status: PAYOUT_STATUS[tab] } });
    const [rows, totalItems, inProgress, failed, paid, owed] = await Promise.all([
      prisma.payout.findMany({ where, orderBy, skip: (query.page - 1) * ADMIN_PAGE_SIZE, take: ADMIN_PAGE_SIZE, include: PAYOUT_INCLUDE }),
      prisma.payout.count({ where }),
      count("in_progress"),
      count("failed"),
      count("paid"),
      prisma.payout.aggregate({ where: { status: "PROCESSING" }, _sum: { amountCentavos: true } })
    ]);
    return {
      items: rows.map((p) => this.payoutItem(p)),
      counts: { inProgress, failed, paid },
      inProgressCentavos: owed._sum.amountCentavos ?? 0,
      page: query.page,
      pageSize: ADMIN_PAGE_SIZE,
      totalItems,
      totalPages: Math.ceil(totalItems / ADMIN_PAGE_SIZE)
    };
  }

  private payoutItem(p: PayoutRow) {
    return {
      id: p.id,
      reference: p.reference,
      status: p.status,
      store: { id: p.store.id, name: p.store.name, slug: p.store.slug },
      amountCentavos: p.amountCentavos,
      orders: p.orderCount,
      method: p.method,
      accountLast4: p.accountLast4,
      /** In progress only: the seller's account changed since (don't transfer; mark it failed). */
      accountChanged: p.status === "PROCESSING" && accountChanged(p),
      createdAt: p.createdAt.toISOString(),
      paidAt: p.paidAt?.toISOString() ?? null,
      transferReference: p.transferReference,
      failureReason: p.failureReason,
      handledBy: p.handledBy?.name ?? null
    };
  }

  private async payoutView(payoutId: string) {
    return this.payoutItem(await this.deps.prisma.payout.findUniqueOrThrow({ where: { id: payoutId }, include: PAYOUT_INCLUDE }));
  }

  /** "Show account": where to send the money. Each look is logged; a changed account is never shown for an older payout. */
  async payoutAccount(adminId: string, payoutId: string, ip: string | null) {
    const { prisma } = this.deps;
    const admin = await adminUser(prisma, adminId, "FINANCE");
    const payout = await prisma.payout.findUnique({ where: { id: payoutId }, include: { store: { select: { id: true, payoutAccount: true } } } });
    if (!payout) throw payoutNotFound();
    if (payout.status !== "PROCESSING") throw notProcessing();
    const account = payout.store.payoutAccount;
    if (!account || accountChanged({ ...payout, store: { payoutAccount: account } })) {
      throw conflict("account_changed", "The seller changed their payout account after this payout was made. Don't transfer: mark it failed, and it's paid again to the new account once Support has checked it.");
    }
    const accountNumber = this.cipher.decrypt(account.accountNumberEncrypted, payoutContext(payout.store.id));
    await audit(prisma, { actorId: admin.id, action: "payout.view_account", targetType: "payout", targetId: payout.id, metadata: { reference: payout.reference, storeId: payout.store.id, last4: account.last4 }, ip });
    return { account: { method: account.method, bankName: account.bankName, accountName: account.accountName, accountNumber } };
  }

  /** "Mark paid" with the transfer's reference. */
  async markPayoutPaid(adminId: string, payoutId: string, transferReference: string, ctx: { ensureConfirmed: () => Promise<void>; ip: string | null }) {
    const admin = await this.payoutToHandle(adminId, payoutId);
    await ctx.ensureConfirmed();
    const result = await this.deps.payouts.markPaid(payoutId, { adminId: admin.id, transferReference, ip: ctx.ip });
    if (result === "not_found") throw payoutNotFound();
    if (result === "not_processing") throw notProcessing();
    return { payout: await this.payoutView(payoutId) };
  }

  /** "Mark failed": the money is back in the seller's balance for the next payout. */
  async markPayoutFailed(adminId: string, payoutId: string, reason: string, ctx: { ensureConfirmed: () => Promise<void>; ip: string | null }) {
    const admin = await this.payoutToHandle(adminId, payoutId);
    await ctx.ensureConfirmed();
    const result = await this.deps.payouts.markFailed(payoutId, reason, { adminId: admin.id, ip: ctx.ip });
    if (result === "not_found") throw payoutNotFound();
    if (result === "not_processing") throw notProcessing();
    return { payout: await this.payoutView(payoutId) };
  }

  private async payoutToHandle(adminId: string, payoutId: string) {
    const admin = await adminUser(this.deps.prisma, adminId, "FINANCE");
    const payout = await this.deps.prisma.payout.findUnique({ where: { id: payoutId }, select: { status: true } });
    if (!payout) throw payoutNotFound();
    if (payout.status !== "PROCESSING") throw notProcessing();
    return admin;
  }

  // --- refunds --------------------------------------------------------------------

  async refunds(adminId: string, query: RefundListQuery) {
    const { prisma } = this.deps;
    await adminUser(prisma, adminId, "FINANCE");
    const number = query.q?.toUpperCase().match(/^(?:VD-?)?(\d{1,9})$/)?.[1];
    const search: Prisma.RefundWhereInput = query.q
      ? number
        ? { payment: { order: { orderNumber: Number(number) } } }
        : { payment: { order: { user: { email: { contains: likeLiteral(query.q.toLowerCase()) } } } } }
      : {};
    const where: Prisma.RefundWhereInput = { AND: [{ status: REFUND_STATUS[query.tab] }, search] };
    const orderBy: Prisma.RefundOrderByWithRelationInput[] =
      query.tab === "sent" ? [{ sentAt: "desc" }, { id: "desc" }] : query.tab === "retrying" ? [{ nextAttemptAt: "asc" }, { id: "asc" }] : [{ createdAt: "asc" }, { id: "asc" }];
    const count = (tab: RefundTab) => prisma.refund.count({ where: { status: REFUND_STATUS[tab] } });
    const [rows, totalItems, needsPerson, retrying, sent] = await Promise.all([
      prisma.refund.findMany({ where, orderBy, skip: (query.page - 1) * ADMIN_PAGE_SIZE, take: ADMIN_PAGE_SIZE, include: REFUND_INCLUDE }),
      prisma.refund.count({ where }),
      count("needs_person"),
      count("retrying"),
      count("sent")
    ]);
    return {
      items: rows.map((r) => this.refundItem(r)),
      counts: { needsPerson, retrying, sent },
      page: query.page,
      pageSize: ADMIN_PAGE_SIZE,
      totalItems,
      totalPages: Math.ceil(totalItems / ADMIN_PAGE_SIZE)
    };
  }

  private refundItem(r: RefundRow) {
    const order = r.payment.order;
    return {
      id: r.id,
      order: { id: order.id, number: `VD-${order.orderNumber}` },
      buyer: { name: order.user.name, email: order.user.email },
      store: r.sellerOrder?.store.name ?? null,
      amountCentavos: r.amountCentavos,
      reason: r.reason,
      paymentMethod: r.payment.method,
      status: r.status,
      attempts: r.attempts,
      lastError: r.lastError,
      createdAt: r.createdAt.toISOString(),
      nextAttemptAt: r.nextAttemptAt?.toISOString() ?? null,
      sentAt: r.sentAt?.toISOString() ?? null,
      sentVia: r.sentVia,
      providerRefundId: r.providerRefundId,
      manualReference: r.manualReference,
      handledBy: r.handledBy?.name ?? null
    };
  }

  private async refundView(refundId: string) {
    return this.refundItem(await this.deps.prisma.refund.findUniqueOrThrow({ where: { id: refundId }, include: REFUND_INCLUDE }));
  }

  /** "Try again now": one try right away (never alongside the job, never after an unrecorded PayMongo refund). */
  async retryRefund(adminId: string, refundId: string, ctx: { ensureConfirmed: () => Promise<void>; ip: string | null }) {
    const { prisma } = this.deps;
    const admin = await adminUser(prisma, adminId, "FINANCE");
    const refund = await prisma.refund.findUnique({ where: { id: refundId }, select: { status: true } });
    if (!refund) throw refundNotFound();
    if (refund.status === "SENT") throw conflict("already_sent", "This refund was already sent. Reload to see it.");
    await ctx.ensureConfirmed();
    const result = await this.deps.refunds.retryNow(refundId, { adminId: admin.id, ip: ctx.ip });
    if (typeof result === "object") {
      throw new AppError(503, "SERVICE_UNAVAILABLE", `PayMongo didn't answer the check of what was already refunded (${result.checkFailed}), so nothing was sent. Try again later.`);
    }
    switch (result) {
      case "not_found":
        throw refundNotFound();
      case "already_sent":
        throw conflict("already_sent", "This refund was already sent. Reload to see it.");
      case "busy":
        throw conflict("busy", "This refund is being tried right now. Reload in a minute or two to see how it went.");
      case "changed":
        throw conflict("changed", "This refund changed meanwhile. Reload and check it again.");
      case "unrecorded":
        throw conflict("unrecorded_refund", "PayMongo shows a refund on this payment that we never recorded (maybe made in PayMongo's dashboard). If it's this one, use Mark as refunded with its id instead.");
      case "payments_off":
        throw paymentsOff();
      default:
        return { result, refund: await this.refundView(refundId) };
    }
  }

  /** "Mark as refunded": a refund made in PayMongo's dashboard (checked with PayMongo) or another transfer. */
  async markRefunded(adminId: string, refundId: string, input: ByHand, ctx: { ensureConfirmed: () => Promise<void>; ip: string | null }) {
    const { prisma } = this.deps;
    const admin = await adminUser(prisma, adminId, "FINANCE");
    const refund = await prisma.refund.findUnique({ where: { id: refundId }, select: { status: true } });
    if (!refund) throw refundNotFound();
    if (refund.status === "SENT") throw conflict("already_sent", "This refund was already sent. Reload to see it.");
    if (refund.status !== "FAILED") throw conflict("not_failed", "This refund is still being retried automatically. Wait until it needs a person, or use Try again now.");
    await ctx.ensureConfirmed();
    const result = await this.deps.refunds.markSentByHand(refundId, input, { adminId: admin.id, ip: ctx.ip });
    if (typeof result === "object") {
      throw new AppError(400, "VALIDATION_ERROR", "Some fields are invalid", { fields: [{ path: "providerRefundId", message: result.invalid }] });
    }
    switch (result) {
      case "not_found":
        throw refundNotFound();
      case "already_sent":
        throw conflict("already_sent", "This refund was already sent. Reload to see it.");
      case "not_failed":
        throw conflict("not_failed", "This refund changed meanwhile. Reload and check it again.");
      case "payments_off":
        throw paymentsOff();
      default:
        return { refund: await this.refundView(refundId) };
    }
  }
}
