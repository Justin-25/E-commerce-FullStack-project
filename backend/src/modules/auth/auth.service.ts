import { randomUUID } from "node:crypto";
import type { Config } from "../../config/env.js";
import { Prisma, type PrismaClient, type SecurityEventType, type User } from "../../generated/prisma/client.js";
import type { BreachCheck } from "../../lib/breachedPasswords.js";
import { randomToken, sha256Hex } from "../../lib/crypto.js";
import type { EmailSender } from "../../lib/email.js";
import { AppError } from "../../lib/errors.js";
import type { KeyValueStore } from "../../lib/kv.js";
import { dummyHash, hashPassword, needsRehash, verifyPassword } from "../../lib/password.js";
import { accountExistsMessage, verifyEmailMessage } from "./auth.emails.js";
import type { LoginInput, RegisterInput, VerifyEmailInput } from "./auth.schemas.js";
import { OneTimeCodes } from "./codes.js";
import { authKeys, emailKey } from "./keys.js";
import { LoginLockout } from "./lockout.js";
import { ACCESS_TTL_SECONDS, SESSION_TTL_MS, type AccessClaims, type IssuedSession, type TokenService } from "./tokens.js";

type Db = Prisma.TransactionClient;

export const VERIFY_CODE_TTL_SECONDS = 10 * 60;
const VERIFY_RESEND_COOLDOWN_SECONDS = 60;
/** At most 10 codes per email per day: with 5 tries each, guessing a 6-digit code stays hopeless. */
const MAX_CODES_PER_DAY = 10;
/** "Someone tried to sign up with your email" goes out at most once an hour, so the form can't spam people. */
const ACCOUNT_EXISTS_NOTICE_SECONDS = 60 * 60;
/** Two tabs refreshing at the same moment: the slower one gets 409 instead of being treated as theft. */
export const REFRESH_GRACE_MS = 10_000;

export interface ClientInfo {
  ip: string;
  /** The IP grouped for counting (IPv6 by /56), so one person can't dodge limits by rotating addresses. */
  ipKey: string;
  userAgent?: string | undefined;
}

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
  config: Pick<Config, "APP_URL" | "CODE_HASH_SECRET">;
  isBreached: BreachCheck;
  now?: () => Date;
}

const invalidCode = () => new AppError(400, "INVALID_CODE", "That code isn't right or has expired. Check the latest email or request a new code.");
const notSignedIn = () => new AppError(401, "UNAUTHORIZED", "Please sign in to continue.");
const suspended = () => new AppError(403, "ACCOUNT_SUSPENDED", "This account is suspended. Contact Vendora support for help.");
const refreshConflict = () => new AppError(409, "CONFLICT", "You were just signed in again in another tab. Please retry.");
const locked = (retryAfterSeconds: number) =>
  new AppError(429, "ACCOUNT_LOCKED", "Too many sign-in attempts. Sign-in is paused for 15 minutes.", { details: { retryAfterSeconds } });

export class AuthService {
  private readonly codes: OneTimeCodes;
  private readonly lockout: LoginLockout;
  private readonly now: () => Date;

  constructor(private readonly deps: AuthServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.codes = new OneTimeCodes(deps.prisma, deps.config.CODE_HASH_SECRET, this.now);
    this.lockout = new LoginLockout(deps.kv);
    void dummyHash(); // prepare it now, so the first sign-in for an unknown email isn't slower than the rest
  }

  /**
   * Same answer whether or not the email is registered, so the form can't be
   * used to find out who shops on Vendora.
   */
  async register(input: RegisterInput) {
    const { prisma, kv, email, config } = this.deps;
    if (await this.deps.isBreached(input.password)) {
      throw new AppError(400, "VALIDATION_ERROR", "Some fields are invalid", {
        fields: [{ path: "password", message: "This password has appeared in a data breach. Choose one you don't use anywhere else." }]
      });
    }
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
      await email.send(accountExistsMessage(existing.email, existing.name, config.APP_URL));
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
    const codeId = await this.codes.check(user.id, "EMAIL_VERIFY", input.code);
    if (!codeId) throw invalidCode();
    if (user.status !== "ACTIVE") throw suspended();

    const now = this.now();
    return prisma.$transaction(async (tx) => {
      const used = await tx.authToken.updateMany({ where: { id: codeId, usedAt: null }, data: { usedAt: now } });
      if (used.count !== 1) throw invalidCode(); // used by a parallel request a moment ago
      const verified = await tx.user.update({ where: { id: user.id }, data: { emailVerifiedAt: now, lastLoginAt: now } });
      await this.recordEvent(tx, user.id, "LOGIN_OK", client);
      return this.startSession(tx, verified, input.keepSignedIn, client);
    });
  }

