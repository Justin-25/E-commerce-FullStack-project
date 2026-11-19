import { randomUUID } from "node:crypto";
import type { Config } from "../../config/env.js";
import { Prisma, type PrismaClient, type User } from "../../generated/prisma/client.js";
import type { BreachCheck } from "../../lib/breachedPasswords.js";
import { randomToken, sha256Hex } from "../../lib/crypto.js";
import { BackgroundMailer } from "../../lib/backgroundMailer.js";
import type { EmailSender } from "../../lib/email.js";
import { createFieldCipher, type FieldCipher } from "../../lib/encryption.js";
import { AppError } from "../../lib/errors.js";
import type { KeyValueStore } from "../../lib/kv.js";
import type { Logger } from "../../lib/logger.js";
import { dummyHash, hashPassword, needsRehash, verifyPassword } from "../../lib/password.js";
import {
  accountExistsMessage,
  backupCodeUsedMessage,
  passwordChangedMessage,
  passwordResetMessage,
  twoFactorDisabledMessage,
  twoFactorEnabledMessage,
  verifyEmailMessage
} from "./auth.emails.js";
import type {
  ChangePasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
  SecondFactorInput,
  TwoFactorVerifyInput,
  VerifyEmailInput
} from "./auth.schemas.js";

export type { ClientInfo } from "./events.js";
import { BREACHED_MESSAGE, challengeExpired, fieldError, invalidCode, invalidLink, locked, notSignedIn, refreshConflict, suspended } from "./authErrors.js";
import { BackupCodes } from "./backupCodes.js";
import { SignInChallenges, type Challenge, type IssuedChallenge } from "./challenges.js";
import { OneTimeCodes, OneTimeLinks } from "./codes.js";
import { recordSecurityEvent, type ClientInfo } from "./events.js";
import { authKeys, emailKey } from "./keys.js";
import { LoginLockout } from "./lockout.js";
import { SecondFactorCheck } from "./secondFactor.js";
import { bestEffort, SessionRevoker } from "./sessionRevoker.js";
import { ACCESS_TTL_SECONDS, SESSION_TTL_MS, type AccessClaims, type IssuedSession, type TokenService } from "./tokens.js";
import { TotpCodes } from "./totp.js";
import { TrustedDevices } from "./trustedDevices.js";

type Db = Prisma.TransactionClient;

export const VERIFY_CODE_TTL_SECONDS = 10 * 60;
const VERIFY_RESEND_COOLDOWN_SECONDS = 60;
/** At most 10 codes per email per day: with 5 tries each, guessing a 6-digit code stays hopeless. */
const MAX_CODES_PER_DAY = 10;
/** "Someone tried to sign up with your email" goes out at most once an hour, so the form can't spam people. */
const ACCOUNT_EXISTS_NOTICE_SECONDS = 60 * 60;
/** Two tabs refreshing at the same moment: the slower one gets 409 instead of being treated as theft. */
export const REFRESH_GRACE_MS = 10_000;
/** Design: "It expires in 30 minutes." */
export const RESET_LINK_TTL_SECONDS = 30 * 60;
const RESET_COOLDOWN_SECONDS = 60;
const MAX_RESETS_PER_DAY = 5;

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: User["role"];
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  createdAt: Date;
}

export interface SignInResult extends IssuedSession {
  user: PublicUser;
}

/**
 * After a correct password: either signed in, or one more step first
 * (enter the 2FA code / set up 2FA). Routes turn this into cookies + JSON.
 */
export type SignInOutcome =
  | { kind: "signed_in"; session: SignInResult; trustedDevice?: { token: string; expiresAt: Date }; backupCodes?: string[] }
  | { kind: "challenge"; challenge: IssuedChallenge };

/** Sellers and admins handle money and other people's data, so two-step verification is required for them. */
export const requiresTwoFactor = (role: User["role"]) => role === "SELLER" || role === "ADMIN";

/** The only user fields that ever leave the API (never the password hash or 2FA secret). */
export const toPublicUser = (u: User): PublicUser => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  emailVerified: u.emailVerifiedAt !== null,
  twoFactorEnabled: u.twoFactorEnabledAt !== null,
  createdAt: u.createdAt
});

export interface AuthServiceDeps {
  prisma: PrismaClient;
  kv: KeyValueStore;
  email: EmailSender;
  tokens: TokenService;
  config: Pick<Config, "APP_URL" | "CODE_HASH_SECRET" | "DATA_ENCRYPTION_KEY">;
  isBreached: BreachCheck;
  /** For emails that fail to send in the background. */
  logger?: Logger;
  now?: () => Date;
}

