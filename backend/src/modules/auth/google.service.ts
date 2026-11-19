import type { Config } from "../../config/env.js";
import { Prisma, type PrismaClient, type User } from "../../generated/prisma/client.js";
import { BackgroundMailer } from "../../lib/backgroundMailer.js";
import type { EmailSender } from "../../lib/email.js";
import { createFieldCipher, type FieldCipher } from "../../lib/encryption.js";
import { AppError } from "../../lib/errors.js";
import { newGoogleFlow, type GoogleIdentity, type GoogleProfile } from "../../lib/google.js";
import type { KeyValueStore } from "../../lib/kv.js";
import type { Logger } from "../../lib/logger.js";
import { googleConnectedMessage, googleDisconnectedMessage } from "./auth.emails.js";
import type { AuthService, SignInOutcome } from "./auth.service.js";
import { notSignedIn, reauthRequired } from "./authErrors.js";
import { recordSecurityEvent, type ClientInfo } from "./events.js";
import { connectGoogle } from "./googleAccounts.js";
import { authKeys } from "./keys.js";
import type { AccessClaims } from "./tokens.js";

/** A Google sign-in attempt must finish within 10 minutes. */
const FLOW_TTL_MS = 10 * 60 * 1000;
const STATE_CONTEXT = "google-oauth-state";

/** Codes the frontend shows on /sign-in?error=… (or /account/security?error=…). */
export type GoogleErrorCode =
  | "google_unavailable"
  | "google_cancelled"
  | "google_failed"
  | "google_email_unverified"
  | "google_already_used"
  | "google_account_mismatch"
  | "account_suspended"
  | "reauth_required"
  | "sign_in_required";

export class GoogleFlowError extends Error {
  /** `mode`: where the frontend shows it (sign-in page, or Security settings for "connect"). */
  constructor(
    readonly code: GoogleErrorCode,
    readonly mode: "sign_in" | "connect" = "sign_in"
  ) {
    super(code);
    this.name = "GoogleFlowError";
  }
}

interface FlowState {
  state: string;
  nonce: string;
  codeVerifier: string;
  keepSignedIn: boolean;
  mode: "sign_in" | "connect";
  /** For "connect": the signed-in account that started it. */
  userId?: string;
  startedAt: number;
}

export interface GoogleCallbackResult {
  /** Where to send the browser in the frontend. */
  redirectTo: string;
  /** For sign-in: signed in, or the next step (2FA code / set-up / "enter your password to connect Google"). */
  outcome?: SignInOutcome;
}

export interface GoogleServiceDeps {
  prisma: PrismaClient;
  kv: KeyValueStore;
  auth: AuthService;
  /** null when GOOGLE_CLIENT_ID/SECRET aren't set: the feature is off. */
  identity: GoogleIdentity | null;
  email: EmailSender;
  config: Pick<Config, "APP_URL" | "GOOGLE_REDIRECT_URI" | "DATA_ENCRYPTION_KEY">;
  logger?: Logger;
  now?: () => Date;
}

/**
 * "Continue with Google" (OAuth 2.0 authorization code + PKCE, OpenID Connect).
 * Google only replaces the password: 2FA, seller/admin rules and trusted
 * devices work the same as after a password.
 */
export class GoogleService {
  private readonly cipher: FieldCipher;
  private readonly mailer: BackgroundMailer;
  private readonly now: () => Date;
  readonly redirectUri: string;

  constructor(private readonly deps: GoogleServiceDeps) {
    this.cipher = createFieldCipher(deps.config.DATA_ENCRYPTION_KEY);
    this.mailer = new BackgroundMailer(deps.email, deps.logger);
    this.now = deps.now ?? (() => new Date());
    this.redirectUri = deps.config.GOOGLE_REDIRECT_URI ?? `${deps.config.APP_URL}/api/v1/auth/google/callback`;
  }

  get enabled(): boolean {
    return this.deps.identity !== null;
  }

