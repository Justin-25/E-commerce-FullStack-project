import type { Prisma, PrismaClient, RefundReason } from "../../generated/prisma/client.js";
import { BackgroundMailer } from "../../lib/backgroundMailer.js";
import type { EmailSender } from "../../lib/email.js";
import type { Logger } from "../../lib/logger.js";
import type { PaymentGateway, RefundReasonCode } from "../../lib/paymongo.js";
import { paymentRefundedEmail, refundDelayedEmail, refundSentEmail } from "./orders.emails.js";

type Tx = Prisma.TransactionClient;
const HOUR_MS = 60 * 60 * 1000;
/** A refund PayMongo refuses is tried again an hour later... */
export const REFUND_RETRY_MS = HOUR_MS;
/** ...for 3 days; then a person refunds it by hand (milestone 7 lists them for admins). */
export const REFUND_GIVE_UP_MS = 3 * 24 * HOUR_MS;
/** Refunds tried per run of the job (every 15 minutes). */
export const REFUNDS_PER_RUN = 50;

/**
 * Records a refund inside the caller's transaction, together with the change that causes it (a
 * cancelled package, a duplicate payment), so the two can't get out of step. The payment row is
 * locked and its refunds added up first: together they never exceed what was paid. It's sent right
 * after the transaction with `RefundService.send`, and retried by the job if that fails.
 */
export async function recordRefund(tx: Tx, r: { paymentId: string; sellerOrderId?: string; amountCentavos: number; reason: RefundReason }, now: Date): Promise<string> {
  await tx.$queryRaw`SELECT 1 FROM payments WHERE id = ${r.paymentId}::uuid FOR UPDATE`;
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: r.paymentId }, select: { amountCentavos: true } });
  const already = await tx.refund.aggregate({ where: { paymentId: r.paymentId }, _sum: { amountCentavos: true } });
  if ((already._sum.amountCentavos ?? 0) + r.amountCentavos > payment.amountCentavos) {
    throw new Error(`refunds for payment ${r.paymentId} would add up to more than was paid`);
  }
  const refund = await tx.refund.create({
    data: { paymentId: r.paymentId, sellerOrderId: r.sellerOrderId ?? null, amountCentavos: r.amountCentavos, reason: r.reason, nextAttemptAt: now }
  });
  return refund.id;
}

/**
 * Sends refunds to PayMongo, and keeps trying until they go through.
 *
 * Never twice: a refund is first "claimed" (a conditional update that also moves its next try an
 * hour ahead), so two runs can't send it at the same moment, and a crash mid-send just means a retry
 * later. Every refund carries our id in PayMongo's metadata, and a retry first lists the payment's
 * refunds at PayMongo: if an earlier try went through (only its answer was lost), it's recorded as
 * sent instead of sent again. PayMongo refusing (a test account's low balance, an outage) is retried
 * every hour for 3 days; after that it's FAILED, "needs a manual refund".
 */
