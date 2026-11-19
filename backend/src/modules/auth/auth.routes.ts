import { Router, type Request, type Response } from "express";
import { ipKeyGenerator, type Store } from "express-rate-limit";
import type { Config } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";
import { locationFrom } from "../../lib/location.js";
import type { Logger } from "../../lib/logger.js";
import type { AuthGuards } from "../../middleware/auth.js";
import type { Csrf } from "../../middleware/csrf.js";
import { rateLimiter } from "../../middleware/rateLimit.js";
import {
  activityQuerySchema,
  appCodeSchema,
  changeEmailSchema,
  changePasswordSchema,
  confirmSchema,
  emailCodeSchema,
  forgotPasswordSchema,
  googleLinkSchema,
  googleStartQuerySchema,
  loginSchema,
  registerSchema,
  resendSchema,
  resetPasswordSchema,
  sessionIdSchema,
  twoFactorDisableSchema,
  twoFactorVerifySchema,
  verifyEmailSchema
} from "./auth.schemas.js";
import type { AuthService, ClientInfo, SignInOutcome, SignInResult } from "./auth.service.js";
import { GoogleFlowError, type GoogleService } from "./google.service.js";
import type { SecurityService } from "./security.service.js";
import type { TokenService } from "./tokens.js";

export interface AuthRouterDeps {
  service: AuthService;
  /** Security settings: "Confirm it's you", devices, activity, change email (3d). */
  security: SecurityService;
  /** "Continue with Google" (3e). */
  google: GoogleService;
  tokens: TokenService;
  csrf: Csrf;
  guards: AuthGuards;
  config: Pick<Config, "AUTH_RATE_LIMIT_MAX" | "GEO_HEADERS" | "APP_URL">;
  /** Redis store for the stricter auth limit (in-memory when omitted). */
  rateLimitStore?: Store;
  logger?: Logger;
}

const notSignedIn = () => new AppError(401, "UNAUTHORIZED", "Please sign in to continue.");

/** What the page should show next after a correct password (or Google). */
const STEP_STATUS = { two_factor: "two_factor_required", two_factor_setup: "two_factor_setup_required", google_link: "google_link_required" } as const;

