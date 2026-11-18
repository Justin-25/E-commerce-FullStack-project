import { Redis } from "ioredis";
import type { Logger } from "./logger.js";

/** A Redis command that hasn't answered within this time fails (Upstash normally answers in tens of ms). */
export const REDIS_COMMAND_TIMEOUT_MS = 1000;

/**
 * One shared Redis connection (Upstash uses a TLS "rediss://" URL).
 * If Redis is unreachable, commands fail after 1 second instead of waiting in
 * a queue until it comes back, so callers can decide quickly what to do:
 * the general rate limit lets requests through, sign-in answers 503.
 */
export function createRedis(url: string, logger: Logger): Redis {
  const client = new Redis(url, { maxRetriesPerRequest: 2, connectTimeout: 5000, commandTimeout: REDIS_COMMAND_TIMEOUT_MS });
  client.on("error", (err: Error) => logger.error({ err: { message: err.message } }, "redis connection error"));
  return client;
}
