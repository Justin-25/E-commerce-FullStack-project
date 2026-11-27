import type { Prisma, PrismaClient, RefundReason } from "../../generated/prisma/client.js";
import { BackgroundMailer } from "../../lib/backgroundMailer.js";
import type { EmailSender } from "../../lib/email.js";
import type { Logger } from "../../lib/logger.js";
import type { PaymentGateway, ProviderRefund, RefundReasonCode } from "../../lib/paymongo.js";
import { isUniqueViolation } from "../../lib/prismaErrors.js";
import { audit } from "../admin/audit.js";
import { paymentRefundedEmail, refundDelayedEmail, refundSentByHandEmail, refundSentEmail } from "./orders.emails.js";

type Tx = Prisma.TransactionClient;
const HOUR_MS = 60 * 60 * 1000;
/** A refund PayMongo refuses is tried again an hour later... */
export const REFUND_RETRY_MS = HOUR_MS;
/** ...for 3 days; then a person refunds it by hand (Admin → Payouts & refunds, milestone 7b). */
export const REFUND_GIVE_UP_MS = 3 * 24 * HOUR_MS;
/** Refunds tried per run of the job (every 15 minutes). */
export const REFUNDS_PER_RUN = 50;

const peso = (centavos: number) => `₱${(centavos / 100).toLocaleString("en-PH", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/** How a Finance admin closed a refund PayMongo kept refusing. */
export type ByHand = { via: "PAYMONGO_DASHBOARD"; providerRefundId: string } | { via: "OTHER_TRANSFER"; reference: string; note: string | null };
export type RetryResult = "sent" | "still_failing" | "not_found" | "already_sent" | "busy" | "changed" | "unrecorded" | "payments_off" | { checkFailed: string };
/** A retrying refund changed this recently may be in the middle of a try (PayMongo calls time out well before). */
export const IN_FLIGHT_MS = 2 * 60 * 1000;
export type ByHandResult = "sent" | "not_found" | "already_sent" | "not_failed" | "payments_off" | { invalid: string };

const REFUND_INCLUDE = {
  payment: { select: { id: true, providerPaymentId: true, method: true, amountCentavos: true, order: { select: { id: true, orderNumber: true, user: { select: { email: true } } } } } },
  sellerOrder: { select: { cancelledBy: true, store: { select: { name: true } } } }
} satisfies Prisma.RefundInclude;
type LoadedRefund = Prisma.RefundGetPayload<{ include: typeof REFUND_INCLUDE }>;

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
 * sent instead of sent again; if PayMongo shows a refund we never recorded (someone refunded in
 * PayMongo's dashboard), it stops and waits for a person. PayMongo refusing (a test account's low
 * balance, an outage) is retried every hour for 3 days; after that it's FAILED, "needs a person".
 *
 * Milestone 7b: a Finance admin can "Try again now", or close a FAILED refund by hand.
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
    const now = this.now();
    const claimed = await this.deps.prisma.$queryRaw<{ attempts: number }[]>`
      UPDATE refunds SET attempts = attempts + 1, "nextAttemptAt" = ${new Date(now.getTime() + REFUND_RETRY_MS)}, "updatedAt" = ${now}
      WHERE id = ${refundId}::uuid AND status = 'PENDING' AND "nextAttemptAt" <= ${now}
      RETURNING attempts`;
    const attempt = claimed[0];
    if (!attempt) return "skipped";
    return this.attempt(refundId, attempt.attempts, { gaveUpBefore: false });
  }

  /**
   * "Try again now" (milestone 7b): one try right away at a refund that's retrying or gave up. PayMongo's
   * list of the payment's refunds is checked first: one we never recorded stops it ("unrecorded"), so
   * the shopper can't be refunded twice. The claim is conditional on what was read (status and
   * attempts), so two admins, or an admin and the job, can't both send it; it's audited with the claim.
   * Failing again puts it back where it was, without a second "delayed" email.
   */
  async retryNow(refundId: string, by: { adminId: string; ip: string | null }): Promise<RetryResult> {
    const { prisma, gateway } = this.deps;
    const refund = await prisma.refund.findUnique({
      where: { id: refundId },
      select: { id: true, status: true, attempts: true, updatedAt: true, payment: { select: { id: true, providerPaymentId: true } } }
    });
    if (!refund) return "not_found";
    if (refund.status === "SENT") return "already_sent";
    const now = this.now();
    // The job may be in the middle of a try (it claimed it moments ago): never send at the same time.
    if (refund.status === "PENDING" && refund.updatedAt.getTime() > now.getTime() - IN_FLIGHT_MS) return "busy";
    if (!gateway || !refund.payment.providerPaymentId) return "payments_off";
    // Never send without knowing what PayMongo already refunded on this payment.
    let atPayMongo: ProviderRefund[];
    try {
      atPayMongo = await gateway.listRefunds(refund.payment.providerPaymentId);
    } catch (err) {
      this.deps.logger?.warn({ err, refundId }, "Try again now: PayMongo's list of refunds couldn't be read");
      return { checkFailed: String(err instanceof Error ? err.message : err).slice(0, 200) };
    }
    if ((await this.unrecorded(refund.payment.id, atPayMongo)).length) return "unrecorded";
    const wasFailed = refund.status === "FAILED";
    const attempt = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ attempts: number }[]>`
        UPDATE refunds SET status = 'PENDING', attempts = attempts + 1, "nextAttemptAt" = ${new Date(now.getTime() + REFUND_RETRY_MS)}, "updatedAt" = ${now}
        WHERE id = ${refundId}::uuid AND status = ${refund.status}::"RefundStatus" AND attempts = ${refund.attempts}
        RETURNING attempts`;
      const claimed = rows[0];
      if (!claimed) return null;
      await audit(tx, { actorId: by.adminId, action: "refund.retry", targetType: "refund", targetId: refundId, metadata: { attempt: claimed.attempts, wasFailed }, ip: by.ip });
      return claimed.attempts;
    });
    if (attempt === null) return "changed";
    return (await this.attempt(refundId, attempt, { gaveUpBefore: wasFailed })) === "sent" ? "sent" : "still_failing";
  }

  /**
   * "Mark as refunded" (milestone 7b) for a refund PayMongo kept refusing: a refund the admin made in
   * PayMongo's dashboard (its id is checked with PayMongo: this payment, this amount, not failed, not
   * recorded for another refund), or another transfer with its reference. Only a FAILED refund (a
   * retrying one could be sent by the job at the same moment). The shopper gets the email the
   * "delayed" one promised; the change and its audit row are one transaction.
   */
  async markSentByHand(refundId: string, input: ByHand, by: { adminId: string; ip: string | null }): Promise<ByHandResult> {
    const { prisma, gateway } = this.deps;
    const refund = await prisma.refund.findUnique({ where: { id: refundId }, include: REFUND_INCLUDE });
    if (!refund) return "not_found";
    if (refund.status === "SENT") return "already_sent";
    if (refund.status !== "FAILED") return "not_failed";
    if (input.via === "PAYMONGO_DASHBOARD") {
      if (!gateway || !refund.payment.providerPaymentId) return "payments_off";
      let atPayMongo: ProviderRefund[];
      try {
        atPayMongo = await gateway.listRefunds(refund.payment.providerPaymentId);
      } catch (err) {
        return { invalid: `PayMongo couldn't be asked about this payment's refunds (${String(err instanceof Error ? err.message : err).slice(0, 120)}). Try again later.` };
      }
      const found = atPayMongo.find((r) => r.id === input.providerRefundId);
      if (!found) return { invalid: `PayMongo has no refund ${input.providerRefundId} on this order's payment.` };
      if (found.status === "failed") return { invalid: "That refund failed at PayMongo, so the money didn't go back." };
      if (found.amountCentavos !== refund.amountCentavos) return { invalid: `That refund is ${peso(found.amountCentavos)}; this one is ${peso(refund.amountCentavos)}.` };
      if (found.metadata.vendoraRefundId && found.metadata.vendoraRefundId !== refund.id) return { invalid: "That PayMongo refund belongs to another Vendora refund." };
      if (await prisma.refund.findFirst({ where: { providerRefundId: input.providerRefundId }, select: { id: true } })) {
        return { invalid: "That PayMongo refund is already recorded for another refund." };
      }
    }
    const now = this.now();
    let done: boolean;
    try {
      done = await prisma.$transaction(async (tx) => {
        const won = await tx.refund.updateMany({
          where: { id: refund.id, status: "FAILED" },
          data: {
            status: "SENT",
            sentAt: now,
            sentVia: input.via,
            providerRefundId: input.via === "PAYMONGO_DASHBOARD" ? input.providerRefundId : null,
            manualReference: input.via === "OTHER_TRANSFER" ? input.reference : null,
            handledById: by.adminId,
            lastError: null,
            nextAttemptAt: null
          }
        });
        if (won.count !== 1) return false;
        await this.closePaymentIfAllBack(tx, refund);
        await audit(tx, {
          actorId: by.adminId,
          action: "refund.mark_sent",
          targetType: "refund",
          targetId: refund.id,
          metadata:
            input.via === "PAYMONGO_DASHBOARD"
              ? { via: input.via, providerRefundId: input.providerRefundId, amountCentavos: refund.amountCentavos, order: `VD-${refund.payment.order.orderNumber}` }
              : { via: input.via, reference: input.reference, note: input.note, amountCentavos: refund.amountCentavos, order: `VD-${refund.payment.order.orderNumber}` },
          ip: by.ip
        });
        return true;
      });
    } catch (err) {
      // The same PayMongo refund recorded for another refund at the same moment (unique index).
      if (isUniqueViolation(err)) return { invalid: "That PayMongo refund is already recorded for another refund." };
      throw err;
    }
    if (!done) return "not_failed";
    if (input.via === "OTHER_TRANSFER") {
      const order = refund.payment.order;
      this.mailer.send(refundSentByHandEmail(order.user.email, { orderId: order.id, number: `VD-${order.orderNumber}`, amountCentavos: refund.amountCentavos, reference: input.reference }, this.deps.appUrl));
    } else {
      this.notifySent(refund);
    }
    return "sent";
  }

  /** One try at a claimed refund (by the job or "Try again now"). */
  private async attempt(refundId: string, attempt: number, opts: { gaveUpBefore: boolean }): Promise<"sent" | "retry" | "failed"> {
    const { prisma, gateway, logger } = this.deps;
    const now = this.now();
    const refund = await prisma.refund.findUniqueOrThrow({ where: { id: refundId }, include: REFUND_INCLUDE });
    const order = refund.payment.order;
    const number = `VD-${order.orderNumber}`;
    try {
      if (!gateway) throw new Error("online payments are off (no PayMongo key)");
      const paymentId = refund.payment.providerPaymentId;
      if (!paymentId) throw new Error("the payment has no PayMongo payment id");
      // A retry: did an earlier try go through, with only its answer lost? Or did someone refund in PayMongo's dashboard?
      const atPayMongo = attempt > 1 ? await gateway.listRefunds(paymentId) : [];
      const earlier = atPayMongo.find((r) => r.metadata.vendoraRefundId === refund.id);
      if (!earlier) {
        const unknown = await this.unrecorded(refund.payment.id, atPayMongo);
        if (unknown.length) return await this.stopForPerson(refund, `PayMongo shows a refund we didn't record (${unknown.map((r) => r.id).join(", ")}): check it, then close this by hand`, opts);
      }
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
        const done = await tx.refund.updateMany({
          where: { id: refund.id, status: "PENDING" },
          data: { status: "SENT", sentVia: "PAYMONGO_API", providerRefundId: sent.id, sentAt: now, lastError: null, nextAttemptAt: null }
        });
        if (done.count !== 1) return false; // already recorded: nothing more to do (and no second email)
        await this.closePaymentIfAllBack(tx, refund);
        return true;
      });
      if (!recorded) return "retry";
      this.notifySent(refund);
      return "sent";
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err).slice(0, 255);
      // 3 days of tries, or a manual try at one that had already given up: back to "needs a person".
      const giveUp = opts.gaveUpBefore || now.getTime() - refund.createdAt.getTime() >= REFUND_GIVE_UP_MS;
      if (giveUp) return this.stopForPerson(refund, message, opts, err);
      await prisma.refund.updateMany({ where: { id: refund.id, status: "PENDING" }, data: { lastError: message } });
      logger?.warn({ err, refundId: refund.id, orderId: order.id, attempt }, "a refund failed; it will be tried again in an hour");
      return "retry";
    }
  }

  /** No more automatic tries: FAILED, "needs a person". The shopper is told once (not again after a manual retry). */
  private async stopForPerson(refund: LoadedRefund, reason: string, opts: { gaveUpBefore: boolean }, err?: unknown): Promise<"failed" | "retry"> {
    const order = refund.payment.order;
    const changed = await this.deps.prisma.refund.updateMany({ where: { id: refund.id, status: "PENDING" }, data: { status: "FAILED", lastError: reason.slice(0, 255), nextAttemptAt: null } });
    if (changed.count !== 1) return "retry";
    this.deps.logger?.error({ err, refundId: refund.id, orderId: order.id, reason }, "a refund needs a person: close it in Admin → Payouts & refunds");
    if (!opts.gaveUpBefore) this.mailer.send(refundDelayedEmail(order.user.email, { orderId: order.id, number: `VD-${order.orderNumber}`, amountCentavos: refund.amountCentavos }, this.deps.appUrl));
    return "failed";
  }

  /** PayMongo refunds on this payment that aren't ours (no Vendora id in their metadata) and that we never recorded. */
  private async unrecorded(paymentId: string, atPayMongo: ProviderRefund[]): Promise<ProviderRefund[]> {
    const candidates = atPayMongo.filter((r) => r.status !== "failed" && !r.metadata.vendoraRefundId);
    if (!candidates.length) return [];
    const ours = await this.deps.prisma.refund.findMany({ where: { paymentId, providerRefundId: { in: candidates.map((r) => r.id) } }, select: { providerRefundId: true } });
    const known = new Set(ours.map((r) => r.providerRefundId));
    return candidates.filter((r) => !known.has(r.id));
  }

  /** All of the payment is back with the shopper: the payment counts as refunded. */
  private async closePaymentIfAllBack(tx: Tx, refund: LoadedRefund) {
    const back = await tx.refund.aggregate({ where: { paymentId: refund.payment.id, status: "SENT" }, _sum: { amountCentavos: true } });
    if ((back._sum.amountCentavos ?? 0) >= refund.payment.amountCentavos) {
      await tx.payment.update({ where: { id: refund.payment.id }, data: { status: "REFUNDED", ...(refund.reason === "PACKAGE_CANCELLED" ? {} : { failureReason: WHOLE_NOTE[refund.reason] }) } });
    }
  }

  /** The money went back to the shopper's GCash, Maya or card (by our call, or a refund made in PayMongo's dashboard). */
  private notifySent(refund: LoadedRefund) {
    const order = refund.payment.order;
    const number = `VD-${order.orderNumber}`;
    const to = order.user.email;
    if (refund.reason === "PACKAGE_CANCELLED") {
      this.mailer.send(
        refundSentEmail(to, { orderId: order.id, number, storeName: refund.sellerOrder?.store.name ?? "the seller", amountCentavos: refund.amountCentavos, paymentMethod: refund.payment.method }, this.deps.appUrl)
      );
    } else {
      this.mailer.send(paymentRefundedEmail(to, number, refund.amountCentavos, refund.reason === "DUPLICATE_PAYMENT" ? "duplicate" : "out_of_stock"));
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
