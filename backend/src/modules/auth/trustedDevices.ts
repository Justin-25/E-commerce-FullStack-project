import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { randomToken, sha256Hex } from "../../lib/crypto.js";

/** Design: "Trust this device for 30 days". */
export const TRUSTED_DEVICE_DAYS = 30;

/**
 * Devices that may skip the 2FA code for 30 days. The browser keeps a random
 * token in an httpOnly cookie; the database keeps only its hash, tied to one
 * user, so the cookie is useless for any other account.
 */
export class TrustedDevices {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date()
  ) {}

  async create(tx: Prisma.TransactionClient, userId: string, client: { ip: string; userAgent?: string | undefined }) {
    const token = randomToken(32);
    const expiresAt = new Date(this.now().getTime() + TRUSTED_DEVICE_DAYS * 24 * 60 * 60 * 1000);
    await tx.trustedDevice.create({
      data: { userId, tokenHash: sha256Hex(token), userAgent: client.userAgent?.slice(0, 512) ?? null, ipAddress: client.ip.slice(0, 45), expiresAt }
    });
    return { token, expiresAt };
  }

  /** True if this cookie token is an active trusted device of this user (and records that it was used). */
  async isTrusted(userId: string, token: string | undefined): Promise<boolean> {
    if (!token) return false;
    const now = this.now();
    const { count } = await this.prisma.trustedDevice.updateMany({
      where: { userId, tokenHash: sha256Hex(token), revokedAt: null, expiresAt: { gt: now } },
      data: { lastUsedAt: now }
    });
    return count === 1;
  }

  /** After a password change/reset or turning 2FA off, no device is trusted anymore. */
  revokeAll(tx: Prisma.TransactionClient, userId: string) {
    return tx.trustedDevice.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: this.now() } });
  }

  /** "Sign out of all other devices": every other browser stops being trusted; this one (its cookie token) stays. */
  revokeAllExcept(tx: Prisma.TransactionClient, userId: string, keepToken: string | undefined) {
    return tx.trustedDevice.updateMany({
      where: { userId, revokedAt: null, ...(keepToken ? { tokenHash: { not: sha256Hex(keepToken) } } : {}) },
      data: { revokedAt: this.now() }
    });
  }
}
