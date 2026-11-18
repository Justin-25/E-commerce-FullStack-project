import type { RequestHandler } from "express";
import type { Role } from "../generated/prisma/enums.js";
import { AppError, DependencyUnavailableError } from "../lib/errors.js";
import type { KeyValueStore } from "../lib/kv.js";
import type { Logger } from "../lib/logger.js";
import { authKeys } from "../modules/auth/keys.js";
import type { TokenService } from "../modules/auth/tokens.js";

export interface AuthGuards {
  /** Reads the access pass if there is one and sets req.auth. Never rejects (for pages that work signed in or out). */
  authenticate: RequestHandler;
  /** 401 unless signed in. */
  requireAuth: RequestHandler[];
  /** 403 unless the signed-in user has one of these roles (use after requireAuth). */
  requireRole: (...roles: Role[]) => RequestHandler;
}

/**
 * Checks the access pass on every request without a database query: the JWT
 * signature and expiry, plus ONE Redis round trip for the three ways a pass can
 * be cancelled early (signed out, sign-in chain revoked, password changed).
 *
 * If Redis is down, a validly signed pass is still accepted (logged), so
 * signed-in shoppers can keep browsing and buying during a short outage. The
 * trade-off: a pass signed out in the last 15 minutes works again until Redis
 * is back. Refreshing still checks the database, so revoked sign-ins can't renew.
 */
export function createAuthGuards({ tokens, kv, logger }: { tokens: TokenService; kv: KeyValueStore; logger?: Logger }): AuthGuards {
  const authenticate: RequestHandler = async (req, _res, next) => {
    const token: unknown = req.cookies?.[tokens.cookieNames.access];
    if (typeof token !== "string" || token === "") return next();
    const claims = await tokens.verifyAccess(token);
    if (!claims) return next();
    try {
      const [denied, familyRevoked, invalidBefore] = await kv.getMany([
        authKeys.deniedAccess(claims.jti),
        authKeys.revokedFamily(claims.familyId),
        authKeys.invalidBefore(claims.userId)
      ]);
      if (denied || familyRevoked || (invalidBefore && claims.issuedAt < Number(invalidBefore))) return next();
    } catch (err) {
      if (!(err instanceof DependencyUnavailableError)) throw err;
      logger?.warn({ userId: claims.userId, err: err.cause }, "redis unavailable: access pass accepted without the sign-out check");
    }
    req.auth = claims;
    next();
  };

  const ensureSignedIn: RequestHandler = (req, _res, next) =>
    next(req.auth ? undefined : new AppError(401, "UNAUTHORIZED", "Please sign in to continue."));

  const requireRole =
    (...roles: Role[]): RequestHandler =>
    (req, _res, next) => {
      if (!req.auth) return next(new AppError(401, "UNAUTHORIZED", "Please sign in to continue."));
      next(roles.includes(req.auth.role) ? undefined : new AppError(403, "FORBIDDEN", "You don't have access to this."));
    };

  return { authenticate, requireAuth: [authenticate, ensureSignedIn], requireRole };
}
