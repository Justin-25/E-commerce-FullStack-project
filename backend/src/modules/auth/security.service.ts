import type { Config } from "../../config/env.js";
import { Prisma, type PrismaClient, type SecurityEventType, type User } from "../../generated/prisma/client.js";
import { BackgroundMailer } from "../../lib/backgroundMailer.js";
import type { EmailSender } from "../../lib/email.js";
import { createFieldCipher } from "../../lib/encryption.js";
import { AppError } from "../../lib/errors.js";
import type { KeyValueStore } from "../../lib/kv.js";
import type { Logger } from "../../lib/logger.js";
import { verifyPassword } from "../../lib/password.js";
import { describeDevice, type DeviceType } from "../../lib/userAgent.js";
import { confirmCodeMessage, emailChangeCodeMessage, emailChangedNoticeMessage } from "./auth.emails.js";
import type { ConfirmInput } from "./auth.schemas.js";
import { requiresTwoFactor, toPublicUser, type PublicUser } from "./auth.service.js";
import { fieldError, invalidCode, locked, notSignedIn, reauthRequired } from "./authErrors.js";
import { BackupCodes } from "./backupCodes.js";
import { SignInChallenges } from "./challenges.js";
import { OneTimeCodes } from "./codes.js";
import { recordSecurityEvent, type ClientInfo } from "./events.js";
import { authKeys, emailKey } from "./keys.js";
import { LoginLockout } from "./lockout.js";
import { SecondFactorCheck } from "./secondFactor.js";
import { SessionRevoker } from "./sessionRevoker.js";
import type { AccessClaims } from "./tokens.js";
import { TotpCodes } from "./totp.js";
import { TrustedDevices } from "./trustedDevices.js";

/** "Confirm it's you" lasts this long on the device where it was done. */
export const CONFIRM_TTL_SECONDS = 10 * 60;
const CODE_TTL_SECONDS = 10 * 60;
const CODE_COOLDOWN_SECONDS = 60;
const MAX_ACCOUNT_CODES_PER_DAY = 10;
/** Single failed attempts are summarised by LOCKED ("5 failed sign-in attempts — sign-in paused"), as in the design. */
const HIDDEN_FROM_ACTIVITY: SecurityEventType[] = ["LOGIN_FAILED"];

/** The proof "Confirm it's you" asks for: the strongest the account has. */
export type ConfirmMethod = "app" | "password" | "email";
export const confirmMethodFor = (user: User): ConfirmMethod => (user.twoFactorEnabledAt ? "app" : user.passwordHash ? "password" : "email");

export interface DeviceSession {
  id: string;
  device: string;
  deviceType: DeviceType;
  location: string | null;
  signedInAt: Date;
  lastActiveAt: Date;
  current: boolean;
}

export interface SecurityServiceDeps {
  prisma: PrismaClient;
  kv: KeyValueStore;
  email: EmailSender;
  config: Pick<Config, "CODE_HASH_SECRET" | "DATA_ENCRYPTION_KEY">;
  logger?: Logger;
  now?: () => Date;
}

/** "m•••s@gmail.com" style: enough for the owner to recognise, not enough to copy. */
export function maskEmail(address: string): string {
  const [local = "", domain = ""] = address.split("@");
  return `${local.slice(0, Math.min(7, Math.ceil(local.length / 2)))}•••@${domain}`;
}

/**
 * The Security settings page: "Confirm it's you", where you're signed in,
 * recent security activity, and changing the email address.
 */
export class SecurityService {
  private readonly codes: OneTimeCodes;
  private readonly lockout: LoginLockout;
  private readonly secondFactor: SecondFactorCheck;
  private readonly trustedDevices: TrustedDevices;
  private readonly revoker: SessionRevoker;
  private readonly mailer: BackgroundMailer;
  private readonly now: () => Date;

