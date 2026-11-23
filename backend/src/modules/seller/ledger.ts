import type { Prisma } from "../../generated/prisma/client.js";
import { earningsAvailableAt } from "../orders/deadlines.js";

type Tx = Prisma.TransactionClient;

export interface DeliveredPackage {
  id: string;
  storeId: string;
  subtotalCentavos: number;
  platformFeeCentavos: number;
}

/**
 * The earnings ledger: a store's money is the sum of its lines, never a single balance number
 * that's overwritten (every peso can be traced to an order, and a mistake is fixed with a new
 * line, not by editing history).
 *
 * A delivered package earns two lines: the sale (+ the items' subtotal) and Vendora's fee (−5%,
 * none in a store's first 30 days), both available for payout 7 days after delivery. The
 * delivery fee isn't the seller's: Vendora pays the couriers with it. A unique index allows one
 * SALE and one FEE per package, so a package can never be credited twice.
 */
export async function creditDelivery(tx: Tx, pkg: DeliveredPackage, orderNumber: string, deliveredAt: Date): Promise<void> {
  const availableAt = earningsAvailableAt(deliveredAt);
  const base = { storeId: pkg.storeId, sellerOrderId: pkg.id, availableAt };
  if (pkg.subtotalCentavos > 0) await tx.ledgerEntry.create({ data: { ...base, type: "SALE", amountCentavos: pkg.subtotalCentavos, description: `Sale · ${orderNumber}` } });
  if (pkg.platformFeeCentavos > 0) await tx.ledgerEntry.create({ data: { ...base, type: "FEE", amountCentavos: -pkg.platformFeeCentavos, description: `Vendora fee · ${orderNumber}` } });
}