  async login(input: LoginInput, client: ClientInfo): Promise<SignInResult> {
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
        await this.recordEvent(prisma, user.id, "LOGIN_FAILED", client);
        if (result.locked) await this.recordEvent(prisma, user.id, "LOCKED", client);
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

    const upgradedHash = needsRehash(stored) ? await hashPassword(input.password) : null;
    const now = this.now();
    return prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: now, ...(upgradedHash ? { passwordHash: upgradedHash } : {}) } });
      await this.recordEvent(tx, user.id, "LOGIN_OK", client);
      return this.startSession(tx, updated, input.keepSignedIn, client);
    });
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
        await this.revokeFamily(session.familyId, "reuse_detected");
        await this.recordEvent(prisma, session.userId, "TOKEN_REUSE_DETECTED", client);
      }
      throw notSignedIn();
    }
    if (session.expiresAt <= now) throw notSignedIn();
    const { user } = session;
    if (user.status !== "ACTIVE" || user.deletedAt) {
      await this.revokeFamily(session.familyId, "user_inactive");
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
    if (familyId) await this.revokeFamily(familyId, "logout");
    if (claims) {
      const secondsLeft = claims.expiresAt - Math.floor(this.now().getTime() / 1000);
      await this.deps.kv.set(authKeys.deniedAccess(claims.jti), "1", Math.max(1, secondsLeft));
    }
  }

  /** The signed-in user, or null if the account was suspended or deleted since the pass was issued. */
  async getUser(userId: string): Promise<PublicUser | null> {
    const user = await this.deps.prisma.user.findUnique({ where: { id: userId } });
    return user && user.status === "ACTIVE" && !user.deletedAt ? toPublicUser(user) : null;
  }

  // --- helpers --------------------------------------------------------------

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
        persistent,
        expiresAt: chain?.expiresAt ?? new Date(this.now().getTime() + lifetime)
      }
    });
    const accessToken = await this.deps.tokens.signAccess({ userId: user.id, sessionId: session.id, familyId: session.familyId, role: user.role });
    return { user: toPublicUser(user), accessToken, refreshToken, persistent, expiresAt: session.expiresAt };
  }

  private async revokeFamily(familyId: string, reason: string) {
    await this.deps.prisma.session.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: this.now(), revokedReason: reason } });
    // Access passes from this family are refused until they would have expired anyway.
    await this.deps.kv.set(authKeys.revokedFamily(familyId), "1", ACCESS_TTL_SECONDS + 60);
  }

  private async sendVerificationCode(user: User, { force }: { force: boolean }) {
    const { kv, email } = this.deps;
    const account = emailKey(user.email);
    const cooldown = authKeys.verifyCooldown(account);
    if (force) await kv.set(cooldown, "1", VERIFY_RESEND_COOLDOWN_SECONDS);
    else if (!(await kv.setIfAbsent(cooldown, "1", VERIFY_RESEND_COOLDOWN_SECONDS))) return; // one email per minute
    if ((await kv.increment(authKeys.codesToday(account), 24 * 60 * 60)) > MAX_CODES_PER_DAY) return;
    const code = await this.codes.issue(user.id, "EMAIL_VERIFY", VERIFY_CODE_TTL_SECONDS);
    await email.send(verifyEmailMessage(user.email, code, VERIFY_CODE_TTL_SECONDS / 60));
  }

  private recordEvent(db: Db, userId: string, type: SecurityEventType, client: ClientInfo) {
    return db.securityEvent.create({
      data: { userId, type, ipAddress: client.ip.slice(0, 45), userAgent: client.userAgent?.slice(0, 512) ?? null }
    });
  }

  private verificationSent(email: string) {
    return { status: "verification_sent" as const, email, codeExpiresInSeconds: VERIFY_CODE_TTL_SECONDS };
  }
}
