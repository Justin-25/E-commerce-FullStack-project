import type { PrismaClient, StoreStatus } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";

export type { StoreStatus };

export interface SellerStore {
  id: string;
  name: string;
  status: StoreStatus;
  shipsFrom: string | null;
}

const forbidden = (reason: string, message: string) => new AppError(403, "FORBIDDEN", message, { details: { reason } });

/**
 * Seller Center's door, checked in the database on every request (a role in an old access
 * pass isn't enough): a seller account with a submitted store and two-step verification on.
 * `write` also refuses a suspended or rejected store (it can look, not change).
 */
export async function sellerStore(prisma: PrismaClient, userId: string, { write }: { write: boolean }): Promise<SellerStore> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { role: true, twoFactorEnabledAt: true, store: { select: { id: true, name: true, status: true, shipsFrom: true } } }
  });
  if (user.role === "ADMIN") throw forbidden("admin_account", "Admin accounts can't sell.");
  const store = user.store;
  if (user.role !== "SELLER" || !store || store.status === "DRAFT") throw forbidden("not_a_seller", "Open your store first: finish the steps and submit it for review.");
  if (!user.twoFactorEnabledAt) throw forbidden("two_factor_required", "Turn on two-step verification to use Seller Center.");
  if (write && store.status === "SUSPENDED") throw forbidden("store_suspended", "This store is suspended. Contact Vendora support.");
  if (write && store.status === "REJECTED") throw forbidden("store_rejected", "This application was rejected. Contact Vendora support if you think it's a mistake.");
  return store;
}
