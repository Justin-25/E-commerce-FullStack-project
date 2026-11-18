import type { Router } from "express";
import { createApp } from "./app.js";
import { loadConfig, loadEnvFile } from "./config/env.js";
import { createHibpCheck } from "./lib/breachedPasswords.js";
import { DevOutbox } from "./lib/email.js";
import { MemoryKv, RedisKv } from "./lib/kv.js";
import { createLogger } from "./lib/logger.js";
import { createPrisma } from "./lib/prisma.js";
import { createRedis } from "./lib/redis.js";
import { createAuthGuards } from "./middleware/auth.js";
import { createCsrf } from "./middleware/csrf.js";
import { redisRateLimitStore } from "./middleware/rateLimit.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { AuthService } from "./modules/auth/auth.service.js";
import { TokenService } from "./modules/auth/tokens.js";

loadEnvFile();
const config = loadConfig();
const logger = createLogger(config);

const redis = config.REDIS_URL ? createRedis(config.REDIS_URL, logger) : null;
if (!redis) logger.warn("REDIS_URL is not set — rate limits and sign-in lockouts use in-memory counters (fine for local development only)");
const prisma = config.DATABASE_URL ? createPrisma(config.DATABASE_URL) : null;
if (!prisma) logger.warn("DATABASE_URL is not set — sign-in and other database features are off");

const kv = redis ? new RedisKv(redis) : new MemoryKv();
const csrf = createCsrf(config);
const tokens = new TokenService(config);
const guards = createAuthGuards({ tokens, kv });

const routers: Router[] = [];
let authService: AuthService | null = null;
if (prisma) {
  authService = new AuthService({
    prisma,
    kv,
    email: new DevOutbox(logger), // config refuses this in production; a real provider comes in milestone 9
    tokens,
    config,
    isBreached: createHibpCheck({ logger }),
    logger
  });
  routers.push(authRouter({ service: authService, tokens, csrf, guards, config, ...(redis ? { rateLimitStore: redisRateLimitStore(redis, "rl:auth:") } : {}) }));
}

const app = createApp({
  config,
  logger,
  csrf,
  routers,
  checks: {
    redis: redis ? () => redis.ping() : null,
    database: prisma ? () => prisma.$queryRaw`SELECT 1` : null
  },
  ...(redis ? { rateLimitStore: redisRateLimitStore(redis) } : {})
});

const server = app.listen(config.PORT, () => {
  logger.info(`Vendora API listening on http://localhost:${config.PORT} (${config.NODE_ENV})`);
});

// Graceful shutdown: stop accepting requests, finish in-flight ones and emails being sent,
// then close Redis and the database pool.
let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "shutting down");
  server.close(() => {
    void (authService?.drain() ?? Promise.resolve())
      .then(() => Promise.allSettled([redis?.quit(), prisma?.$disconnect()]))
      .then(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (err) => {
  logger.fatal({ err }, "unhandled promise rejection");
  shutdown("unhandledRejection");
});