  constructor(private readonly deps: SecurityServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.codes = new OneTimeCodes(deps.prisma, deps.config.CODE_HASH_SECRET, this.now);
    this.lockout = new LoginLockout(deps.kv);
    this.secondFactor = new SecondFactorCheck({
      prisma: deps.prisma,
      lockout: this.lockout,
      totp: new TotpCodes(deps.kv, this.now),
      backupCodes: new BackupCodes(deps.prisma, deps.config.CODE_HASH_SECRET, this.now),
      challenges: new SignInChallenges(deps.kv),
      cipher: createFieldCipher(deps.config.DATA_ENCRYPTION_KEY)
    });
    this.trustedDevices = new TrustedDevices(deps.prisma, this.now);
    this.revoker = new SessionRevoker(deps.prisma, deps.kv, deps.logger, this.now);
    this.mailer = new BackgroundMailer(deps.email, deps.logger);
  }

  // --- overview -----------------------------------------------------------

  /** Everything the Security settings page shows at the top. */
  async overview(userId: string) {
    const user = await this.activeUser(userId);
    const backupCodesLeft = user.twoFactorEnabledAt ? await this.deps.prisma.backupCode.count({ where: { userId, usedAt: null } }) : 0;
    return {
      email: user.email,
      emailVerified: user.emailVerifiedAt !== null,
      hasPassword: user.passwordHash !== null,
      passwordChangedAt: user.passwordChangedAt,
      accountCreatedAt: user.createdAt,
      twoFactor: { enabled: user.twoFactorEnabledAt !== null, enabledAt: user.twoFactorEnabledAt, required: requiresTwoFactor(user.role), backupCodesLeft },
      confirmMethod: confirmMethodFor(user)
    };
  }

  // --- "Confirm it's you" ---------------------------------------------------

  async confirmStatus(claims: AccessClaims) {
    const user = await this.activeUser(claims.userId);
    const secondsLeft = await this.deps.kv.ttl(authKeys.confirmed(claims.familyId));
    return { method: confirmMethodFor(user), confirmed: secondsLeft > 0, expiresInSeconds: secondsLeft };
  }

  /** Accounts without a password get the 6-digit code by email (at most one a minute, ten a day). */
  async sendConfirmCode(claims: AccessClaims) {
    const user = await this.activeUser(claims.userId);
    if (confirmMethodFor(user) !== "email") throw new AppError(409, "CONFLICT", "Confirm with your password or authenticator app instead.");
    if (await this.allowAccountEmail(authKeys.confirmCooldown(user.id), user.id)) {
      const code = await this.codes.issue(user.id, "REAUTH", CODE_TTL_SECONDS);
      this.mailer.send(confirmCodeMessage(user.email, code, CODE_TTL_SECONDS / 60));
    }
    return { status: "code_sent" as const, email: maskEmail(user.email), expiresInSeconds: CODE_TTL_SECONDS };
  }

  /**
   * Checks the proof for this account (app code, password or emailed code).
   * Wrong ones count toward the sign-in lockout. Success is remembered for 10
   * minutes on THIS sign-in only, so a different (stolen) session can't use it.
   */
  async confirm(claims: AccessClaims, input: ConfirmInput, client: ClientInfo) {
    const user = await this.activeUser(claims.userId);
    const method = confirmMethodFor(user);
    if (method === "app") {
      if (input.code === undefined) throw fieldError("code", "Enter the 6-digit code from your authenticator app");
      await this.secondFactor.check(user, { code: input.code }, client);
    } else if (method === "password") {
      if (input.password === undefined) throw fieldError("password", "Enter your password");
      await this.checkPassword(user, input.password, client);
    } else {
      if (input.code === undefined) throw fieldError("code", "Enter the 6-digit code we emailed you");
      const token = await this.codes.check(user.id, "REAUTH", input.code);
      const used = token ? await this.deps.prisma.authToken.updateMany({ where: { id: token.id, usedAt: null }, data: { usedAt: this.now() } }) : null;
      if (used?.count !== 1) throw invalidCode();
    }
    // If Redis is down this throws (503): a confirmation that can't be saved must not count.
    await this.deps.kv.set(authKeys.confirmed(claims.familyId), "1", CONFIRM_TTL_SECONDS);
    return { confirmed: true, expiresInSeconds: CONFIRM_TTL_SECONDS };
  }

  /** Throws REAUTH_REQUIRED unless "Confirm it's you" was done on this device in the last 10 minutes. */
  async requireConfirmed(claims: AccessClaims): Promise<void> {
    if (!(await this.deps.kv.get(authKeys.confirmed(claims.familyId)))) throw reauthRequired();
  }

