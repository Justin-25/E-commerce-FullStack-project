import type { DeliveryConfirmation, PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import { creditDelivery } from "../seller/ledger.js";
import { closeOrderIfDone } from "./closing.js";
import { AUTO_CONFIRM_DAYS } from "./deadlines.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Packages confirmed per run of the job (every 15 minutes); the rest wait for the next run. */
export const AUTO_CONFIRM_PER_RUN = 200;

/**
 * Delivery is confirmed by the buyer ("Order received" on the tracking page) or, if they don't,
 * automatically 7 days after shipping (how Shopee and Lazada work: sellers can't mark their own
 * packages delivered, and there's no courier integration to ask).
 *
 * Confirming does three things in ONE transaction, so they can't get out of step:
 * 1. the package becomes DELIVERED (only if it's still SHIPPED, so two confirmations at once,
 *    say the buyer's tap and the job, can't both count);
 * 2. the seller is credited in the ledger (the sale and Vendora's fee);
 * 3. when no package of the order is still on its way, the order is COMPLETED and a cash-on-
 *    delivery payment counts as paid (the courier collected it).
 */
export class DeliveryService {
  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      logger?: Logger;
      now?: () => Date;
    }
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  /** "Order received". Pressing it again (or after the automatic confirmation) changes nothing. */
  async confirmReceived(userId: string, orderId: string, packageId: string): Promise<void> {
    const pkg = await this.deps.prisma.sellerOrder.findFirst({ where: { id: packageId, orderId, order: { userId } }, select: { status: true } });
    if (!pkg) throw new AppError(404, "NOT_FOUND", "This package doesn't exist.");
    if (pkg.status === "SHIPPED" && (await this.deliver(packageId, this.now(), "BUYER"))) return;
    const now = await this.deps.prisma.sellerOrder.findUniqueOrThrow({ where: { id: packageId }, select: { status: true } });
    if (now.status === "DELIVERED" || now.status === "RETURN_REQUESTED" || now.status === "RETURNED") return;
    throw new AppError(409, "CONFLICT", "You can confirm a package once the seller has shipped it.", { details: { reason: "not_shipped" } });
  }

  /** Background job (every 15 minutes): packages shipped 7+ days ago are confirmed automatically. */
  async confirmDue(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - AUTO_CONFIRM_DAYS * DAY_MS);
    const due = await this.deps.prisma.sellerOrder.findMany({
      where: { status: "SHIPPED", shippedAt: { lte: cutoff } },
      select: { id: true, shippedAt: true },
      orderBy: { shippedAt: "asc" },
      take: AUTO_CONFIRM_PER_RUN
    });
    let confirmed = 0;
    for (const p of due) {
      try {
        // Delivered "as of" the end of the 7 days, so a late run doesn't push the payout date back.
        const at = new Date((p.shippedAt ?? cutoff).getTime() + AUTO_CONFIRM_DAYS * DAY_MS);
        if (await this.deliver(p.id, at, "AUTO")) confirmed++;
      } catch (err) {
        this.deps.logger?.error({ err, packageId: p.id }, "confirming a delivery failed; will retry on the next run");
      }
    }
    return confirmed;
  }

  /** Marks one package delivered (see the class comment). False if it wasn't SHIPPED any more. */
  async deliver(packageId: string, at: Date, by: DeliveryConfirmation): Promise<boolean> {
    return this.deps.prisma.$transaction(async (tx) => {
      const pkg = await tx.sellerOrder.findUnique({ where: { id: packageId }, select: { orderId: true } });
      if (!pkg) return false;
      // The order first (like checkout and payments), so two packages of one order delivered at
      // the same moment are counted one after the other and the order is completed exactly once.
      await tx.$queryRaw`SELECT 1 FROM orders WHERE id = ${pkg.orderId}::uuid FOR UPDATE`;
      const won = await tx.sellerOrder.updateMany({ where: { id: packageId, status: "SHIPPED" }, data: { status: "DELIVERED", deliveredAt: at, deliveryConfirmedBy: by } });
      if (won.count !== 1) return false;

      const done = await tx.sellerOrder.findUniqueOrThrow({
        where: { id: packageId },
        select: { id: true, storeId: true, subtotalCentavos: true, platformFeeCentavos: true, order: { select: { orderNumber: true } } }
      });
      await creditDelivery(tx, done, `VD-${done.order.orderNumber}`, at);

      await closeOrderIfDone(tx, pkg.orderId, at);
      return true;
    });
  }
}
