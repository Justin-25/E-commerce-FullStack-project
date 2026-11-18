import { Router, type Request, type Response } from "express";
import { ipKeyGenerator, type Store } from "express-rate-limit";
import type { Config } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";
import type { AuthGuards } from "../../middleware/auth.js";
import type { Csrf } from "../../middleware/csrf.js";
import { rateLimiter } from "../../middleware/rateLimit.js";
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resendSchema,
  resetPasswordSchema,
  verifyEmailSchema
} from "./auth.schemas.js";
import type { AuthService, ClientInfo, SignInResult } from "./auth.service.js";
import type { TokenService } from "./tokens.js";

export interface AuthRouterDeps {
  service: AuthService;
  tokens: TokenService;
  csrf: Csrf;
  guards: AuthGuards;
  config: Pick<Config, "AUTH_RATE_LIMIT_MAX">;
  /** Redis store for the stricter auth limit (in-memory when omitted). */
  rateLimitStore?: Store;
}

const clientInfo = (req: Request): ClientInfo => {
  const ip = req.ip ?? "unknown";
  return { ip, ipKey: ipKeyGenerator(ip, 56), userAgent: req.get("user-agent") };
};

/** Thin HTTP layer: validate input (allow-lists), call the service, set cookies. */
export function authRouter({ service, tokens, csrf, guards, config, rateLimitStore }: AuthRouterDeps): Router {
  const router = Router();
  // Stricter per-IP limit on endpoints that guess passwords or send emails.
  const authLimit = rateLimiter({ windowMs: 15 * 60 * 1000, limit: config.AUTH_RATE_LIMIT_MAX, ...(rateLimitStore ? { store: rateLimitStore } : {}) });

  const signIn = (req: Request, res: Response, result: SignInResult) => {
    tokens.setSessionCookies(res, result);
    // Signing in changes the CSRF id, so the page needs the new token.
    res.json({ user: result.user, csrfToken: csrf.issue(req, res, { rotate: true }) });
  };

  router.get("/auth/csrf", (req, res) => {
    res.json({ csrfToken: csrf.issue(req, res) });
  });

  router.post("/auth/register", authLimit, async (req, res) => {
    res.status(202).json(await service.register(registerSchema.parse(req.body)));
  });

  router.post("/auth/verify-email", authLimit, async (req, res) => {
    signIn(req, res, await service.verifyEmail(verifyEmailSchema.parse(req.body), clientInfo(req)));
  });

  router.post("/auth/resend-verification", authLimit, async (req, res) => {
    res.status(202).json(await service.resendVerification(resendSchema.parse(req.body).email));
  });

  router.post("/auth/login", authLimit, async (req, res) => {
    signIn(req, res, await service.login(loginSchema.parse(req.body), clientInfo(req)));
  });

  router.post("/auth/refresh", async (req, res) => {
    try {
      const result = await service.refresh(req.cookies?.[tokens.cookieNames.refresh], clientInfo(req));
      tokens.setSessionCookies(res, result);
      res.json({ user: result.user });
    } catch (err) {
      if (err instanceof AppError && err.status === 401) tokens.clearSessionCookies(res);
      throw err;
    }
  });

  router.post("/auth/logout", guards.authenticate, async (req, res) => {
    await service.logout(req.cookies?.[tokens.cookieNames.refresh], req.auth);
    tokens.clearSessionCookies(res);
    res.json({ csrfToken: csrf.issue(req, res, { rotate: true }) });
  });

  router.post("/auth/forgot-password", authLimit, async (req, res) => {
    res.status(202).json(await service.forgotPassword(forgotPasswordSchema.parse(req.body).email));
  });

  router.post("/auth/reset-password", authLimit, async (req, res) => {
    signIn(req, res, await service.resetPassword(resetPasswordSchema.parse(req.body), clientInfo(req)));
  });

  router.post("/auth/change-password", authLimit, ...guards.requireAuth, async (req, res) => {
    if (!req.auth) throw new AppError(401, "UNAUTHORIZED", "Please sign in to continue.");
    const result = await service.changePassword(req.auth, changePasswordSchema.parse(req.body), clientInfo(req));
    tokens.setSessionCookies(res, result); // same browser, same person: the CSRF token stays valid
    res.json({ user: result.user });
  });

  router.get("/auth/me", ...guards.requireAuth, async (req, res) => {
    const user = req.auth ? await service.getUser(req.auth.userId) : null;
    if (!user) throw new AppError(401, "UNAUTHORIZED", "Please sign in to continue.");
    res.json({ user });
  });

  return router;
}
