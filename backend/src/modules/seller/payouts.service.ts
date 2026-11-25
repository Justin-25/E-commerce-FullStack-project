import { randomInt } from "node:crypto";
import type { LedgerType, PayoutMethod, PrismaClient } from "../../generated/prisma/client.js";
import { BackgroundMailer } from "../../lib/backgroundMailer.js";
import { toCsv } from "../../lib/csv.js";
import type { EmailSender } from "../../lib/email.js";
import { AppError } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import { isUniqueViolation } from "../../lib/prismaErrors.js";
import { lastPayoutTime, manilaMonth, manilaMonthStart, nextPayoutTime } from "../orders/deadlines.js";
import { sellerStore } from "./access.js";
import { payoutFailedEmail, payoutPaidEmail, payoutStartedEmail } from "./seller.emails.js";

/** Payouts need at least ₱100 available. */
export const MIN_PAYOUT_CENTAVOS = 10_000;
export const PAYOUTS_PAGE_SIZE = 20;
const HOUR_MS = 60 * 60 * 1000;

export type CannotPayOut = "no_account" | "account_not_verified" | "in_progress" | "below_minimum" | "store_not_approved";
const REASON: Record<CannotPayOut, string> = {
  no_account: "Add a payout account first.",
  account_not_verified: "Your payout account is being checked. Payouts start once it's verified.",
  in_progress: "A payout is already on its way. You can request the next one once it's paid.",
  below_minimum: "Payouts start from ₱100 available.",
  store_not_approved: "Payouts start once your store is approved."
};

const TYPE_NAME: Record<LedgerType, string> = { SALE: "Sale", FEE: "Vendora fee", REFUND: "Refund", PAYOUT: "Payout", ADJUSTMENT: "Adjustment" };
const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const manilaStamp = (d: Date | null) => (d ? new Date(d.getTime() + 8 * HOUR_MS).toISOString().slice(0, 16).replace("T", " ") : null);
const percentChange = (now: number, before: number) => (before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : null);

/** "PO-2026-1123-K4Q2": the payout's Philippine date and 4 random characters (unique per payout). */
export function payoutReference(at: Date): string {
  const day = new Date(at.getTime() + 8 * HOUR_MS).toISOString().slice(0, 10);
  const random = Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `PO-${day.slice(0, 4)}-${day.slice(5, 7)}${day.slice(8, 10)}-${random}`;
}

/**
 * Seller payouts (milestone 6d). A store's money is its ledger: a payout takes every line that's
 * available and not paid out yet, links them to the payout and adds one PAYOUT line taking that
 * total out, all in one transaction with the store row locked. So a line can never be paid twice,
 * and a partial unique index allows one payout in progress per store, even across servers.
 *
 * Automatic every Monday at 9:00 AM (Manila), or "Request payout" any time, from ₱100, only to a
 * verified payout account. The transfer itself is simulated until milestone 7: `npm run payout:paid`
 * or `payout:failed`. A failed payout gives its lines back (a new ADJUSTMENT line balances the
 * PAYOUT line), so the money is available again; history is never edited.
 */
export class PayoutService {
  private readonly mailer: BackgroundMailer;

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
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

  // --- the Payouts page -------------------------------------------------------------

