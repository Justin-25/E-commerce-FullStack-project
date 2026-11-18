import type { AuthTokenType, PrismaClient } from "../../generated/prisma/client.js";
import { hmacHex, safeEqualHex, sixDigitCode } from "../../lib/crypto.js";

/** Wrong guesses allowed per code before it stops working. */
export const CODE_MAX_ATTEMPTS = 5;

/**
 * 6-digit codes sent by email (verify email; later "Confirm it's you").
 * Only a keyed hash is stored, each code works once, expires, and allows
 * 5 tries, so guessing one of a million codes is hopeless.
 */
export class OneTimeCodes {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly hashKey: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  // The user id and type are part of the hash, so equal codes for different users never collide.
  private hash(userId: string, type: AuthTokenType, code: string) {
    return hmacHex(this.hashKey, `${type}:${userId}:${code}`);
  }

  /** Creates a new code. Any older code of the same type stops working. */
  async issue(userId: string, type: AuthTokenType, ttlSeconds: number): Promise<string> {
    const code = sixDigitCode();
    await this.prisma.$transaction([
      this.prisma.authToken.deleteMany({ where: { userId, type } }),
      this.prisma.authToken.create({
        data: { userId, type, tokenHash: this.hash(userId, type, code), expiresAt: new Date(this.now().getTime() + ttlSeconds * 1000) }
      })
    ]);
    return code;
  }

  /**
   * Counts one attempt, then checks the code. Returns the code's row id if it's
   * right (the caller marks it used inside its own transaction), otherwise null.
   */
  async check(userId: string, type: AuthTokenType, code: string): Promise<string | null> {
    const token = await this.prisma.authToken.findFirst({
      where: { userId, type, usedAt: null, expiresAt: { gt: this.now() } },
      orderBy: { createdAt: "desc" }
    });
    if (!token) return null;
    // Count the attempt first, atomically, so parallel guesses can't exceed the limit.
    const counted = await this.prisma.authToken.updateMany({
      where: { id: token.id, usedAt: null, attempts: { lt: CODE_MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } }
    });
    if (counted.count === 0) return null;
    return safeEqualHex(token.tokenHash, this.hash(userId, type, code)) ? token.id : null;
  }
}
