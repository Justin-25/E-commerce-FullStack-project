import type { PrismaClient, User } from "../../generated/prisma/client.js";
import type { FieldCipher } from "../../lib/encryption.js";
import type { SecondFactorInput } from "./auth.schemas.js";
import { challengeExpired, locked, wrongSecondFactor } from "./authErrors.js";
import type { BackupCodes } from "./backupCodes.js";
import type { SignInChallenges } from "./challenges.js";
import { recordSecurityEvent, type ClientInfo } from "./events.js";
import { emailKey } from "./keys.js";
import type { LoginLockout } from "./lockout.js";
import type { TotpCodes } from "./totp.js";

/**
 * Checks an authenticator code or a backup code. Wrong codes count toward the
 * same lockout as passwords, and (during sign-in) toward that step's own 5 tries.
 */
export class SecondFactorCheck {
  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      lockout: LoginLockout;
      totp: TotpCodes;
      backupCodes: BackupCodes;
      challenges: SignInChallenges;
      cipher: FieldCipher;
    }
  ) {}

  /** The user's authenticator secret, decrypted (it's stored encrypted and bound to the user id). */
  decryptSecret(user: User): string {
    if (!user.twoFactorSecret) throw new Error("this user has no 2FA secret");
    return this.deps.cipher.decrypt(user.twoFactorSecret, user.id);
  }

  /** Returns which kind was used, or throws INVALID_CODE / ACCOUNT_LOCKED / CHALLENGE_EXPIRED. */
  async check(user: User, input: SecondFactorInput, client: ClientInfo, challengeToken?: string): Promise<"app" | "backup"> {
    const { prisma, lockout, totp, backupCodes, challenges } = this.deps;
    const account = emailKey(user.email);
    const wait = await lockout.secondsLocked(account, client.ipKey);
    if (wait > 0) throw locked(wait);
    const ok =
      input.code !== undefined
        ? user.twoFactorSecret !== null && (await totp.verify(user.id, this.decryptSecret(user), input.code))
        : input.backupCode !== undefined && (await backupCodes.use(user.id, input.backupCode));
    if (ok) {
      await lockout.recordSuccess(account, client.ipKey);
      return input.code !== undefined ? "app" : "backup";
    }
    const result = await lockout.recordFailure(account, client.ipKey);
    await recordSecurityEvent(prisma, user.id, "LOGIN_FAILED", client);
    if (result.locked) {
      await recordSecurityEvent(prisma, user.id, "LOCKED", client);
      if (challengeToken) await challenges.remove(challengeToken);
      throw locked(result.retryAfterSeconds);
    }
    const challengeLeft = challengeToken ? await challenges.countAttempt(challengeToken) : Number.POSITIVE_INFINITY;
    if (challengeLeft === 0) throw challengeExpired();
    throw wrongSecondFactor(Math.min(result.attemptsLeft, challengeLeft), input.backupCode !== undefined);
  }
}
