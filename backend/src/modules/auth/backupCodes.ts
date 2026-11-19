import { randomInt } from "node:crypto";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { hmacHex } from "../../lib/crypto.js";

export const BACKUP_CODE_COUNT = 10;
// No 0/o, 1/l/i: easy to read and type from paper.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/**
 * 10 single-use codes for when the phone is lost, e.g. "kq7mz-4hx2p" (~49 bits each).
 * They're shown once; only keyed hashes are stored, so nobody (not even
 * Vendora) can show them again: you can only get a new set.
 */
export class BackupCodes {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly hashKey: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  private hash(userId: string, code: string) {
    return hmacHex(this.hashKey, `backup:${userId}:${normalize(code)}`);
  }

  /** Replaces any old codes with 10 new ones and returns them (the only time they're visible). */
  async replace(tx: Prisma.TransactionClient, userId: string): Promise<string[]> {
    const codes = Array.from({ length: BACKUP_CODE_COUNT }, newCode);
    await tx.backupCode.deleteMany({ where: { userId } });
    await tx.backupCode.createMany({ data: codes.map((code) => ({ userId, codeHash: this.hash(userId, code) })) });
    return codes;
  }

  /** Uses up a code. True only the first time a valid code is used. */
  async use(userId: string, code: string): Promise<boolean> {
    if (normalize(code).length !== 10) return false;
    const { count } = await this.prisma.backupCode.updateMany({
      where: { userId, codeHash: this.hash(userId, code), usedAt: null },
      data: { usedAt: this.now() }
    });
    return count === 1;
  }

  countLeft(userId: string): Promise<number> {
    return this.prisma.backupCode.count({ where: { userId, usedAt: null } });
  }
}

/** People type codes with spaces, dashes or capitals; they all mean the same code. */
const normalize = (code: string) => code.toLowerCase().replace(/[\s-]/g, "");

function newCode(): string {
  const chars = Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}
