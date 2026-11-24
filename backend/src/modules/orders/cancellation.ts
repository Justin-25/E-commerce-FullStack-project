import type { CancelReason, CancelledBy, PrismaClient } from "../../generated/prisma/client.js";
import { BackgroundMailer } from "../../lib/backgroundMailer.js";
import type { EmailSender } from "../../lib/email.js";
import { AppError } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import { orderCancelWarningEmail, orderCancelledForSellerEmail, orderLateEmail } from "../seller/seller.emails.js";
import { closeOrderIfDone } from "./closing.js";
import { AUTO_CANCEL_DAYS, CANCEL_WARNING_DAYS, autoCancelAt, buyerCancelUntil } from "./deadlines.js";
import { packageCancelledEmail } from "./orders.emails.js";
import { recordRefund, type RefundService } from "./refunds.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Packages handled per step of the job (every 15 minutes); the rest wait for the next run. */
export const CANCEL_JOB_BATCH = 100;

/**
 * Cancelling a package that's paid but not shipped: by the seller (with a reason), by the buyer
 * within an hour of paying, or automatically 3 days after its ship-by time. The seller is warned
 * twice before that: when it becomes late, and the day before.
 *
 * One transaction per package: it's cancelled only if it's still "to ship" (checked in the same
 * statement, so a cancel and a "Mark as shipped" at the same moment can't both win), the stock
 * goes back (or to 0 for "out of stock": the seller just said it isn't there), the refund is
 * recorded (online payments) or the cash to collect goes down (cash on delivery), and the order
 * closes once nothing's left on its way. The refund is sent right after.
 */
export class CancellationService {
  private readonly mailer: BackgroundMailer;

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      refunds: RefundService;
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

  /** Cancels one package (see the class comment). False when it wasn't "to ship" any more. */
  async cancelPackage(packageId: string, by: CancelledBy, reason: CancelReason): Promise<boolean> {
    const { prisma } = this.deps;
    const now = this.now();
    const result = await prisma.$transaction(
      async (tx) => {
        const pkg = await tx.sellerOrder.findUnique({ where: { id: packageId }, select: { orderId: true } });
        if (!pkg) return null;
        // The order first, like checkout, payments and delivery: the order closes exactly once.
        await tx.$queryRaw`SELECT 1 FROM orders WHERE id = ${pkg.orderId}::uuid FOR UPDATE`;
        const won = await tx.sellerOrder.updateMany({
          where: { id: packageId, status: "PREPARING" },
          data: { status: "CANCELLED", cancelledAt: now, cancelledBy: by, cancelReason: reason }
        });
        if (won.count !== 1) return null;
        const so = await tx.sellerOrder.findUniqueOrThrow({
          where: { id: packageId },
          include: { items: { select: { variantId: true, productId: true, quantity: true } }, order: { select: { paymentMethod: true } } }
        });

        // Stock: back on the shelf, in variant id order (like checkout) so two changes can't deadlock.
        const qty = new Map<string, number>();
        for (const i of so.items) qty.set(i.variantId, (qty.get(i.variantId) ?? 0) + i.quantity);
        for (const variantId of [...qty.keys()].sort()) {
          await tx.productVariant.update({ where: { id: variantId }, data: reason === "OUT_OF_STOCK" ? { stock: 0 } : { stock: { increment: qty.get(variantId) ?? 0 } } });
        }
        for (const i of so.items) await tx.product.update({ where: { id: i.productId }, data: { soldCount: { decrement: i.quantity } } });

        // Money: what this package cost the buyer (its items and its delivery fee).
        const amount = so.subtotalCentavos + so.deliveryCentavos;
        let refundId: string | null = null;
        if (so.order.paymentMethod === "COD") {
          const cod = await tx.payment.findFirst({ where: { orderId: so.orderId, method: "COD", status: "PENDING" }, select: { id: true, amountCentavos: true } });
          if (cod && cod.amountCentavos > amount) await tx.payment.update({ where: { id: cod.id }, data: { amountCentavos: cod.amountCentavos - amount } });
        } else {
          const paid = await tx.payment.findFirst({ where: { orderId: so.orderId, provider: "PAYMONGO", status: "PAID" }, select: { id: true } });
          if (paid && amount > 0) refundId = await recordRefund(tx, { paymentId: paid.id, sellerOrderId: so.id, amountCentavos: amount, reason: "PACKAGE_CANCELLED" }, now);
        }
        await closeOrderIfDone(tx, so.orderId, now);
        return { refundId, refundCentavos: so.order.paymentMethod === "COD" ? null : amount };
      },
      { timeout: 30_000, maxWait: 10_000 }
    );
    if (!result) return false;
    await this.tellEveryone(packageId, by, reason, result.refundCentavos);
    if (result.refundId) await this.deps.refunds.send(result.refundId);
    return true;
  }

