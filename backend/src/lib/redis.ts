import { Redis } from "ioredis";
import type { Logger } from "./logger.js";

/**
 * One shared Redis connection (Upstash uses a TLS "rediss://" URL).
 * Commands fail after 2 retries instead of hanging, so a Redis outage shows
 * up quickly in /ready and in the logs.
 */
export function createRedis(url: string, logger: Logger): Redis {
  const client = new Redis(url, { maxRetriesPerRequest: 2, connectTimeout: 5000 });
  client.on("error", (err: Error) => logger.error({ err: { message: err.message } }, "redis connection error"));
  return client;
}
