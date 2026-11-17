import { rateLimit, type Options, type Store } from "express-rate-limit";
import { RedisStore, type RedisReply } from "rate-limit-redis";
import type { Redis } from "ioredis";
import { errorBody } from "../lib/errors.js";

interface LimiterOptions {
  windowMs: number;
  limit: number;
  store?: Store;
  skip?: Options["skip"];
}

/**
 * Per-IP rate limit (brute-force and DoS protection). Uses Redis when
 * configured, so the count is shared by every server instance; otherwise an
 * in-memory counter (fine for one dev server and for tests).
 * IPv6 addresses are grouped by /56 so one user can't rotate addresses.
 */
export function rateLimiter({ windowMs, limit, store, skip }: LimiterOptions) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    ...(store ? { store } : {}),
    ...(skip ? { skip } : {}),
    handler: (req, res, _next, options) => {
      res.status(options.statusCode).json(errorBody("RATE_LIMITED", "Too many requests. Please wait a moment and try again.", req.id));
    }
  });
}

export function redisRateLimitStore(redis: Redis, prefix = "rl:global:"): Store {
  return new RedisStore({
    prefix,
    sendCommand: (command: string, ...args: string[]) => redis.call(command, ...args) as Promise<RedisReply>
  });
}
