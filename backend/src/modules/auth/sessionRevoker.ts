import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { DependencyUnavailableError } from "../../lib/errors.js";
import type { KeyValueStore } from "../../lib/kv.js";
import type { Logger } from "../../lib/logger.js";
import { authKeys } from "./keys.js";
import { ACCESS_TTL_SECONDS } from "./tokens.js";

/**
 * For Redis writes that happen AFTER the database already did the real work
 * (sign-out, revoked chains, password changed): if Redis is down, don't fail
 * the request. The sign-ins are already ended in the database, so they can't
 * be refreshed; only passes already issued keep working, at most 15 minutes. Logged.
 */
export async function bestEffort(logger: Logger | undefined, consequence: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (err) {
    if (!(err instanceof DependencyUnavailableError)) throw err;
    logger?.error({ err: err.cause }, `redis unavailable: ${consequence}`);
  }
}

/**
 * Ends sign-ins. The database is the source of truth (a revoked sign-in can't
 * be refreshed); Redis makes the 15-minute access passes of those sign-ins
 * stop working immediately too.
 */
export class SessionRevoker {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly kv: KeyValueStore,
    private readonly logger?: Logger,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** Ends one sign-in chain (one device). */
  async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.prisma.session.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: this.now(), revokedReason: reason } });
    await this.markFamiliesRevoked([familyId]);
  }

  /** Ends every active sign-in of a user, optionally except one (inside a transaction). Returns the chains it ended. */
  async revokeAllSessions(tx: Prisma.TransactionClient, userId: string, reason: string, keepFamilyId?: string): Promise<string[]> {
    const where = { userId, revokedAt: null, ...(keepFamilyId ? { familyId: { not: keepFamilyId } } : {}) };
    const active = await tx.session.findMany({ where, select: { familyId: true }, distinct: ["familyId"] });
    await tx.session.updateMany({ where, data: { revokedAt: this.now(), revokedReason: reason } });
    return active.map((s) => s.familyId);
  }

  /** Access passes from these chains are refused until they would have expired anyway. */
  async markFamiliesRevoked(familyIds: string[]): Promise<void> {
    await bestEffort(this.logger, "revoked sign-ins not saved; their access passes stay valid up to 15 minutes", () =>
      Promise.all(familyIds.map((f) => this.kv.set(authKeys.revokedFamily(f), "1", ACCESS_TTL_SECONDS + 60)))
    );
  }
}
