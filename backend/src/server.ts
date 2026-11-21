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
import { GoogleService } from "./modules/auth/google.service.js";
import { SecurityService } from "./modules/auth/security.service.js";
import { catalogRouter } from "./modules/catalog/catalog.routes.js";
import { CatalogService } from "./modules/catalog/catalog.service.js";
import { addressesRouter } from "./modules/addresses/addresses.routes.js";
import { AddressService } from "./modules/addresses/addresses.service.js";
import { cartRouter } from "./modules/cart/cart.routes.js";
import { CartService } from "./modules/cart/cart.service.js";
import { homeRouter } from "./modules/home/home.routes.js";
import { HomeService } from "./modules/home/home.service.js";
import { reviewsRouter } from "./modules/reviews/reviews.routes.js";
import { ReviewService } from "./modules/reviews/reviews.service.js";
import { storesRouter } from "./modules/stores/stores.routes.js";
import { StoreService } from "./modules/stores/stores.service.js";
import { wishlistRouter } from "./modules/wishlist/wishlist.routes.js";
import { WishlistService } from "./modules/wishlist/wishlist.service.js";
import { createGoogleIdentity } from "./lib/google.js";
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
const guards = createAuthGuards({ tokens, kv, logger });

const routers: Router[] = [];
const services: { drain(): Promise<void> }[] = [];
if (prisma) {
  const email = new DevOutbox(logger); // config refuses this in production; a real provider comes in milestone 9
  const authService = new AuthService({ prisma, kv, email, tokens, config, isBreached: createHibpCheck({ logger }), logger });
  const security = new SecurityService({ prisma, kv, email, config, logger });
  const identity = config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET ? createGoogleIdentity(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET) : null;
  if (!identity) logger.info("GOOGLE_CLIENT_ID is not set — 'Continue with Google' is off");
  const google = new GoogleService({ prisma, kv, auth: authService, identity, email, config, logger });
  services.push(authService, security, google);
  const catalog = new CatalogService({ prisma, kv, logger });
  routers.push(catalogRouter({ catalog }));
  routers.push(homeRouter({ home: new HomeService({ prisma, kv, catalog, logger }) }));
  routers.push(wishlistRouter({ wishlist: new WishlistService({ prisma, catalog }), guards }));
  routers.push(cartRouter({ cart: new CartService({ prisma }), guards }));
  routers.push(addressesRouter({ addresses: new AddressService({ prisma }), guards }));
  routers.push(reviewsRouter({ reviews: new ReviewService({ prisma }) }));
  routers.push(storesRouter({ stores: new StoreService({ prisma }), guards }));
  routers.push(
    authRouter({
      service: authService,
      security,
      google,
      tokens,
      csrf,
      guards,
      config,
      logger,
      ...(redis ? { rateLimitStore: redisRateLimitStore(redis, "rl:auth:") } : {})
    })
  );
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
    void Promise.allSettled(services.map((s) => s.drain()))
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
