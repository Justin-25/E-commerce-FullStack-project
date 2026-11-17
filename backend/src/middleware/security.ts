import cors from "cors";
import helmet from "helmet";
import type { RequestHandler } from "express";
import type { Config } from "../config/env.js";

/**
 * Security headers (helmet) + CORS.
 * CORS only answers allowed frontend origins and allows cookies, because the
 * login will use httpOnly cookies (milestone 3). Requests without an Origin
 * header (curl, server-to-server, uptime monitors) are not affected by CORS.
 */
export function securityMiddleware(config: Pick<Config, "CORS_ORIGINS">): RequestHandler[] {
  const allowed = new Set(config.CORS_ORIGINS);
  return [
    helmet(),
    cors({
      origin: (origin, callback) => callback(null, !origin || allowed.has(origin)),
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      allowedHeaders: ["Content-Type", "X-Request-Id", "X-CSRF-Token"],
      exposedHeaders: ["X-Request-Id", "RateLimit", "RateLimit-Policy", "Retry-After"],
      maxAge: 600
    })
  ];
}