  async view(userId: string, page: number) {
    const { prisma } = this.deps;
    const store = await sellerStore(prisma, userId, { write: false });
    const now = this.now();
    const month = manilaMonth(now);
    const monthStart = manilaMonthStart(month);
    const previousMonthStart = manilaMonthStart(manilaMonth(new Date(monthStart.getTime() - HOUR_MS)));

    const [lines, notDelivered, paidThisMonth, paidLastMonth, account, inProgress, totalItems, payouts] = await Promise.all([
      prisma.$queryRaw<{ available: bigint; onHold: bigint; onHoldOrders: number }[]>`
        SELECT coalesce(sum("amountCentavos") FILTER (WHERE "availableAt" <= ${now}), 0)::bigint AS available,
               coalesce(sum("amountCentavos") FILTER (WHERE "availableAt" > ${now}), 0)::bigint AS "onHold",
               count(DISTINCT "sellerOrderId") FILTER (WHERE "availableAt" > ${now})::int AS "onHoldOrders"
        FROM ledger_entries WHERE "storeId" = ${store.id}::uuid AND "payoutId" IS NULL`,
      prisma.$queryRaw<{ net: bigint; orders: number }[]>`
        SELECT coalesce(sum(so."subtotalCentavos" - so."platformFeeCentavos"), 0)::bigint AS net, count(*)::int AS orders
        FROM seller_orders so JOIN orders o ON o.id = so."orderId"
        WHERE so."storeId" = ${store.id}::uuid AND so.status IN ('PREPARING', 'SHIPPED') AND o."placedAt" IS NOT NULL`,
      prisma.payout.aggregate({ where: { storeId: store.id, status: "PAID", paidAt: { gte: monthStart } }, _sum: { amountCentavos: true } }),
      prisma.payout.aggregate({ where: { storeId: store.id, status: "PAID", paidAt: { gte: previousMonthStart, lt: monthStart } }, _sum: { amountCentavos: true } }),
      prisma.payoutAccount.findUnique({ where: { storeId: store.id } }),
      prisma.payout.findFirst({ where: { storeId: store.id, status: "PROCESSING" }, select: { id: true } }),
      prisma.payout.count({ where: { storeId: store.id } }),
      prisma.payout.findMany({ where: { storeId: store.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * PAYOUTS_PAGE_SIZE, take: PAYOUTS_PAGE_SIZE })
    ]);
    const l = lines[0];
    const nd = notDelivered[0];
    const available = Number(l?.available ?? 0);
    const paidNow = paidThisMonth._sum.amountCentavos ?? 0;
    const paidBefore = paidLastMonth._sum.amountCentavos ?? 0;
    const cannot = this.cannotPayOut(store.status, account, Boolean(inProgress), available);

    return {
      available: { centavos: available },
      /** Delivered and on hold for 7 days, plus paid orders not delivered yet (what the seller will get from them). */
      waiting: { centavos: Number(l?.onHold ?? 0) + Number(nd?.net ?? 0), orders: (l?.onHoldOrders ?? 0) + (nd?.orders ?? 0) },
      paidThisMonth: { month, centavos: paidNow, previousCentavos: paidBefore, change: percentChange(paidNow, paidBefore) },
      account: account
        ? { method: account.method, bankName: account.bankName, accountName: account.accountName, last4: account.last4, verified: account.verifiedAt !== null, verifiedAt: account.verifiedAt?.toISOString() ?? null }
        : null,
      schedule: { nextAutomaticAt: nextPayoutTime(now).toISOString(), minimumCentavos: MIN_PAYOUT_CENTAVOS },
      canRequest: cannot === null,
      cannotRequest: cannot ? { reason: cannot, message: REASON[cannot] } : null,
      history: {
        items: payouts.map((p) => ({
          id: p.id,
          reference: p.reference,
          status: p.status,
          createdAt: p.createdAt.toISOString(),
          paidAt: p.paidAt?.toISOString() ?? null,
          failureReason: p.failureReason,
          orders: p.orderCount,
          grossCentavos: p.grossCentavos,
          feesCentavos: p.feesCentavos,
          amountCentavos: p.amountCentavos,
          method: p.method,
          accountLast4: p.accountLast4
        })),
        page,
        pageSize: PAYOUTS_PAGE_SIZE,
        totalItems,
        totalPages: Math.ceil(totalItems / PAYOUTS_PAGE_SIZE)
      }
    };
  }

  private cannotPayOut(storeStatus: string, account: { verifiedAt: Date | null } | null, inProgress: boolean, available: number): CannotPayOut | null {
    if (storeStatus !== "APPROVED") return "store_not_approved";
    if (!account) return "no_account";
    if (!account.verifiedAt) return "account_not_verified";
    if (inProgress) return "in_progress";
    if (available < MIN_PAYOUT_CENTAVOS) return "below_minimum";
    return null;
  }

  // --- making a payout ----------------------------------------------------------------

  /** "Request payout". */
  async request(userId: string) {
    const store = await sellerStore(this.deps.prisma, userId, { write: true });
    const result = await this.pay(store.id);
    if (!result.paid) throw new AppError(409, "CONFLICT", REASON[result.reason], { details: { reason: result.reason } });
    return this.view(userId, 1);
  }

  /**
   * Background job (every 15 minutes): from Monday 9:00 AM (Manila), each store that hasn't had a payout
   * since then and had at least ₱100 available at 9:00 AM. A missed run catches up later in the week.
   */
  async runWeekly(): Promise<number> {
    const { prisma, logger } = this.deps;
    const now = this.now();
    const since = lastPayoutTime(now);
    const due = await prisma.$queryRaw<{ id: string }[]>`
      SELECT s.id FROM stores s
      JOIN payout_accounts a ON a."storeId" = s.id AND a."verifiedAt" IS NOT NULL
      WHERE s.status = 'APPROVED'
        AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p."storeId" = s.id AND (p.status = 'PROCESSING' OR p."createdAt" >= ${since}))
        -- what was available at 9:00 AM Monday (money released later in the week waits for next Monday)
        AND (SELECT coalesce(sum(l."amountCentavos"), 0) FROM ledger_entries l WHERE l."storeId" = s.id AND l."payoutId" IS NULL AND l."availableAt" <= ${since}) >= ${MIN_PAYOUT_CENTAVOS}
      ORDER BY s.id`;
    let paid = 0;
    for (const { id } of due) {
      try {
        if ((await this.pay(id)).paid) paid++;
      } catch (err) {
        logger?.error({ err, storeId: id }, "the Monday payout failed for a store; it's tried again on the next run");
      }
    }
    return paid;
  }

  /** One payout of everything available (see the class comment). */
  private async pay(storeId: string): Promise<{ paid: true; reference: string } | { paid: false; reason: CannotPayOut }> {
    const { prisma } = this.deps;
    const now = this.now();
    let made: { id: string; reference: string; amountCentavos: number; method: PayoutMethod; accountLast4: string; storeName: string; ownerEmail: string };
    try {
      const result = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM stores WHERE id = ${storeId}::uuid FOR UPDATE`;
        const store = await tx.store.findUniqueOrThrow({ where: { id: storeId }, select: { status: true, name: true, owner: { select: { email: true } }, payoutAccount: true } });
        const inProgress = await tx.payout.findFirst({ where: { storeId, status: "PROCESSING" }, select: { id: true } });
        const lines = await tx.$queryRaw<{ id: string; type: LedgerType; sellerOrderId: string | null; amountCentavos: number }[]>`
          SELECT id, type, "sellerOrderId", "amountCentavos" FROM ledger_entries
          WHERE "storeId" = ${storeId}::uuid AND "payoutId" IS NULL AND "availableAt" <= ${now}
          ORDER BY id FOR UPDATE`;
        const total = lines.reduce((s, x) => s + x.amountCentavos, 0);
        const cannot = this.cannotPayOut(store.status, store.payoutAccount, Boolean(inProgress), total);
        if (cannot) return { paid: false as const, reason: cannot };
        const account = store.payoutAccount as NonNullable<typeof store.payoutAccount>;
        const sum = (type: LedgerType) => lines.filter((x) => x.type === type).reduce((s, x) => s + x.amountCentavos, 0);
        const payout = await tx.payout.create({
          data: {
            storeId,
            reference: payoutReference(now),
            amountCentavos: total,
            method: account.method,
            accountLast4: account.last4,
            orderCount: new Set(lines.filter((x) => x.type === "SALE").map((x) => x.sellerOrderId)).size,
            grossCentavos: sum("SALE"),
            feesCentavos: -sum("FEE"),
            createdAt: now
          }
        });
        await tx.ledgerEntry.updateMany({ where: { id: { in: lines.map((x) => x.id) } }, data: { payoutId: payout.id } });
        await tx.ledgerEntry.create({ data: { storeId, payoutId: payout.id, type: "PAYOUT", amountCentavos: -total, description: `Payout ${payout.reference}`, availableAt: now, createdAt: now } });
        return { paid: true as const, payout: { ...payout, storeName: store.name, ownerEmail: store.owner.email } };
      });
      if (!result.paid) return result;
      made = result.payout;
    } catch (err) {
      // Another payout was made at the very same moment (the one-in-progress index decided).
      if (isUniqueViolation(err)) return { paid: false, reason: "in_progress" };
      throw err;
    }
    this.mailer.send(payoutStartedEmail(made.ownerEmail, made.storeName, made, this.deps.appUrl));
    return { paid: true, reference: made.reference };
  }

  // --- the transfer (simulated until milestone 7) ---------------------------------------

  /** The money arrived. */
  async markPaid(reference: string): Promise<"paid" | "not_processing" | "not_found"> {
    const { prisma } = this.deps;
    const payout = await prisma.payout.findUnique({ where: { reference }, include: { store: { select: { name: true, owner: { select: { email: true } } } } } });
    if (!payout) return "not_found";
    const won = await prisma.payout.updateMany({ where: { id: payout.id, status: "PROCESSING" }, data: { status: "PAID", paidAt: this.now() } });
    if (won.count !== 1) return "not_processing";
    this.mailer.send(payoutPaidEmail(payout.store.owner.email, payout.store.name, payout, this.deps.appUrl));
    return "paid";
  }

  /** The transfer failed: its lines are available again, balanced by a new line (history is never edited). */
  async markFailed(reference: string, reason: string): Promise<"failed" | "not_processing" | "not_found"> {
    const { prisma } = this.deps;
    const now = this.now();
    const payout = await prisma.payout.findUnique({ where: { reference }, include: { store: { select: { name: true, owner: { select: { email: true } } } } } });
    if (!payout) return "not_found";
    const done = await prisma.$transaction(async (tx) => {
      const won = await tx.payout.updateMany({ where: { id: payout.id, status: "PROCESSING" }, data: { status: "FAILED", failureReason: reason.slice(0, 255) } });
      if (won.count !== 1) return false;
      await tx.ledgerEntry.updateMany({ where: { payoutId: payout.id, type: { not: "PAYOUT" } }, data: { payoutId: null } });
      await tx.ledgerEntry.create({
        data: { storeId: payout.storeId, payoutId: payout.id, type: "ADJUSTMENT", amountCentavos: payout.amountCentavos, description: `Payout ${payout.reference} failed: back in your balance`, availableAt: now, createdAt: now }
      });
      return true;
    });
    if (!done) return "not_processing";
    this.mailer.send(payoutFailedEmail(payout.store.owner.email, payout.store.name, { ...payout, reason }, this.deps.appUrl));
    return "failed";
  }

  // --- Download statements ------------------------------------------------------------

  /** Every ledger line of one month ("2026-11", Philippine time) as a spreadsheet. */
  async statement(userId: string, month: string): Promise<{ filename: string; csv: string }> {
    const { prisma } = this.deps;
    const store = await sellerStore(prisma, userId, { write: false });
    const from = manilaMonthStart(month);
    const next = new Date(from.getTime() + 32 * 24 * HOUR_MS);
    const to = manilaMonthStart(manilaMonth(next));
    const lines = await prisma.ledgerEntry.findMany({
      where: { storeId: store.id, createdAt: { gte: from, lt: to } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: { sellerOrder: { select: { order: { select: { orderNumber: true } } } }, payout: { select: { reference: true, status: true } } }
    });
    const csv = toCsv(
      ["Date (PH time)", "Type", "Order", "Description", "Amount (PHP)", "Available from (PH time)", "Payout", "Payout status"],
      lines.map((x) => [
        manilaStamp(x.createdAt),
        TYPE_NAME[x.type],
        x.sellerOrder ? `VD-${x.sellerOrder.order.orderNumber}` : null,
        x.description,
        x.amountCentavos / 100, // a number (never treated as a formula), negative for money out
        manilaStamp(x.availableAt),
        x.payout?.reference ?? null,
        x.payout ? x.payout.status.charAt(0) + x.payout.status.slice(1).toLowerCase() : null
      ])
    );
    return { filename: `vendora-statement-${month}.csv`, csv };
  }
}
