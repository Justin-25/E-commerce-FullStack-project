import express, { type Express, type Router } from "express";
import type { Store } from "express-rate-limit";
import type { Config } from "./config/env.js";
import type { Logger } from "./lib/logger.js";
import { createQueryParser } from "./lib/queryParser.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import { rateLimiter } from "./middleware/rateLimit.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { securityMiddleware } from "./middleware/security.js";
import { healthRouter, type ReadinessChecks } from "./modules/health/health.routes.js";

// Query keys allowed to repeat (?category=a&category=b). Filled in as modules need them.
const REPEATABLE_QUERY_KEYS: readonly string[] = [];

export interface AppOptions {
  config: Config;
  logger: Logger;
  /** Readiness checks by name, e.g. { redis: () => redis.ping(), database: null }. */
  checks?: ReadinessChecks;
  /** Shared rate-limit store (Redis in real runs, in-memory when omitted). */
  rateLimitStore?: Store;
  /** Feature routers, mounted under /api/v1 (auth, products… from milestone 3). */
  routers?: Router[];
  /** How long each readiness check may take before it counts as down. */
  readinessTimeoutMs?: number;
}

/**
 * Builds the Express app without starting a server, so tests can exercise the
 * exact same app with fake dependencies. Middleware order matters:
 * request ID/logging → security headers + CORS → rate limit → JSON body (10 KB)
 * → routes → 404 → error handler.
 */
export function createApp({ config, logger, checks = {}, rateLimitStore, routers = [], readinessTimeoutMs = 2000 }: AppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.TRUST_PROXY_HOPS);
  app.set("query parser", createQueryParser(REPEATABLE_QUERY_KEYS));

  app.use(requestLogger(logger));
  app.use(securityMiddleware(config));
  app.use(
    rateLimiter({
      windowMs: config.RATE_LIMIT_WINDOW_MS,
      limit: config.RATE_LIMIT_MAX,
      ...(rateLimitStore ? { store: rateLimitStore } : {}),
      skip: (req) => req.path === "/health"
    })
  );
  app.use(express.json({ limit: config.JSON_BODY_LIMIT, strict: true }));

  app.use(healthRouter(checks, readinessTimeoutMs));
  for (const router of routers) app.use("/api/v1", router);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