/** Thin HTTP layer: validate input (allow-lists), call the service, set cookies. */
export function authRouter({ service, security, google, tokens, csrf, guards, config, rateLimitStore, logger }: AuthRouterDeps): Router {
  const router = Router();

  const clientInfo = (req: Request): ClientInfo => {
    const ip = req.ip ?? "unknown";
    return { ip, ipKey: ipKeyGenerator(ip, 56), userAgent: req.get("user-agent"), location: locationFrom(req, config.GEO_HEADERS) };
  };
  // Stricter per-IP limit on endpoints that guess passwords or codes, or send emails. If Redis is down
  // it answers 503 before anything else runs: brute-force protection is never silently switched off.
  const authLimit = rateLimiter({
    windowMs: 15 * 60 * 1000,
    limit: config.AUTH_RATE_LIMIT_MAX,
    onStoreError: "refuse",
    ...(rateLimitStore ? { store: rateLimitStore } : {}),
    ...(logger ? { logger } : {})
  });

  const cookie = (req: Request, name: string): string | undefined => {
    const value: unknown = req.cookies?.[name];
    return typeof value === "string" && value !== "" ? value : undefined;
  };

  const signedIn = (req: Request, res: Response, session: SignInResult, extra: Record<string, unknown> = {}) => {
    tokens.setSessionCookies(res, session);
    tokens.clearChallengeCookie(res);
    // Signing in changes the CSRF id, so the page needs the new token.
    res.json({ status: "signed_in", user: session.user, csrfToken: csrf.issue(req, res, { rotate: true }), ...extra });
  };

  /** Either signed in, or "one more step": the step lives in a short httpOnly cookie, the page just shows the right screen. */
  const respond = (req: Request, res: Response, outcome: SignInOutcome) => {
    if (outcome.kind === "challenge") {
      const { token, type, expiresInSeconds } = outcome.challenge;
      tokens.setChallengeCookie(res, token, expiresInSeconds);
      res.json({ status: STEP_STATUS[type], expiresInSeconds });
      return;
    }
    if (outcome.trustedDevice) tokens.setTrustedDeviceCookie(res, outcome.trustedDevice.token, outcome.trustedDevice.expiresAt);
    signedIn(req, res, outcome.session, outcome.backupCodes ? { backupCodes: outcome.backupCodes } : {});
  };

  router.get("/auth/csrf", (req, res) => {
    res.json({ csrfToken: csrf.issue(req, res) });
  });

  router.post("/auth/register", authLimit, async (req, res) => {
    res.status(202).json(await service.register(registerSchema.parse(req.body)));
  });

  router.post("/auth/verify-email", authLimit, async (req, res) => {
    signedIn(req, res, await service.verifyEmail(verifyEmailSchema.parse(req.body), clientInfo(req)));
  });

  router.post("/auth/resend-verification", authLimit, async (req, res) => {
    res.status(202).json(await service.resendVerification(resendSchema.parse(req.body).email));
  });

  router.post("/auth/login", authLimit, async (req, res) => {
    respond(req, res, await service.login(loginSchema.parse(req.body), clientInfo(req), cookie(req, tokens.cookieNames.trustedDevice)));
  });

  router.post("/auth/refresh", async (req, res) => {
    try {
      const result = await service.refresh(cookie(req, tokens.cookieNames.refresh), clientInfo(req));
      tokens.setSessionCookies(res, result);
      res.json({ user: result.user });
    } catch (err) {
      if (err instanceof AppError && err.status === 401) tokens.clearSessionCookies(res);
      throw err;
    }
  });

  router.post("/auth/logout", guards.authenticate, async (req, res) => {
    await service.logout(cookie(req, tokens.cookieNames.refresh), req.auth);
    tokens.clearSessionCookies(res);
    res.json({ csrfToken: csrf.issue(req, res, { rotate: true }) });
  });

  router.post("/auth/forgot-password", authLimit, async (req, res) => {
    res.status(202).json(await service.forgotPassword(forgotPasswordSchema.parse(req.body).email));
  });

  router.post("/auth/reset-password", authLimit, async (req, res) => {
    respond(req, res, await service.resetPassword(resetPasswordSchema.parse(req.body), clientInfo(req)));
  });

  router.post("/auth/change-password", authLimit, ...guards.requireAuth, async (req, res) => {
    if (!req.auth) throw notSignedIn();
    const result = await service.changePassword(req.auth, changePasswordSchema.parse(req.body), clientInfo(req));
    tokens.setSessionCookies(res, result); // same browser, same person: the CSRF token stays valid
    res.json({ user: result.user });
  });

  router.get("/auth/me", ...guards.requireAuth, async (req, res) => {
    const user = req.auth ? await service.getUser(req.auth.userId) : null;
    if (!user) throw notSignedIn();
    res.json({ user });
  });

  // --- two-step verification (3c) ---

  router.post("/auth/2fa/verify", authLimit, async (req, res) => {
    const input = twoFactorVerifySchema.parse(req.body);
    respond(req, res, await service.verifyTwoFactor(cookie(req, tokens.cookieNames.challenge), input, clientInfo(req)));
  });

  router.get("/auth/2fa", ...guards.requireAuth, async (req, res) => {
    if (!req.auth) throw notSignedIn();
    res.json(await service.twoFactorStatus(req.auth.userId));
  });

  /** Set-up is allowed when signed in, or during sign-in for sellers/admins who must set it up first. */
  const setupSubject = async (req: Request) => {
    if (req.auth) return { userId: req.auth.userId };
    const challengeToken = cookie(req, tokens.cookieNames.challenge);
    const challenge = await service.findChallenge(challengeToken);
    if (challenge?.type === "two_factor_setup") return { userId: challenge.userId, challengeToken };
    throw notSignedIn();
  };

  router.post("/auth/2fa/setup", authLimit, guards.authenticate, async (req, res) => {
    const { userId } = await setupSubject(req);
    res.json(await service.startTwoFactorSetup(userId));
  });

  router.post("/auth/2fa/enable", authLimit, guards.authenticate, async (req, res) => {
    const subject = await setupSubject(req);
    const { code } = appCodeSchema.parse(req.body);
    const result = await service.enableTwoFactor(subject, code, clientInfo(req));
    if (result.session) signedIn(req, res, result.session, { backupCodes: result.backupCodes });
    else res.json({ backupCodes: result.backupCodes });
  });

  router.post("/auth/2fa/disable", authLimit, ...guards.requireAuth, async (req, res) => {
    if (!req.auth) throw notSignedIn();
    await service.disableTwoFactor(req.auth, twoFactorDisableSchema.parse(req.body), clientInfo(req));
    res.json({ enabled: false });
  });

  router.post("/auth/2fa/backup-codes", authLimit, ...guards.requireAuth, async (req, res) => {
    if (!req.auth) throw notSignedIn();
    const { code } = appCodeSchema.parse(req.body);
    res.json({ backupCodes: await service.renewBackupCodes(req.auth, code, clientInfo(req)) });
  });

  // --- account security (3d) ---

  const claimsOf = (req: Request) => {
    if (!req.auth) throw notSignedIn();
    return req.auth;
  };

  router.get("/auth/security", ...guards.requireAuth, async (req, res) => {
    res.json(await security.overview(claimsOf(req).userId));
  });

  router.get("/auth/confirm", ...guards.requireAuth, async (req, res) => {
    res.json(await security.confirmStatus(claimsOf(req)));
  });

  router.post("/auth/confirm/send-code", authLimit, ...guards.requireAuth, async (req, res) => {
    res.status(202).json(await security.sendConfirmCode(claimsOf(req)));
  });

  router.post("/auth/confirm", authLimit, ...guards.requireAuth, async (req, res) => {
    res.json(await security.confirm(claimsOf(req), confirmSchema.parse(req.body), clientInfo(req)));
  });

  router.get("/auth/sessions", ...guards.requireAuth, async (req, res) => {
    res.json({ sessions: await security.listSessions(claimsOf(req)) });
  });

  router.post("/auth/sessions/sign-out-others", ...guards.requireAuth, async (req, res) => {
    res.json(await security.signOutOthers(claimsOf(req), cookie(req, tokens.cookieNames.trustedDevice), clientInfo(req)));
  });

  router.post("/auth/sessions/:id/sign-out", ...guards.requireAuth, async (req, res) => {
    const { id } = sessionIdSchema.parse(req.params);
    const { current } = await security.signOutSession(claimsOf(req), id, clientInfo(req));
    if (!current) {
      res.json({ signedOut: true, current: false });
      return;
    }
    // "Sign out" on this device's own row is a normal sign-out.
    tokens.clearSessionCookies(res);
    res.json({ signedOut: true, current: true, csrfToken: csrf.issue(req, res, { rotate: true }) });
  });

  router.get("/auth/activity", ...guards.requireAuth, async (req, res) => {
    res.json(await security.activity(claimsOf(req).userId, activityQuerySchema.parse(req.query)));
  });

  router.post("/auth/email/change", authLimit, ...guards.requireAuth, async (req, res) => {
    res.status(202).json(await security.startEmailChange(claimsOf(req), changeEmailSchema.parse(req.body).newEmail));
  });

  router.post("/auth/email/change/confirm", authLimit, ...guards.requireAuth, async (req, res) => {
    res.json({ user: await security.confirmEmailChange(claimsOf(req), emailCodeSchema.parse(req.body).code, clientInfo(req)) });
  });

  // --- Google sign-in (3e) ---

  /** Is "Continue with Google" available? (The page hides the button when it isn't set up.) */
  router.get("/auth/google", (_req, res) => {
    res.json({ enabled: google.enabled });
  });

  /** The Google callback is a page load, not an API call: set the same cookies as a JSON sign-in, then redirect. */
  const applyOutcomeCookies = (req: Request, res: Response, outcome: SignInOutcome) => {
    if (outcome.kind === "challenge") {
      tokens.setChallengeCookie(res, outcome.challenge.token, outcome.challenge.expiresInSeconds);
      return;
    }
    if (outcome.trustedDevice) tokens.setTrustedDeviceCookie(res, outcome.trustedDevice.token, outcome.trustedDevice.expiresAt);
    tokens.setSessionCookies(res, outcome.session);
    tokens.clearChallengeCookie(res);
    csrf.issue(req, res, { rotate: true }); // a new CSRF id; the page then gets its token from GET /auth/csrf
  };

  const errorPage = (mode: "sign_in" | "connect", code: string) =>
    `${config.APP_URL}${mode === "connect" ? "/account/security" : "/sign-in"}?error=${encodeURIComponent(code)}`;

  /** "Continue with Google": a page load that sends the browser to Google's account chooser. */
  router.get("/auth/google/start", authLimit, guards.authenticate, async (req, res) => {
    const { mode, keepSignedIn } = googleStartQuerySchema.parse(req.query);
    try {
      const { url, stateCookie } = await google.start({ mode, keepSignedIn, claims: req.auth });
      tokens.setGoogleStateCookie(res, stateCookie);
      res.redirect(302, url);
    } catch (err) {
      if (!(err instanceof GoogleFlowError)) throw err;
      res.redirect(302, errorPage(err.mode, err.code));
    }
  });

  /** Google sends the browser back here. Every outcome is a redirect to the right frontend page. */
  router.get("/auth/google/callback", guards.authenticate, async (req, res) => {
    const stateCookie = cookie(req, tokens.cookieNames.googleState);
    tokens.clearGoogleStateCookie(res); // each attempt works once
    const query = Object.fromEntries(Object.entries(req.query).filter((e): e is [string, string] => typeof e[1] === "string"));
    try {
      const result = await google.callback({
        query,
        stateCookie,
        claims: req.auth,
        client: clientInfo(req),
        trustedDeviceToken: cookie(req, tokens.cookieNames.trustedDevice)
      });
      if (result.outcome) applyOutcomeCookies(req, res, result.outcome);
      res.redirect(302, result.redirectTo);
    } catch (err) {
      if (err instanceof GoogleFlowError) {
        res.redirect(302, errorPage(err.mode, err.code));
        return;
      }
      req.log.error({ err }, "google callback failed");
      res.redirect(302, errorPage("sign_in", "google_failed"));
    }
  });

  /** "This email already has a Vendora account. Sign in with your password to connect Google." */
  router.post("/auth/google/link", authLimit, async (req, res) => {
    const { password } = googleLinkSchema.parse(req.body);
    respond(req, res, await service.linkGoogleWithPassword(cookie(req, tokens.cookieNames.challenge), password, clientInfo(req), cookie(req, tokens.cookieNames.trustedDevice)));
  });

  router.post("/auth/google/disconnect", authLimit, ...guards.requireAuth, async (req, res) => {
    await google.disconnect(claimsOf(req), clientInfo(req));
    res.json({ connected: false });
  });

  return router;
}