  /**
   * Step 1: the URL of Google's account chooser, plus the encrypted state for an
   * httpOnly cookie (state, nonce and PKCE verifier never reach page JavaScript).
   * "connect" (from Security settings) needs a signed-in user who did "Confirm it's you".
   */
  async start(input: { mode: "sign_in" | "connect"; keepSignedIn: boolean; claims?: AccessClaims | undefined }): Promise<{ url: string; stateCookie: string }> {
    const { identity, kv } = this.deps;
    if (!identity) throw new GoogleFlowError("google_unavailable", input.mode);
    if (input.mode === "connect") {
      if (!input.claims) throw new GoogleFlowError("sign_in_required", "connect");
      if (!(await kv.get(authKeys.confirmed(input.claims.familyId)))) throw new GoogleFlowError("reauth_required", "connect");
    }
    const flow = await newGoogleFlow();
    const url = await identity.authorizationUrl({ redirectUri: this.redirectUri, state: flow.state, nonce: flow.nonce, codeChallenge: flow.codeChallenge });
    const state: FlowState = {
      state: flow.state,
      nonce: flow.nonce,
      codeVerifier: flow.codeVerifier,
      keepSignedIn: input.keepSignedIn,
      mode: input.mode,
      ...(input.claims && input.mode === "connect" ? { userId: input.claims.userId } : {}),
      startedAt: this.now().getTime()
    };
    return { url: url.toString(), stateCookie: this.cipher.encrypt(JSON.stringify(state), STATE_CONTEXT) };
  }

  /** Step 2: Google sent the browser back. Check everything, then sign in / connect / ask for the password. */
  async callback(input: {
    query: Record<string, string>;
    stateCookie: string | undefined;
    claims: AccessClaims | undefined;
    client: ClientInfo;
    trustedDeviceToken: string | undefined;
  }): Promise<GoogleCallbackResult> {
    const { identity } = this.deps;
    if (!identity) throw new GoogleFlowError("google_unavailable");
    const flow = this.readState(input.stateCookie);
    if (input.query.error) throw new GoogleFlowError(input.query.error === "access_denied" ? "google_cancelled" : "google_failed", flow.mode);

    // Rebuild the callback URL from the registered redirect address (not from this request's host,
    // which differs behind a proxy), so Google sees exactly the redirect_uri it knows.
    const callbackUrl = new URL(this.redirectUri);
    for (const [key, value] of Object.entries(input.query)) callbackUrl.searchParams.set(key, value);
    let profile: GoogleProfile;
    try {
      profile = await identity.exchangeCode({ callbackUrl, state: flow.state, nonce: flow.nonce, codeVerifier: flow.codeVerifier });
    } catch (err) {
      this.deps.logger?.warn({ err: { message: (err as Error).message } }, "google sign-in: code exchange or ID token check failed");
      throw new GoogleFlowError("google_failed", flow.mode);
    }
    if (!profile.emailVerified) throw new GoogleFlowError("google_email_unverified", flow.mode);

    return flow.mode === "connect" ? this.connect(flow, profile, input.claims, input.client) : this.signIn(flow, profile, input.client, input.trustedDeviceToken);
  }

  /** Security settings: disconnect Google. Needs "Confirm it's you" and a password (so the account can still be used). */
  async disconnect(claims: AccessClaims, client: ClientInfo): Promise<void> {
    const { prisma, kv } = this.deps;
    const user = await this.activeUser(claims.userId);
    if (!(await kv.get(authKeys.confirmed(claims.familyId)))) throw reauthRequired();
    if (!user.passwordHash) {
      throw new AppError(409, "CONFLICT", 'Add a password first (use "Forgot password?" on the sign-in page), so you can still sign in without Google.');
    }
    const removed = await prisma.$transaction(async (tx) => {
      const { count } = await tx.oAuthAccount.deleteMany({ where: { userId: user.id, provider: "GOOGLE" } });
      if (count > 0) await recordSecurityEvent(tx, user.id, "GOOGLE_DISCONNECTED", client);
      return count;
    });
    if (removed === 0) throw new AppError(409, "CONFLICT", "Google sign-in isn't connected.");
    this.mailer.send(googleDisconnectedMessage(user.email, user.name, this.deps.config.APP_URL));
  }

  async drain(): Promise<void> {
    await this.mailer.drain();
  }

  // --- the callback cases ----------------------------------------------------