  /**
   * The buyer's "Cancel order", within an hour of paying: every package not shipped yet is
   * cancelled and refunded (one that already shipped stays on its way).
   */
  async cancelByBuyer(userId: string, orderId: string): Promise<void> {
    const order = await this.deps.prisma.order.findFirst({
      where: { id: orderId, userId },
      select: { status: true, placedAt: true, sellerOrders: { where: { status: "PREPARING" }, select: { id: true } } }
    });
    if (!order) throw new AppError(404, "NOT_FOUND", "This order doesn't exist.");
    if (order.status !== "PLACED" || !order.placedAt) throw new AppError(409, "CONFLICT", "This order can't be cancelled.", { details: { reason: "not_cancellable" } });
    if (this.now() > buyerCancelUntil(order.placedAt)) {
      throw new AppError(409, "CONFLICT", "Orders can be cancelled within an hour of paying. Ask the seller to cancel it instead.", { details: { reason: "cancel_window_over" } });
    }
    if (order.sellerOrders.length === 0) throw new AppError(409, "CONFLICT", "Everything in this order has already shipped.", { details: { reason: "already_shipped" } });
    for (const p of order.sellerOrders) await this.cancelPackage(p.id, "BUYER", "BUYER_CANCELLED");
  }

  /**
   * Background job (every 15 minutes), for packages still "to ship": cancel the ones 3 days past
   * their ship-by time; warn the seller the day before; tell them when one becomes late. Each email
   * goes once per package (claimed with a conditional update, so two runs can't both send it).
   */
  async runDue(): Promise<{ cancelled: number; warned: number; late: number }> {
    const { prisma, logger } = this.deps;
    const now = this.now();
    const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS);

    let cancelled = 0;
    const overdue = await prisma.sellerOrder.findMany({ where: { status: "PREPARING", shipBy: { lte: daysAgo(AUTO_CANCEL_DAYS) } }, select: { id: true }, orderBy: { shipBy: "asc" }, take: CANCEL_JOB_BATCH });
    for (const p of overdue) {
      try {
        if (await this.cancelPackage(p.id, "SYSTEM", "NOT_SHIPPED_IN_TIME")) cancelled++;
      } catch (err) {
        logger?.error({ err, packageId: p.id }, "the automatic cancel failed; will retry on the next run");
      }
    }

    const warn = async (kind: "warning" | "late", where: { shipBy: { lte: Date; gt: Date } }) => {
      const flag = kind === "warning" ? "cancelWarnedAt" : "lateNotifiedAt";
      const due = await prisma.sellerOrder.findMany({
        where: { status: "PREPARING", [flag]: null, ...where },
        select: { id: true, shipBy: true, order: { select: { orderNumber: true } }, store: { select: { owner: { select: { email: true } } } } },
        take: CANCEL_JOB_BATCH
      });
      let sent = 0;
      for (const p of due) {
        const won = await prisma.sellerOrder.updateMany({ where: { id: p.id, status: "PREPARING", [flag]: null }, data: { [flag]: now } });
        if (won.count !== 1 || !p.shipBy) continue;
        const info = { id: p.id, number: `VD-${p.order.orderNumber}`, cancelAt: autoCancelAt(p.shipBy) };
        this.mailer.send(kind === "warning" ? orderCancelWarningEmail(p.store.owner.email, info, this.deps.appUrl) : orderLateEmail(p.store.owner.email, info, this.deps.appUrl));
        sent++;
      }
      return sent;
    };
    // The day before the cancel; and "late" only while that warning isn't due yet (no two emails at once).
    const warned = await warn("warning", { shipBy: { lte: daysAgo(CANCEL_WARNING_DAYS), gt: daysAgo(AUTO_CANCEL_DAYS) } });
    const late = await warn("late", { shipBy: { lte: now, gt: daysAgo(CANCEL_WARNING_DAYS) } });
    return { cancelled, warned, late };
  }

  /** The buyer always hears why; the seller hears when it wasn't their own doing. */
  private async tellEveryone(packageId: string, by: CancelledBy, reason: CancelReason, refundCentavos: number | null) {
    const so = await this.deps.prisma.sellerOrder.findUniqueOrThrow({
      where: { id: packageId },
      include: {
        store: { select: { name: true, owner: { select: { email: true } } } },
        order: { select: { id: true, orderNumber: true, paymentMethod: true, user: { select: { email: true } } } },
        items: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { productTitle: true, variantName: true, quantity: true } }
      }
    });
    const number = `VD-${so.order.orderNumber}`;
    this.mailer.send(
      packageCancelledEmail(
        so.order.user.email,
        {
          orderId: so.order.id,
          number,
          storeName: so.store.name,
          reason,
          items: so.items.map((i) => ({ title: i.productTitle, variantName: i.variantName, quantity: i.quantity })),
          refundCentavos,
          paymentMethod: so.order.paymentMethod
        },
        this.deps.appUrl
      )
    );
    if (by !== "SELLER") this.mailer.send(orderCancelledForSellerEmail(so.store.owner.email, { id: so.id, number, by }, this.deps.appUrl));
  }
}
