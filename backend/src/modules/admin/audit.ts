import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";

type Db = PrismaClient | Prisma.TransactionClient;

export interface AuditEntry {
  /** The admin (null: a command run on the server, or the system). */
  actorId: string | null;
  /** "store.approve", "store.view_tin", "payout_account.verify"… */
  action: string;
  targetType: "store" | "store_document" | "payout_account" | "user" | "payout" | "refund" | "product";
  targetId: string | null;
  metadata?: Prisma.InputJsonValue;
  ip?: string | null;
}

/**
 * The audit log: every admin action (and every look at sensitive data, like a full TIN or an ID
 * document) is a row: who, what, which record, from which IP. Written inside the same transaction
 * as the action, so an action can't happen without its row. Never edited or deleted by the app.
 */
export async function audit(db: Db, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
      ipAddress: entry.ip?.slice(0, 45) ?? null
    }
  });
}