  // --- where you're signed in -------------------------------------------

  async listSessions(claims: AccessClaims): Promise<DeviceSession[]> {
    const { prisma } = this.deps;
    const active = await prisma.session.findMany({
      where: { userId: claims.userId, revokedAt: null, expiresAt: { gt: this.now() } },
      orderBy: { createdAt: "desc" }
    });
    const latest = new Map<string, (typeof active)[number]>();
    for (const s of active) if (!latest.has(s.familyId)) latest.set(s.familyId, s); // one row per device
    const started = await prisma.session.groupBy({ by: ["familyId"], where: { familyId: { in: [...latest.keys()] } }, _min: { createdAt: true } });
    const startedAt = new Map(started.map((g) => [g.familyId, g._min.createdAt]));

    return [...latest.values()]
      .map((s) => {
        const { label, type } = describeDevice(s.userAgent);
        const lastActiveAt = s.lastUsedAt > s.createdAt ? s.lastUsedAt : s.createdAt;
        return {
          id: s.familyId,
          device: label,
          deviceType: type,
          location: s.location,
          signedInAt: startedAt.get(s.familyId) ?? s.createdAt,
          lastActiveAt,
          current: s.familyId === claims.familyId
        };
      })
      .sort((a, b) => Number(b.current) - Number(a.current) || b.lastActiveAt.getTime() - a.lastActiveAt.getTime());
  }

  /** "Sign out" next to a device. Takes effect immediately, including that device's current access pass. */
  async signOutSession(claims: AccessClaims, familyId: string, client: ClientInfo): Promise<{ current: boolean }> {
    const owned = await this.deps.prisma.session.findFirst({ where: { familyId, userId: claims.userId, revokedAt: null }, select: { id: true } });
    if (!owned) throw new AppError(404, "NOT_FOUND", "That device isn't signed in anymore.");
    const current = familyId === claims.familyId;
    await this.revoker.revokeFamily(familyId, current ? "logout" : "signed_out_remotely");
    if (!current) await recordSecurityEvent(this.deps.prisma, claims.userId, "SESSION_REVOKED", client);
    return { current };
  }

  /**
   * "Sign out of all other devices": every other sign-in ends at once and no
   * other browser stays trusted for 2FA. This device stays signed in.
   */
  async signOutOthers(claims: AccessClaims, trustedDeviceToken: string | undefined, client: ClientInfo) {
    const families = await this.deps.prisma.$transaction(async (tx) => {
      const ended = await this.revoker.revokeAllSessions(tx, claims.userId, "signed_out_remotely", claims.familyId);
      await this.trustedDevices.revokeAllExcept(tx, claims.userId, trustedDeviceToken);
      await recordSecurityEvent(tx, claims.userId, "LOGOUT_ALL", client);
      return ended;
    });
    await this.revoker.markFamiliesRevoked(families);
    return { signedOut: families.length };
  }

  // --- recent security activity ---------------------------------------------

  /** Newest first, 20 at a time; pass `before` (the last id you got) for older ones. */
  async activity(userId: string, page: { before?: string | undefined; limit: number }) {
    const rows = await this.deps.prisma.securityEvent.findMany({
      where: { userId, type: { notIn: HIDDEN_FROM_ACTIVITY }, ...(page.before ? { id: { lt: page.before } } : {}) },
      orderBy: { id: "desc" }, // ids are UUID v7, so they sort by time
      take: page.limit + 1
    });
    const events = rows.slice(0, page.limit).map((e) => {
      const { label, type } = describeDevice(e.userAgent);
      return { id: e.id, type: e.type, device: label, deviceType: type, location: e.location, createdAt: e.createdAt };
    });
    return { events, nextCursor: rows.length > page.limit ? (events.at(-1)?.id ?? null) : null };
  }

  // --- change email address -------------------------------------------------

