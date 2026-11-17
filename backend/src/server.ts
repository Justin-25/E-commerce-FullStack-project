import { createApp } from "./app.js";
import { loadConfig, loadEnvFile } from "./config/env.js";
import { createLogger } from "./lib/logger.js";
import { createRedis } from "./lib/redis.js";
import { redisRateLimitStore } from "./middleware/rateLimit.js";

loadEnvFile();
const config = loadConfig();
const logger = createLogger(config);

const redis = config.REDIS_URL ? createRedis(config.REDIS_URL, logger) : null;
if (!redis) logger.warn("REDIS_URL is not set — rate limits use in-memory counters (fine for local development only)");

const app = createApp({
  config,
  logger,
  checks: {
    redis: redis ? () => redis.ping() : null,
    database: null // PostgreSQL + Prisma arrive in milestone 2
  },
  ...(redis ? { rateLimitStore: redisRateLimitStore(redis) } : {})
});

const server = app.listen(config.PORT, () => {
  logger.info(`Vendora API listening on http://localhost:${config.PORT} (${config.NODE_ENV})`);
});

// Graceful shutdown: stop accepting requests, finish in-flight ones, close Redis.
let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "shutting down");
  server.close(() => {
    void (redis ? redis.quit().catch(() => undefined) : Promise.resolve()).then(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (err) => {
  logger.fatal({ err }, "unhandled promise rejection");
  shutdown("unhandledRejection");
});
