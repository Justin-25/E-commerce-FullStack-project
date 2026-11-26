import type { PrismaClient } from "../../generated/prisma/client.js";
import { audit } from "../admin/audit.js";

/**
 * Approving a submitted store: it goes live for shoppers, its documents count as checked and
 * its payout account as verified. Only a PENDING store can be approved. The reviewer, the time
 * and an optional note are kept on the store, and the audit log gets a row in the same transaction.
 *
 * Called by the admin screen (milestone 7a, which also emails the seller) and by
 * `npm run store:approve -- <store-web-address>` (reviewer null: a command on the server).
 */
export async function approveStore(
  prisma: PrismaClient,
  slug: string,
  reviewerId: string | null,
  now = new Date(),
  extra: { note?: string | null; ip?: string | null } = {}
): Promise<"approved" | "not_pending" | "not_found"> {
  return prisma.$transaction(async (tx) => {
    const store = await tx.store.findUnique({ where: { slug }, select: { id: true, status: true } });
    if (!store) return "not_found";
    const moved = await tx.store.updateMany({
      where: { id: store.id, status: "PENDING" },
      data: { status: "APPROVED", approvedAt: now, reviewedAt: now, reviewedById: reviewerId, reviewNote: extra.note ?? null }
    });
    if (moved.count !== 1) return "not_pending";
    await tx.storeDocument.updateMany({ where: { storeId: store.id, status: "PENDING" }, data: { status: "VERIFIED", reviewedAt: now, reviewedById: reviewerId } });
    await tx.payoutAccount.updateMany({ where: { storeId: store.id, verifiedAt: null }, data: { verifiedAt: now } });
    await audit(tx, { actorId: reviewerId, action: "store.approve", targetType: "store", targetId: store.id, metadata: { via: reviewerId ? "admin" : "command", note: extra.note ?? null }, ip: extra.ip ?? null });
    return "approved";
  });
}