  /** After "Confirm it's you": emails a 6-digit code to the NEW address to prove it's theirs. */
  async startEmailChange(claims: AccessClaims, newEmail: string) {
    const user = await this.activeUser(claims.userId);
    await this.requireConfirmed(claims);
    if (newEmail === user.email) throw fieldError("newEmail", "That's already your email address.");
    // Only reachable signed in, after "Confirm it's you", and rate limited, so saying "taken" is acceptable here.
    if (await this.deps.prisma.user.findUnique({ where: { email: newEmail }, select: { id: true } })) {
      throw fieldError("newEmail", "Another account already uses this email address.");
    }
    if (!(await this.allowAccountEmail(authKeys.emailChangeCooldown(`${user.id}:${emailKey(newEmail)}`), user.id))) {
      throw new AppError(429, "RATE_LIMITED", "Please wait a minute before asking for another code.", { details: { retryAfterSeconds: CODE_COOLDOWN_SECONDS } });
    }
    const code = await this.codes.issue(user.id, "EMAIL_CHANGE", CODE_TTL_SECONDS, { newEmail });
    this.mailer.send(emailChangeCodeMessage(newEmail, code, CODE_TTL_SECONDS / 60));
    return { status: "code_sent" as const, email: newEmail, codeExpiresInSeconds: CODE_TTL_SECONDS };
  }

  /**
   * The code from the new inbox → the address changes. Links and codes sent to
   * the old address stop working, and the old address is told about the change.
   */
  async confirmEmailChange(claims: AccessClaims, code: string, client: ClientInfo): Promise<PublicUser> {
    const user = await this.activeUser(claims.userId);
    const token = await this.codes.check(user.id, "EMAIL_CHANGE", code);
    if (!token?.newEmail) throw invalidCode();
    const newEmail = token.newEmail;
    const now = this.now();
    let updated: User;
    try {
      updated = await this.deps.prisma.$transaction(async (tx) => {
        const used = await tx.authToken.updateMany({ where: { id: token.id, usedAt: null }, data: { usedAt: now } });
        if (used.count !== 1) throw invalidCode();
        const changed = await tx.user.update({ where: { id: user.id }, data: { email: newEmail, emailVerifiedAt: now } });
        await tx.authToken.deleteMany({ where: { userId: user.id, type: { in: ["PASSWORD_RESET", "EMAIL_VERIFY", "REAUTH"] } } });
        await recordSecurityEvent(tx, user.id, "EMAIL_CHANGED", client);
        return changed;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new AppError(409, "CONFLICT", "Another account started using that email address. Choose a different one.");
      }
      throw err;
    }
    this.mailer.send(emailChangedNoticeMessage(user.email, user.name, maskEmail(newEmail)));
    return toPublicUser(updated);
  }

  async drain(): Promise<void> {
    await this.mailer.drain();
  }

  // --- helpers --------------------------------------------------------------

  private async checkPassword(user: User, password: string, client: ClientInfo) {
    const account = emailKey(user.email);
    const wait = await this.lockout.secondsLocked(account, client.ipKey);
    if (wait > 0) throw locked(wait);
    if (user.passwordHash && (await verifyPassword(password, user.passwordHash))) {
      await this.lockout.recordSuccess(account, client.ipKey);
      return;
    }
    const result = await this.lockout.recordFailure(account, client.ipKey);
    await recordSecurityEvent(this.deps.prisma, user.id, "LOGIN_FAILED", client);
    if (result.locked) {
      await recordSecurityEvent(this.deps.prisma, user.id, "LOCKED", client);
      throw locked(result.retryAfterSeconds);
    }
    throw fieldError("password", "That's not your password.", { attemptsLeft: result.attemptsLeft });
  }

  /** At most one email per cooldown key a minute, and ten account emails a day per user. */
  private async allowAccountEmail(cooldownKey: string, userId: string): Promise<boolean> {
    const { kv } = this.deps;
    if (!(await kv.setIfAbsent(cooldownKey, "1", CODE_COOLDOWN_SECONDS))) return false;
    return (await kv.increment(authKeys.accountCodesToday(userId), 24 * 60 * 60)) <= MAX_ACCOUNT_CODES_PER_DAY;
  }

  private async activeUser(userId: string): Promise<User> {
    const user = await this.deps.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt || user.status !== "ACTIVE") throw notSignedIn();
    return user;
  }
}
