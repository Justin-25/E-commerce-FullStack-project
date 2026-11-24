import type { Prisma } from "../../generated/prisma/client.js";

type Tx = Prisma.TransactionClient;

/**
 * After a package is delivered or cancelled: once no package of the order is still on its way,
 * the order is finished. With at least one package delivered it's COMPLETED and a cash-on-delivery
 * payment counts as paid (the courier collected it); with every package cancelled it's CANCELLED
 * and there's nothing to collect. Call it inside the transaction that changed the package, with the
 * order row locked (so two packages finishing at the same moment are counted one after the other).
 */
export async function closeOrderIfDone(tx: Tx, orderId: string, at: Date): Promise<void> {
  const open = await tx.sellerOrder.count({ where: { orderId, status: { in: ["AWAITING_PAYMENT", "PREPARING", "SHIPPED"] } } });
  if (open > 0) return;
  const delivered = await tx.sellerOrder.count({ where: { orderId, status: { in: ["DELIVERED", "RETURN_REQUESTED", "RETURNED"] } } });
  if (delivered > 0) {
    await tx.order.updateMany({ where: { id: orderId, status: "PLACED" }, data: { status: "COMPLETED" } });
    await tx.payment.updateMany({ where: { orderId, method: "COD", status: "PENDING" }, data: { status: "PAID", paidAt: at } });
  } else {
    await tx.order.updateMany({ where: { id: orderId, status: "PLACED" }, data: { status: "CANCELLED", cancelledAt: at } });
    await tx.payment.updateMany({ where: { orderId, method: "COD", status: "PENDING" }, data: { status: "EXPIRED", failureReason: "Order cancelled before delivery" } });
  }
}