export class AuthService {
  private readonly codes: OneTimeCodes;
  private readonly links: OneTimeLinks;
  private readonly lockout: LoginLockout;
  private readonly challenges: SignInChallenges;
  private readonly totp: TotpCodes;
  private readonly backupCodes: BackupCodes;
  private readonly trustedDevices: TrustedDevices;
  private readonly cipher: FieldCipher;
  private readonly secondFactor: SecondFactorCheck;
  private readonly revoker: SessionRevoker;
  private readonly mailer: BackgroundMailer;
  private readonly now: () => Date;

  constructor(private readonly deps: AuthServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.codes = new OneTimeCodes(deps.prisma, deps.config.CODE_HASH_SECRET, this.now);
    this.links = new OneTimeLinks(deps.prisma, deps.config.CODE_HASH_SECRET, this.now);
    this.lockout = new LoginLockout(deps.kv);
    this.challenges = new SignInChallenges(deps.kv);
    this.totp = new TotpCodes(deps.kv, this.now);
    this.backupCodes = new BackupCodes(deps.prisma, deps.config.CODE_HASH_SECRET, this.now);
    this.trustedDevices = new TrustedDevices(deps.prisma, this.now);
    this.cipher = createFieldCipher(deps.config.DATA_ENCRYPTION_KEY);
    this.secondFactor = new SecondFactorCheck({
      prisma: deps.prisma,
      lockout: this.lockout,
      totp: this.totp,
      backupCodes: this.backupCodes,
      challenges: this.challenges,
      cipher: this.cipher
    });
    this.revoker = new SessionRevoker(deps.prisma, deps.kv, deps.logger, this.now);
    this.mailer = new BackgroundMailer(deps.email, deps.logger);
    void dummyHash(); // prepare it now, so the first sign-in for an unknown email isn't slower than the rest
  }

  /**
   * Same answer whether or not the email is registered, so the form can't be
   * used to find out who shops on Vendora.
   */
  async register(input: RegisterInput) {
    const { prisma, kv, config } = this.deps;
    if (await this.deps.isBreached(input.password)) throw fieldError("password", BREACHED_MESSAGE);
    // Hash in every case, so the response takes the same time whether or not the email exists.
    const passwordHash = await hashPassword(input.password);
    const existing = await prisma.user.findUnique({ where: { email: input.email } });

    if (!existing) {
      const created = await prisma.user.create({ data: { email: input.email, name: input.name, passwordHash } }).catch((err: unknown) => {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return null; // signed up a moment ago in another request
        throw err;
      });
      if (created) await this.sendVerificationCode(created, { force: true });
    } else if (!existing.emailVerifiedAt) {
      // Not verified yet: whoever proves they own the inbox decides the name and password.
      const updated = await prisma.user.update({ where: { id: existing.id }, data: { name: input.name, passwordHash } });
      await this.sendVerificationCode(updated, { force: false });
    } else if (await kv.setIfAbsent(authKeys.accountExistsNotice(emailKey(input.email)), "1", ACCOUNT_EXISTS_NOTICE_SECONDS)) {
      this.mailer.send(accountExistsMessage(existing.email, existing.name, config.APP_URL));
    }
    return this.verificationSent(input.email);
  }

  async resendVerification(email: string) {
    const user = await this.deps.prisma.user.findUnique({ where: { email } });
    if (user && !user.emailVerifiedAt && !user.deletedAt && user.status === "ACTIVE") await this.sendVerificationCode(user, { force: false });
    return this.verificationSent(email);
  }

  /** Correct code → the email is verified and the user is signed in. */
  async verifyEmail(input: VerifyEmailInput, client: ClientInfo): Promise<SignInResult> {
    const { prisma } = this.deps;
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    if (!user || user.emailVerifiedAt || user.deletedAt) throw invalidCode();
    const codeId = (await this.codes.check(user.id, "EMAIL_VERIFY", input.code))?.id;
    if (!codeId) throw invalidCode();
    if (user.status !== "ACTIVE") throw suspended();

    const now = this.now();
    return prisma.$transaction(async (tx) => {
      const used = await tx.authToken.updateMany({ where: { id: codeId, usedAt: null }, data: { usedAt: now } });
      if (used.count !== 1) throw invalidCode(); // used by a parallel request a moment ago
      const verified = await tx.user.update({ where: { id: user.id }, data: { emailVerifiedAt: now, lastLoginAt: now } });
      await recordSecurityEvent(tx, user.id, "LOGIN_OK", client);
      return this.startSession(tx, verified, input.keepSignedIn, client);
    });
  }