  private async signIn(flow: FlowState, profile: GoogleProfile, client: ClientInfo, trustedDeviceToken: string | undefined): Promise<GoogleCallbackResult> {
    const { prisma, auth } = this.deps;
    const google = { sub: profile.sub, email: profile.email };

    // 1. This Google account is already connected: sign in to that Vendora account.
    const linked = await prisma.oAuthAccount.findUnique({ where: { provider_providerUserId: { provider: "GOOGLE", providerUserId: profile.sub } }, include: { user: true } });
    if (linked) {
      const user = this.usable(linked.user);
      if (linked.email !== profile.email) await prisma.oAuthAccount.update({ where: { id: linked.id }, data: { email: profile.email } });
      return this.toResult(await auth.signInWithGoogle(user, flow.keepSignedIn, client, trustedDeviceToken));
    }

    const existing = await prisma.user.findUnique({ where: { email: profile.email } });

    // 2. New to Vendora: create a shopper account with the verified Google email and no password.
    if (!existing) {
      let created: User;
      try {
        created = await prisma.$transaction(async (tx) => {
          const user = await tx.user.create({ data: { email: profile.email, name: profile.name, emailVerifiedAt: this.now() } });
          await connectGoogle(tx, user.id, google, client);
          return user;
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new GoogleFlowError("google_failed"); // signed up a moment ago
        throw err;
      }
      return this.toResult(await auth.signInWithGoogle(created, flow.keepSignedIn, client, trustedDeviceToken));
    }

    const user = this.usable(existing);

    // 3. An account that was never verified: Google just proved who owns the inbox. Whoever
    //    pre-registered this email can't keep a password on it, so it's erased.
    if (!user.emailVerifiedAt) {
      const taken = await prisma.$transaction(async (tx) => {
        const updated = await tx.user.update({ where: { id: user.id }, data: { passwordHash: null, emailVerifiedAt: this.now() } });
        await tx.authToken.deleteMany({ where: { userId: user.id } });
        await connectGoogle(tx, user.id, google, client);
        return updated;
      });
      return this.toResult(await auth.signInWithGoogle(taken, flow.keepSignedIn, client, trustedDeviceToken));
    }

    // 4. A verified account with a password: ask for that password once, then connect (the user's choice).
    if (user.passwordHash) {
      const challenge = await auth.startGoogleLink(user, google, flow.keepSignedIn);
      return this.toResult({ kind: "challenge", challenge });
    }

    // 5. Verified, no password, connected to a DIFFERENT Google account: don't guess.
    throw new GoogleFlowError("google_account_mismatch");
  }

  private async connect(flow: FlowState, profile: GoogleProfile, claims: AccessClaims | undefined, client: ClientInfo): Promise<GoogleCallbackResult> {
    // The same signed-in account that started the flow must still be signed in.
    if (!claims || !flow.userId || claims.userId !== flow.userId) throw new GoogleFlowError("sign_in_required", "connect");
    const user = await this.activeUser(claims.userId);
    try {
      await this.deps.prisma.$transaction((tx) => connectGoogle(tx, user.id, { sub: profile.sub, email: profile.email }, client));
    } catch (err) {
      if (err instanceof AppError && err.status === 409) throw new GoogleFlowError("google_already_used", "connect");
      throw err;
    }
    this.mailer.send(googleConnectedMessage(user.email, user.name, profile.email, this.deps.config.APP_URL));
    return { redirectTo: `${this.deps.config.APP_URL}/account/security?google=connected` };
  }

  // --- helpers --------------------------------------------------------------

  /** Where the frontend should show the result of a Google sign-in. */
  private toResult(outcome: SignInOutcome): GoogleCallbackResult {
    const app = this.deps.config.APP_URL;
    if (outcome.kind === "signed_in") return { redirectTo: `${app}/`, outcome };
    const step = { two_factor: "two-factor", two_factor_setup: "two-factor-setup", google_link: "google-link" }[outcome.challenge.type];
    return { redirectTo: `${app}/sign-in?step=${step}`, outcome };
  }

  private readState(cookie: string | undefined): FlowState {
    if (!cookie) throw new GoogleFlowError("google_failed");
    let flow: FlowState;
    try {
      flow = JSON.parse(this.cipher.decrypt(cookie, STATE_CONTEXT)) as FlowState;
    } catch {
      throw new GoogleFlowError("google_failed"); // tampered or from another server key
    }
    if (this.now().getTime() - flow.startedAt > FLOW_TTL_MS) throw new GoogleFlowError("google_failed");
    return flow;
  }

  private usable(user: User): User {
    if (user.deletedAt || user.status !== "ACTIVE") throw new GoogleFlowError("account_suspended");
    return user;
  }

  private async activeUser(userId: string): Promise<User> {
    const user = await this.deps.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt || user.status !== "ACTIVE") throw notSignedIn();
    return user;
  }
}
