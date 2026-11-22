import type { PrismaClient } from "../../generated/prisma/client.js";

/**
 * Approving a submitted store: it goes live for shoppers, its documents count as checked and
 * its payout account as verified. Only a PENDING store can be approved.
 *
 * Milestone 7's admin screen (with the reviewer, notes and emails) will call this; until then
 * it's run by hand with `npm run store:approve -- <store-web-address>`.
 */
export async function approveStore(prisma: PrismaClient, slug: string, reviewerId: string | null, now = new Date()): Promise<"approved" | "not_pending" | "not_found"> {
  return prisma.$transaction(async (tx) => {
    const store = await tx.store.findUnique({ where: { slug }, select: { id: true, status: true } });
    if (!store) return "not_found";
    const moved = await tx.store.updateMany({ where: { id: store.id, status: "PENDING" }, data: { status: "APPROVED", approvedAt: now } });
    if (moved.count !== 1) return "not_pending";
    await tx.storeDocument.updateMany({ where: { storeId: store.id, status: "PENDING" }, data: { status: "VERIFIED", reviewedAt: now, reviewedById: reviewerId } });
    await tx.payoutAccount.updateMany({ where: { storeId: store.id, verifiedAt: null }, data: { verifiedAt: now } });
    return "approved";
  });
}