  /** `trustedDeviceToken`: the "trust this device" cookie, if the browser has one. */
  async login(input: LoginInput, client: ClientInfo, trustedDeviceToken?: string): Promise<SignInOutcome> {
    const { prisma } = this.deps;
    const account = emailKey(input.email);
    const wait = await this.lockout.secondsLocked(account, client.ipKey);
    if (wait > 0) throw locked(wait);

    const user = await prisma.user.findUnique({ where: { email: input.email } });
    const stored = user && !user.deletedAt ? user.passwordHash : null; // null for Google-only accounts
    // Always run exactly one Argon2 check, so the timing doesn't reveal whether the account exists.
    const passwordOk = await verifyPassword(input.password, stored ?? (await dummyHash()));

    if (!user || !stored || !passwordOk) {
      const result = await this.lockout.recordFailure(account, client.ipKey);
      if (user && !user.deletedAt) {
        await recordSecurityEvent(prisma, user.id, "LOGIN_FAILED", client);
        if (result.locked) await recordSecurityEvent(prisma, user.id, "LOCKED", client);
      }
      if (result.locked) throw locked(result.retryAfterSeconds);
      throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.", { details: { attemptsLeft: result.attemptsLeft } });
    }

    // From here the password was right, so it's safe to tell the person about their account's state.
    await this.lockout.recordSuccess(account, client.ipKey);
    if (user.status !== "ACTIVE") throw suspended();
    if (!user.emailVerifiedAt) {
      await this.sendVerificationCode(user, { force: false });
      // (The one-email-per-minute limit may have skipped sending, so don't promise a NEW code.)
      throw new AppError(403, "EMAIL_NOT_VERIFIED", "Verify your email to finish creating your account. Enter the 6-digit code we emailed you.", {
        details: { email: user.email }
      });
    }

    if (needsRehash(stored)) {
      await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(input.password) } });
    }
    return this.completeSignIn(user, input.keepSignedIn, client, trustedDeviceToken);
  }

  /**
   * Refresh-token rotation: every refresh pass works once and is replaced by a
   * new one in the same "family". If a used pass ever comes back, someone copied
   * it, so the whole family is signed out (the thief and the real device).
   */
  async refresh(refreshToken: string | undefined, client: ClientInfo): Promise<SignInResult> {
    if (!refreshToken) throw notSignedIn();
    const { prisma } = this.deps;
    const session = await prisma.session.findUnique({ where: { refreshTokenHash: sha256Hex(refreshToken) }, include: { user: true } });
    if (!session) throw notSignedIn();
    const now = this.now();

    if (session.revokedAt) {
      if (session.revokedReason === "rotated") {
        if (now.getTime() - session.revokedAt.getTime() < REFRESH_GRACE_MS) throw refreshConflict();
        await this.revoker.revokeFamily(session.familyId, "reuse_detected");
        await recordSecurityEvent(prisma, session.userId, "TOKEN_REUSE_DETECTED", client);
      }
      throw notSignedIn();
    }
    if (session.expiresAt <= now) throw notSignedIn();
    const { user } = session;
    if (user.status !== "ACTIVE" || user.deletedAt) {
      await this.revoker.revokeFamily(session.familyId, "user_inactive");
      throw notSignedIn();
    }

    return prisma.$transaction(async (tx) => {
      const rotated = await tx.session.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: now, revokedReason: "rotated", lastUsedAt: now }
      });
      if (rotated.count !== 1) throw refreshConflict(); // a parallel refresh won the race
      // Same family, same absolute end date: refreshing never extends a sign-in.
      return this.startSession(tx, user, session.persistent, client, { familyId: session.familyId, expiresAt: session.expiresAt });
    });
  }

  /** Signs out this device: its whole sign-in chain is revoked and its access pass stops working at once. */
  async logout(refreshToken: string | undefined, claims: AccessClaims | undefined): Promise<void> {
    let familyId = claims?.familyId;
    if (refreshToken) {
      const session = await this.deps.prisma.session.findUnique({ where: { refreshTokenHash: sha256Hex(refreshToken) }, select: { familyId: true } });
      if (session) familyId = session.familyId;
    }
    if (familyId) await this.revoker.revokeFamily(familyId, "logout");
    if (claims) {
      const { jti } = claims;
      const secondsLeft = Math.max(1, claims.expiresAt - Math.floor(this.now().getTime() / 1000));
      await bestEffort(this.deps.logger, "signed-out access pass stays valid up to 15 minutes", () => this.deps.kv.set(authKeys.deniedAccess(jti), "1", secondsLeft));
    }
  }

  /** The signed-in user, or null if the account was suspended or deleted since the pass was issued. */
  async getUser(userId: string): Promise<PublicUser | null> {
    const user = await this.deps.prisma.user.findUnique({ where: { id: userId } });
    return user && user.status === "ACTIVE" && !user.deletedAt ? toPublicUser(user) : null;
  }

  // --- passwords (3b) -------------------------------------------------------

  /** Always the same answer (design: "If an account exists for …"). At most 1 email a minute, 5 a day. */
  async forgotPassword(email: string) {
    const { prisma, kv, config } = this.deps;
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && !user.deletedAt && user.status === "ACTIVE") {
      const account = emailKey(email);
      const allowed =
        (await kv.setIfAbsent(authKeys.resetCooldown(account), "1", RESET_COOLDOWN_SECONDS)) &&
        (await kv.increment(authKeys.resetsToday(account), 24 * 60 * 60)) <= MAX_RESETS_PER_DAY;
      if (allowed) {
        const token = await this.links.issue(user.id, "PASSWORD_RESET", RESET_LINK_TTL_SECONDS);
        // The token goes after "#": browsers never send that part to a server or to other sites.
        this.mailer.send(passwordResetMessage(user.email, user.name, `${config.APP_URL}/reset-password#token=${token}`, RESET_LINK_TTL_SECONDS / 60));
      }
    }
    return { status: "reset_link_sent" as const, email, expiresInSeconds: RESET_LINK_TTL_SECONDS };
  }

  /**
   * New password from an emailed link. The link works once; every device is
   * signed out and this one is signed in (design: "You'll be signed out
   * everywhere else"). Clicking the link proves inbox ownership, so it also
   * verifies the email and lifts the sign-in pause. People with two-step
   * verification still enter their app code: an email link alone never opens
   * an account. No device stays trusted.
   */
  async resetPassword(input: ResetPasswordInput, client: ClientInfo): Promise<SignInOutcome> {
    const { prisma } = this.deps;
    const link = await this.links.find("PASSWORD_RESET", input.token);
    if (!link || link.user.deletedAt) throw invalidLink();
    if (link.user.status !== "ACTIVE") throw suspended();
    // Check the new password before using up the link, so a rejected password doesn't waste it.
    if (await this.deps.isBreached(input.password)) throw fieldError("password", BREACHED_MESSAGE);
    const passwordHash = await hashPassword(input.password);
    const now = this.now();

    const { user, families } = await prisma.$transaction(async (tx) => {
      const used = await tx.authToken.updateMany({ where: { id: link.id, usedAt: null }, data: { usedAt: now } });
      if (used.count !== 1) throw invalidLink();
      const user = await tx.user.update({
        where: { id: link.userId },
        data: { passwordHash, passwordChangedAt: now, emailVerifiedAt: link.user.emailVerifiedAt ?? now }
      });
      const families = await this.revoker.revokeAllSessions(tx, user.id, "password_reset");
      await this.trustedDevices.revokeAll(tx, user.id);
      await recordSecurityEvent(tx, user.id, "PASSWORD_RESET", client);
      return { user, families };
    });

    await this.afterPasswordChange(link.user, families, now);
    await bestEffort(this.deps.logger, "sign-in pause not lifted after the reset", () => this.lockout.clear(emailKey(link.user.email), client.ipKey));
    return this.completeSignIn(user, input.keepSignedIn, client);
  }

  /**
   * Signed in: current password + new password. Wrong current passwords count
   * toward the same lockout as sign-in (a stolen session can't be used to guess
   * it). Every other device is signed out; this one gets fresh passes.
   */
  async changePassword(claims: AccessClaims, input: ChangePasswordInput, client: ClientInfo): Promise<SignInResult> {
    const { prisma } = this.deps;
    const user = await prisma.user.findUnique({ where: { id: claims.userId } });
    if (!user || user.deletedAt || user.status !== "ACTIVE") throw notSignedIn();
    if (!user.passwordHash) {
      throw fieldError("currentPassword", 'Your account doesn\'t have a password yet. Use "Forgot password?" on the sign-in page to create one.');
    }

    const account = emailKey(user.email);
    const wait = await this.lockout.secondsLocked(account, client.ipKey);
    if (wait > 0) throw locked(wait);
    if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
      const result = await this.lockout.recordFailure(account, client.ipKey);
      await recordSecurityEvent(prisma, user.id, "LOGIN_FAILED", client);
      if (result.locked) {
        await recordSecurityEvent(prisma, user.id, "LOCKED", client);
        throw locked(result.retryAfterSeconds);
      }
      throw fieldError("currentPassword", "That's not your current password.", { attemptsLeft: result.attemptsLeft });
    }
    await this.lockout.recordSuccess(account, client.ipKey);

    if (input.newPassword.normalize("NFKC") === input.currentPassword.normalize("NFKC")) {
      throw fieldError("newPassword", "Choose a different password from the one you use now.");
    }
    if (await this.deps.isBreached(input.newPassword)) throw fieldError("newPassword", BREACHED_MESSAGE);
    const passwordHash = await hashPassword(input.newPassword);
    const now = this.now();
    const current = await prisma.session.findUnique({ where: { id: claims.sessionId }, select: { persistent: true } });

    const { session, families } = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id: user.id }, data: { passwordHash, passwordChangedAt: now } });
      // Every sign-in chain ends, including this device's; this device then starts a fresh one.
      const families = await this.revoker.revokeAllSessions(tx, user.id, "password_changed");
      await this.trustedDevices.revokeAll(tx, user.id);
      await recordSecurityEvent(tx, user.id, "PASSWORD_CHANGED", client);
      return { session: await this.startSession(tx, updated, current?.persistent ?? false, client), families };
    });

    await this.afterPasswordChange(user, families, now);
    return session;
  }

  // --- two-step verification (3c) --------------------------------------------

  /** The pending "enter your code" / "set up 2FA" step this cookie token belongs to, if any. */
  findChallenge(token: string | undefined): Promise<Challenge | null> {
    return this.challenges.find(token);
  }

  /** "Enter the 6-digit code from the app" (or "Use a backup code instead") after a correct password. */
  async verifyTwoFactor(challengeToken: string | undefined, input: TwoFactorVerifyInput, client: ClientInfo): Promise<SignInOutcome> {
    const challenge = await this.challenges.find(challengeToken);
    if (!challengeToken || !challenge || challenge.type !== "two_factor") throw challengeExpired();
    const user = await this.deps.prisma.user.findUnique({ where: { id: challenge.userId } });
    if (!user || user.deletedAt || user.status !== "ACTIVE" || !user.twoFactorEnabledAt) {
      await this.challenges.remove(challengeToken);
      throw challengeExpired();
    }
    const method = await this.secondFactor.check(user, input, client, challengeToken);
    await this.challenges.remove(challengeToken); // each step works once

    const now = this.now();
    const { session, trustedDevice } = await this.deps.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
      await recordSecurityEvent(tx, user.id, "LOGIN_OK", client);
      if (method === "backup") await recordSecurityEvent(tx, user.id, "BACKUP_CODE_USED", client);
      const trustedDevice = input.trustDevice ? await this.trustedDevices.create(tx, user.id, client) : undefined;
      return { session: await this.startSession(tx, updated, challenge.keepSignedIn, client), trustedDevice };
    });
    if (method === "backup") {
      const left = await this.backupCodes.countLeft(user.id);
      this.mailer.send(backupCodeUsedMessage(user.email, user.name, left, this.deps.config.APP_URL));
    }
    return { kind: "signed_in", session, ...(trustedDevice ? { trustedDevice } : {}) };
  }

  /** For Security settings: is 2FA on, is it required for this account, how many backup codes are left. */
  async twoFactorStatus(userId: string) {
    const user = await this.activeUser(userId);
    return {
      enabled: user.twoFactorEnabledAt !== null,
      enabledAt: user.twoFactorEnabledAt,
      required: requiresTwoFactor(user.role),
      backupCodesLeft: user.twoFactorEnabledAt ? await this.backupCodes.countLeft(user.id) : 0
    };
  }

  /** Turning 2FA on, step 1: a new secret (stored encrypted) and the link the frontend draws as a QR code. */
  async startTwoFactorSetup(userId: string) {
    const user = await this.activeUser(userId);
    if (user.twoFactorEnabledAt) throw new AppError(409, "CONFLICT", "Two-step verification is already on.");
    const { secret, otpauthUri } = this.totp.newSecret(user.email);
    await this.deps.prisma.user.update({ where: { id: user.id }, data: { twoFactorSecret: this.cipher.encrypt(secret, user.id) } });
    // Grouped in fours for people who type it in instead of scanning ("ABCD EFGH …").
    return { otpauthUri, manualKey: secret.replace(/(.{4})(?=.)/g, "$1 ") };
  }

  /**
   * Turning 2FA on, step 2: the first code from the app proves it was set up
   * right. Then 2FA is on and the 10 backup codes are returned (the only time
   * they're shown). A seller/admin doing this during sign-in is then signed in.
   */
  async enableTwoFactor(subject: { userId: string; challengeToken?: string | undefined }, code: string, client: ClientInfo): Promise<{ backupCodes: string[]; session?: SignInResult }> {
    const user = await this.activeUser(subject.userId);
    if (user.twoFactorEnabledAt) throw new AppError(409, "CONFLICT", "Two-step verification is already on.");
    if (!user.twoFactorSecret) throw new AppError(409, "CONFLICT", "Start the setup again to get a new QR code.");
    let challenge: Challenge | null = null;
    if (subject.challengeToken) {
      challenge = await this.challenges.find(subject.challengeToken);
      if (!challenge || challenge.type !== "two_factor_setup" || challenge.userId !== user.id) throw challengeExpired();
    }
    if (!(await this.totp.verify(user.id, this.secondFactor.decryptSecret(user), code))) {
      if (subject.challengeToken && (await this.challenges.countAttempt(subject.challengeToken)) === 0) throw challengeExpired();
      throw new AppError(400, "INVALID_CODE", "That code isn't right. Make sure the app shows Vendora and enter its newest code.");
    }

    const now = this.now();
    const result = await this.deps.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id: user.id }, data: { twoFactorEnabledAt: now, ...(challenge ? { lastLoginAt: now } : {}) } });
      const backupCodes = await this.backupCodes.replace(tx, user.id);
      await recordSecurityEvent(tx, user.id, "TWO_FA_ENABLED", client);
      if (!challenge) return { backupCodes };
      await recordSecurityEvent(tx, user.id, "LOGIN_OK", client);
      return { backupCodes, session: await this.startSession(tx, updated, challenge.keepSignedIn, client) };
    });
    if (subject.challengeToken) await this.challenges.remove(subject.challengeToken);
    this.mailer.send(twoFactorEnabledMessage(user.email, user.name, this.deps.config.APP_URL));
    return result;
  }

  /** Shoppers only (it's required for sellers and admins). Needs a current app code or a backup code. */
  async disableTwoFactor(claims: AccessClaims, input: SecondFactorInput, client: ClientInfo): Promise<void> {
    const user = await this.activeUser(claims.userId);
    if (requiresTwoFactor(user.role)) throw new AppError(403, "FORBIDDEN", "Two-step verification is required for seller and admin accounts.");
    if (!user.twoFactorEnabledAt) throw new AppError(409, "CONFLICT", "Two-step verification is already off.");
    await this.secondFactor.check(user, input, client);
    await this.deps.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { twoFactorSecret: null, twoFactorEnabledAt: null } });
      await tx.backupCode.deleteMany({ where: { userId: user.id } });
      await this.trustedDevices.revokeAll(tx, user.id);
      await recordSecurityEvent(tx, user.id, "TWO_FA_DISABLED", client);
    });
    this.mailer.send(twoFactorDisabledMessage(user.email, user.name, this.deps.config.APP_URL));
  }

  /** A new set of 10 backup codes (the old ones stop working). Needs a current app code, not a backup code. */
  async renewBackupCodes(claims: AccessClaims, code: string, client: ClientInfo): Promise<string[]> {
    const user = await this.activeUser(claims.userId);
    if (!user.twoFactorEnabledAt) throw new AppError(409, "CONFLICT", "Turn on two-step verification first.");
    await this.secondFactor.check(user, { code }, client);
    return this.deps.prisma.$transaction(async (tx) => {
      const codes = await this.backupCodes.replace(tx, user.id);
      await recordSecurityEvent(tx, user.id, "BACKUP_CODES_RENEWED", client);
      return codes;
    });
  }

  /** Waits for emails still being sent (graceful shutdown). */
  async drain(): Promise<void> {
    await this.mailer.drain();
  }

  // --- helpers --------------------------------------------------------------

  /**
   * After a correct password (or reset link): signed in now, or one more step.
   * A trusted device skips the 2FA code; sellers/admins without 2FA must set it up first.
   */
  private async completeSignIn(user: User, keepSignedIn: boolean, client: ClientInfo, trustedDeviceToken?: string): Promise<SignInOutcome> {
    if (user.twoFactorEnabledAt) {
      if (!(await this.trustedDevices.isTrusted(user.id, trustedDeviceToken))) {
        return { kind: "challenge", challenge: await this.challenges.create({ userId: user.id, type: "two_factor", keepSignedIn }) };
      }
    } else if (requiresTwoFactor(user.role)) {
      return { kind: "challenge", challenge: await this.challenges.create({ userId: user.id, type: "two_factor_setup", keepSignedIn }) };
    }
    const now = this.now();
    const session = await this.deps.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
      await recordSecurityEvent(tx, user.id, "LOGIN_OK", client);
      return this.startSession(tx, updated, keepSignedIn, client);
    });
    return { kind: "signed_in", session };
  }

  private async activeUser(userId: string): Promise<User> {
    const user = await this.deps.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt || user.status !== "ACTIVE") throw notSignedIn();
    return user;
  }

  private async startSession(
    tx: Db,
    user: User,
    persistent: boolean,
    client: ClientInfo,
    chain?: { familyId: string; expiresAt: Date }
  ): Promise<SignInResult> {
    const refreshToken = randomToken(32);
    const lifetime = persistent ? SESSION_TTL_MS.persistent : SESSION_TTL_MS.browser;
    const session = await tx.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: sha256Hex(refreshToken), // only the hash is stored: a stolen database can't be used to sign in
        familyId: chain?.familyId ?? randomUUID(),
        userAgent: client.userAgent?.slice(0, 512) ?? null,
        ipAddress: client.ip.slice(0, 45),
        location: client.location?.slice(0, 100) ?? null,
        persistent,
        expiresAt: chain?.expiresAt ?? new Date(this.now().getTime() + lifetime)
      }
    });
    const accessToken = await this.deps.tokens.signAccess({ userId: user.id, sessionId: session.id, familyId: session.familyId, role: user.role });
    return { user: toPublicUser(user), accessToken, refreshToken, persistent, expiresAt: session.expiresAt };
  }

  /**
   * After a password reset or change: every access pass issued before now is
   * refused (checklist: "deny JWTs issued before a password change"), the ended
   * chains stop at once, and the owner is told by email.
   */
  private async afterPasswordChange(user: User, endedFamilies: string[], changedAt: Date) {
    const changedAtSeconds = Math.floor(changedAt.getTime() / 1000);
    await bestEffort(this.deps.logger, "password-change time not saved; older access passes stay valid up to 15 minutes", () => this.deps.kv.set(authKeys.invalidBefore(user.id), String(changedAtSeconds), ACCESS_TTL_SECONDS + 60));
    await this.revoker.markFamiliesRevoked(endedFamilies);
    this.mailer.send(passwordChangedMessage(user.email, user.name, this.deps.config.APP_URL));
  }

  private async sendVerificationCode(user: User, { force }: { force: boolean }) {
    const { kv } = this.deps;
    const account = emailKey(user.email);
    const cooldown = authKeys.verifyCooldown(account);
    if (force) await kv.set(cooldown, "1", VERIFY_RESEND_COOLDOWN_SECONDS);
    else if (!(await kv.setIfAbsent(cooldown, "1", VERIFY_RESEND_COOLDOWN_SECONDS))) return; // one email per minute
    if ((await kv.increment(authKeys.codesToday(account), 24 * 60 * 60)) > MAX_CODES_PER_DAY) return;
    const code = await this.codes.issue(user.id, "EMAIL_VERIFY", VERIFY_CODE_TTL_SECONDS);
    this.mailer.send(verifyEmailMessage(user.email, code, VERIFY_CODE_TTL_SECONDS / 60));
  }

  private verificationSent(email: string) {
    return { status: "verification_sent" as const, email, codeExpiresInSeconds: VERIFY_CODE_TTL_SECONDS };
  }
}
