import { doubleCsrf } from "csrf-csrf";
import type { Request, RequestHandler, Response } from "express";
import type { Config } from "../config/env.js";
import { AppError } from "../lib/errors.js";
import { randomToken } from "../lib/crypto.js";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF layer 1: a state-changing request whose Origin header is not our
 * frontend is refused. Browsers always send Origin on POST, and attackers'
 * pages can't fake it. Requests with no Origin (curl, server-to-server, PayMongo
 * webhooks later) are allowed unless the browser says they're cross-site.
 */
export function originCheck(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, _res, next) => {
    if (!UNSAFE_METHODS.has(req.method)) return next();
    const origin = req.get("origin");
    const blocked = origin !== undefined ? !allowed.has(origin) : req.get("sec-fetch-site") === "cross-site";
    if (blocked) return next(new AppError(403, "CSRF_INVALID", "This request came from another website and was blocked."));
    next();
  };
}

export interface Csrf {
  /** CSRF layer 2: checks the X-CSRF-Token header on POST/PUT/PATCH/DELETE. */
  protect: RequestHandler;
  /** Returns a token for this browser. `rotate` at sign-in/sign-out makes old tokens stop working. */
  issue(req: Request, res: Response, options?: { rotate?: boolean }): string;
}

/**
 * Signed double-submit token (csrf-csrf, the maintained successor of csurf).
 * The token is an HMAC tied to a random per-browser id cookie that changes at
 * sign-in and sign-out, so a token stolen before sign-in is useless after it.
 */
export function createCsrf(config: Pick<Config, "CSRF_SECRET" | "NODE_ENV">): Csrf {
  const secure = config.NODE_ENV === "production";
  const idCookie = secure ? "__Host-vd_csid" : "vd_csid";

  const { doubleCsrfProtection, generateCsrfToken } = doubleCsrf({
    getSecret: () => config.CSRF_SECRET,
    getSessionIdentifier: (req) => String(req.cookies?.[idCookie] ?? ""),
    cookieName: secure ? "__Host-vd_csrf" : "vd_csrf",
    cookieOptions: { sameSite: "strict", path: "/", secure, httpOnly: true },
    getCsrfTokenFromRequest: (req) => req.get("x-csrf-token"),
    // Payment providers can't send our token; webhooks are verified by signature instead (milestone 5).
    // Mail apps' one-click unsubscribe can't either; its link carries a signed token instead (6b).
    skipCsrfProtection: (req) => req.path.startsWith("/api/v1/webhooks/") || req.path === "/api/v1/notifications/unsubscribe"
  });

  return {
    protect: doubleCsrfProtection,
    issue(req, res, { rotate = false } = {}) {
      let id: unknown = req.cookies?.[idCookie];
      const renew = rotate || typeof id !== "string" || id === "";
      if (renew) {
        id = randomToken(16);
        res.cookie(idCookie, id, { httpOnly: true, sameSite: "lax", secure, path: "/" });
        req.cookies = { ...req.cookies, [idCookie]: id }; // the token below must be tied to the NEW id
      }
      return generateCsrfToken(req, res, { overwrite: renew });
    }
  };
}
