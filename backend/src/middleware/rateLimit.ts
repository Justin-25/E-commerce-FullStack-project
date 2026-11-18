import type { RequestHandler } from "express";
import { rateLimit, type Options, type Store } from "express-rate-limit";
import { RedisStore, type RedisReply } from "rate-limit-redis";
import type { Redis } from "ioredis";
import { DependencyUnavailableError, errorBody } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";

interface LimiterOptions {
  windowMs: number;
  limit: number;
  store?: Store;
  skip?: Options["skip"];
  /**
   * What to do when the shared store (Redis) doesn't answer:
   * - "allow": let the request through without counting it, and log it (keeps the shop usable)
   * - "refuse": answer 503 SERVICE_UNAVAILABLE (for sign-in, where the limit must never be skipped)
   */
  onStoreError?: "allow" | "refuse";
  logger?: Logger;
}

/**
 * Per-IP rate limit (brute-force and DoS protection). Uses Redis when
 * configured, so the count is shared by every server instance; otherwise an
 * in-memory counter (fine for one dev server and for tests).
 * IPv6 addresses are grouped by /56 so one user can't rotate addresses.
 */
export function rateLimiter({ windowMs, limit, store, skip, onStoreError = "refuse", logger }: LimiterOptions): RequestHandler {
  const limiter = rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    passOnStoreError: onStoreError === "allow",
    ...(logger ? { logger } : {}),
    ...(store ? { store } : {}),
    ...(skip ? { skip } : {}),
    handler: (req, res, _next, options) => {
      res.status(options.statusCode).json(errorBody("RATE_LIMITED", "Too many requests. Please wait a moment and try again.", req.id));
    }
  });
  if (onStoreError === "allow") return limiter;
  // The limiter reports store failures with next(error); turn them into a clean 503.
  return (req, res, next) => limiter(req, res, (err?: unknown) => next(err ? new DependencyUnavailableError("rate-limit store", err) : undefined));
}

export function redisRateLimitStore(redis: Redis, prefix = "rl:global:"): Store {
  return new RedisStore({
    prefix,
    sendCommand: (command: string, ...args: string[]) => redis.call(command, ...args) as Promise<RedisReply>
  });
}
