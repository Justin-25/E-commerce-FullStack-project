import { randomUUID } from "node:crypto";
import type { CookieOptions, Response } from "express";
import { SignJWT, jwtVerify } from "jose";
import type { Config } from "../../config/env.js";
import { Role } from "../../generated/prisma/enums.js";

export const ACCESS_TTL_SECONDS = 15 * 60;
/** How long a sign-in lasts: 30 days with "Keep me signed in", otherwise 1 day at most (and the cookie dies with the browser). */
export const SESSION_TTL_MS = { persistent: 30 * 24 * 60 * 60 * 1000, browser: 24 * 60 * 60 * 1000 } as const;
/** The refresh cookie is only ever sent to the sign-in endpoints, never to the rest of the API. */
export const REFRESH_COOKIE_PATH = "/api/v1/auth";

const ISSUER = "vendora-api";
const AUDIENCE = "vendora-web";
const ROLES = new Set<string>(Object.values(Role));

export interface AccessClaims {
  userId: string;
  sessionId: string;
  familyId: string;
  role: Role;
  jti: string;
  /** Unix seconds. */
  issuedAt: number;
  /** Unix seconds. */
  expiresAt: number;
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  persistent: boolean;
  expiresAt: Date;
}

/**
 * Signs and checks the 15-minute access pass (a JWT, HS256) and sets the
 * session cookies. Cookies are httpOnly (page JavaScript can't read them, so
 * XSS can't steal them), Secure in production, and SameSite so other websites
 * can't make the browser send them.
 */
export class TokenService {
  readonly cookieNames: { access: string; refresh: string };
  private readonly key: Uint8Array;
  private readonly secure: boolean;

  constructor(config: Pick<Config, "ACCESS_TOKEN_SECRET" | "NODE_ENV">) {
    this.key = new Uint8Array(Buffer.from(config.ACCESS_TOKEN_SECRET, "base64url"));
    this.secure = config.NODE_ENV === "production";
    // __Host- / __Secure- prefixes make browsers refuse these cookies unless they're Secure and set by us.
    this.cookieNames = this.secure ? { access: "__Host-vd_at", refresh: "__Secure-vd_rt" } : { access: "vd_at", refresh: "vd_rt" };
  }

  signAccess(input: { userId: string; sessionId: string; familyId: string; role: Role }): Promise<string> {
    return new SignJWT({ sid: input.sessionId, fid: input.familyId, role: input.role })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(input.userId)
      .setJti(randomUUID())
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
      .sign(this.key);
  }

  /** The pass's claims, or null if it's forged, expired, or not one of ours. */
  async verifyAccess(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"], clockTolerance: 5 });
      const { sub, sid, fid, role, jti, iat, exp } = payload;
      if (typeof sub !== "string" || typeof sid !== "string" || typeof fid !== "string" || typeof jti !== "string") return null;
      if (typeof iat !== "number" || typeof exp !== "number" || typeof role !== "string" || !ROLES.has(role)) return null;
      return { userId: sub, sessionId: sid, familyId: fid, role: role as Role, jti, issuedAt: iat, expiresAt: exp };
    } catch {
      return null;
    }
  }

  setSessionCookies(res: Response, session: IssuedSession): void {
    const base: CookieOptions = { httpOnly: true, secure: this.secure };
    res.cookie(this.cookieNames.access, session.accessToken, {
      ...base,
      sameSite: "lax",
      path: "/",
      ...(session.persistent ? { maxAge: ACCESS_TTL_SECONDS * 1000 } : {})
    });
    res.cookie(this.cookieNames.refresh, session.refreshToken, {
      ...base,
      sameSite: "strict",
      path: REFRESH_COOKIE_PATH,
      ...(session.persistent ? { expires: session.expiresAt } : {})
    });
  }

  clearSessionCookies(res: Response): void {
    res.clearCookie(this.cookieNames.access, { httpOnly: true, secure: this.secure, sameSite: "lax", path: "/" });
    res.clearCookie(this.cookieNames.refresh, { httpOnly: true, secure: this.secure, sameSite: "strict", path: REFRESH_COOKIE_PATH });
  }
}