export class RefundService {
  private readonly mailer: BackgroundMailer;

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      /** null = online payments off (no PayMongo key): refunds wait (and fail after 3 days). */
      gateway: PaymentGateway | null;
      email: EmailSender;
      appUrl: string;
      logger?: Logger;
      now?: () => Date;
    }
  ) {
    this.mailer = new BackgroundMailer(deps.email, deps.logger);
  }

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  async drain(): Promise<void> {
    await this.mailer.drain();
  }

  /** Background job (every 15 minutes): refunds due for a try. Returns how many were sent. */
  async sendDue(): Promise<number> {
    const due = await this.deps.prisma.refund.findMany({
      where: { status: "PENDING", nextAttemptAt: { lte: this.now() } },
      select: { id: true },
      orderBy: { nextAttemptAt: "asc" },
      take: REFUNDS_PER_RUN
    });
    let sent = 0;
    for (const r of due) if ((await this.send(r.id)) === "sent") sent++;
    return sent;
  }

  /** One try at one refund. "skipped": not due, or another run has it. */
  async send(refundId: string): Promise<"sent" | "retry" | "failed" | "skipped"> {
    const { prisma, gateway, logger } = this.deps;
    const now = this.now();
    const claimed = await prisma.$queryRaw<{ attempts: number }[]>`
      UPDATE refunds SET attempts = attempts + 1, "nextAttemptAt" = ${new Date(now.getTime() + REFUND_RETRY_MS)}, "updatedAt" = ${now}
      WHERE id = ${refundId}::uuid AND status = 'PENDING' AND "nextAttemptAt" <= ${now}
      RETURNING attempts`;
    const attempt = claimed[0];
    if (!attempt) return "skipped";

    const refund = await prisma.refund.findUniqueOrThrow({
      where: { id: refundId },
      include: {
        payment: { select: { id: true, providerPaymentId: true, method: true, amountCentavos: true, order: { select: { id: true, orderNumber: true, user: { select: { email: true } } } } } },
        sellerOrder: { select: { cancelledBy: true, store: { select: { name: true } } } }
      }
    });
    const order = refund.payment.order;
    const number = `VD-${order.orderNumber}`;
    try {
      if (!gateway) throw new Error("online payments are off (no PayMongo key)");
      const paymentId = refund.payment.providerPaymentId;
      if (!paymentId) throw new Error("the payment has no PayMongo payment id");
      // A retry: did an earlier try go through, with only its answer lost?
      const earlier = attempt.attempts > 1 ? (await gateway.listRefunds(paymentId)).find((r) => r.metadata.vendoraRefundId === refund.id) : undefined;
      const sent =
        earlier ??
        (await gateway.refund({
          paymentId,
          amountCentavos: refund.amountCentavos,
          reason: refund.reason === "DUPLICATE_PAYMENT" ? "duplicate" : providerReason(refund.sellerOrder?.cancelledBy),
          notes: `Vendora ${number}: ${NOTE[refund.reason]}`,
          metadata: { vendoraRefundId: refund.id, orderNumber: number }
        }));
      const recorded = await prisma.$transaction(async (tx) => {
        const done = await tx.refund.updateMany({ where: { id: refund.id, status: "PENDING" }, data: { status: "SENT", providerRefundId: sent.id, sentAt: now, lastError: null, nextAttemptAt: null } });
        if (done.count !== 1) return false; // already recorded: nothing more to do (and no second email)
        // All of the payment is back with the shopper: the payment counts as refunded.
        const back = await tx.refund.aggregate({ where: { paymentId: refund.payment.id, status: "SENT" }, _sum: { amountCentavos: true } });
        if ((back._sum.amountCentavos ?? 0) >= refund.payment.amountCentavos) {
          await tx.payment.update({ where: { id: refund.payment.id }, data: { status: "REFUNDED", ...(refund.reason === "PACKAGE_CANCELLED" ? {} : { failureReason: WHOLE_NOTE[refund.reason] }) } });
        }
        return true;
      });
      if (!recorded) return "skipped";
      const to = order.user.email;
      if (refund.reason === "PACKAGE_CANCELLED") {
        this.mailer.send(
          refundSentEmail(to, { orderId: order.id, number, storeName: refund.sellerOrder?.store.name ?? "the seller", amountCentavos: refund.amountCentavos, paymentMethod: refund.payment.method }, this.deps.appUrl)
        );
      } else {
        this.mailer.send(paymentRefundedEmail(to, number, refund.amountCentavos, refund.reason === "DUPLICATE_PAYMENT" ? "duplicate" : "out_of_stock"));
      }
      return "sent";
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err).slice(0, 255);
      const giveUp = now.getTime() - refund.createdAt.getTime() >= REFUND_GIVE_UP_MS;
      const changed = await prisma.refund.updateMany({
        where: { id: refund.id, status: "PENDING" },
        data: giveUp ? { status: "FAILED", lastError: message, nextAttemptAt: null } : { lastError: message }
      });
      if (giveUp && changed.count === 1) {
        logger?.error({ err, refundId: refund.id, orderId: order.id }, "a refund kept failing for 3 days: refund it by hand in the PayMongo dashboard");
        this.mailer.send(refundDelayedEmail(order.user.email, { orderId: order.id, number, amountCentavos: refund.amountCentavos }, this.deps.appUrl));
        return "failed";
      }
      logger?.warn({ err, refundId: refund.id, orderId: order.id, attempt: attempt.attempts }, "a refund failed; it will be tried again in an hour");
      return "retry";
    }
  }
}

/** PayMongo's reason: the shopper's own cancellation is "requested_by_customer", anything else "others". */
function providerReason(cancelledBy: string | null | undefined): RefundReasonCode {
  return cancelledBy === "BUYER" ? "requested_by_customer" : "others";
}

const NOTE: Record<RefundReason, string> = {
  PACKAGE_CANCELLED: "cancelled package",
  DUPLICATE_PAYMENT: "second payment for a paid order",
  LATE_PAYMENT_SOLD_OUT: "paid after the window, items sold out"
};

const WHOLE_NOTE: Record<Exclude<RefundReason, "PACKAGE_CANCELLED">, string> = {
  DUPLICATE_PAYMENT: "Refunded: second payment for a paid order",
  LATE_PAYMENT_SOLD_OUT: "Refunded: paid after the window, items sold out"
};
