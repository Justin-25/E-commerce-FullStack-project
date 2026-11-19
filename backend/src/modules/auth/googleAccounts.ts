import type { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import { recordSecurityEvent, type ClientInfo } from "./events.js";

export const googleUsedElsewhere = () => new AppError(409, "CONFLICT", "This Google account is already connected to another Vendora account.");

/**
 * Connects a Google account (by its permanent `sub`) to a Vendora account and
 * records it in "Recent security activity". Inside the caller's transaction.
 * One Google account per Vendora account, and never to two Vendora accounts.
 */
export async function connectGoogle(tx: Prisma.TransactionClient, userId: string, google: { sub: string; email: string }, client: ClientInfo) {
  const bySub = await tx.oAuthAccount.findUnique({ where: { provider_providerUserId: { provider: "GOOGLE", providerUserId: google.sub } } });
  if (bySub) {
    if (bySub.userId !== userId) throw googleUsedElsewhere();
    return; // already connected to this account
  }
  if (await tx.oAuthAccount.findUnique({ where: { userId_provider: { userId, provider: "GOOGLE" } } })) {
    throw new AppError(409, "CONFLICT", "A different Google account is already connected. Disconnect it first in Security settings.");
  }
  await tx.oAuthAccount.create({ data: { userId, provider: "GOOGLE", providerUserId: google.sub, email: google.email } });
  await recordSecurityEvent(tx, userId, "GOOGLE_CONNECTED", client);
}
