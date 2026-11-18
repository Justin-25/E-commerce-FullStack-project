/** How the platform behaves when Redis is slow or unreachable. */
import { Router } from "express";
import type { Redis } from "ioredis";
import { pino } from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { DependencyUnavailableError } from "../src/lib/errors.js";
import { RedisKv } from "../src/lib/kv.js";
import { createRedis, REDIS_COMMAND_TIMEOUT_MS } from "../src/lib/redis.js";
import { rateLimiter } from "../src/middleware/rateLimit.js";
import { buildApp } from "./helpers.js";
import { FlakyStore } from "./support/flaky.js";

const capture = () => {
  const logs: { msg: string }[] = [];
  return { logs, logger: pino({ level: "warn" }, { write: (line: string) => void logs.push(JSON.parse(line)) }) };
};

describe("Redis client", () => {
  it(
    "gives up after about 1 second when Redis can't be reached, instead of waiting for it",
    async () => {
      const { logger } = capture();
      // 10.255.255.1 is a private address nothing answers on, like a network outage.
      const redis = createRedis("redis://10.255.255.1:6379", logger);
      const started = Date.now();
      await expect(redis.get("anything")).rejects.toThrow(/timed out/i);
      const elapsed = Date.now() - started;
      redis.disconnect();
      expect(elapsed).toBeGreaterThanOrEqual(REDIS_COMMAND_TIMEOUT_MS - 50);
      expect(elapsed).toBeLessThan(REDIS_COMMAND_TIMEOUT_MS + 1000);
    },
    10_000
  );

  it("RedisKv reports any failure as DependencyUnavailableError, so callers can tell it from bugs", async () => {
    const broken = { get: () => Promise.reject(new Error("Command timed out")) } as unknown as Redis;
    const err = await new RedisKv(broken).get("k").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DependencyUnavailableError);
    expect((err as DependencyUnavailableError).dependency).toBe("redis");
  });
});

describe("rate limits while their store is down", () => {
  it("the general limit lets requests through (shop stays usable) and logs it", async () => {
    const { logs, logger } = capture();
    const redis = { down: true };
    const app = buildApp({ rateLimitStore: new FlakyStore(redis), logger });
    const res = await request(app).get("/api/v1/query?q=shoes");
    expect(res.status).toBe(200);
    expect(logs.some((l) => l.msg.includes("allowing request without rate-limiting"))).toBe(true);
  });

  it("a limit set to 'refuse' answers 503 SERVICE_UNAVAILABLE with Retry-After", async () => {
    const redis = { down: true };
    const strict = Router().get("/strict", rateLimiter({ windowMs: 60_000, limit: 5, store: new FlakyStore(redis), onStoreError: "refuse" }), (_req, res) => {
      res.json({ ok: true });
    });
    const { logs, logger } = capture();
    const app = buildApp({ routers: [strict], logger });
    const res = await request(app).get("/api/v1/strict");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(res.headers["retry-after"]).toBe("30");
    // Logged once, with its cause, and not mistaken for a bug.
    expect(logs.filter((l) => l.msg === "dependency unavailable")).toHaveLength(1);
    expect(logs.filter((l) => l.msg === "unhandled error")).toHaveLength(0);

    redis.down = false;
    expect((await request(app).get("/api/v1/strict")).status).toBe(200); // recovers by itself
  });
});
