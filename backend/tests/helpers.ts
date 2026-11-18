import { Router } from "express";
import { pino } from "pino";
import { createApp, type AppOptions } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { AppError } from "../src/lib/errors.js";
import { createCsrf } from "../src/middleware/csrf.js";

export const silentLogger = pino({ level: "silent" });

/** Fixed, test-only keys (real ones come from `npm run secrets`). */
export const TEST_SECRETS = {
  ACCESS_TOKEN_SECRET: "test_access_token_secret_0123456789_abcdefghijklmn",
  CSRF_SECRET: "test_csrf_secret_0123456789_abcdefghijklmnopqrstuvwxyz",
  CODE_HASH_SECRET: "test_code_hash_secret_0123456789_abcdefghijklmnopqrst"
};

export function testConfig(env: Record<string, string> = {}) {
  return loadConfig({ NODE_ENV: "test", CORS_ORIGINS: "http://localhost:5173", ...TEST_SECRETS, ...env });
}

/** Routes that exist only in tests, to exercise the error handler and parsers. */
function testRouter(): Router {
  const r = Router();
  r.get("/boom", () => {
    throw new Error("database password is hunter2");
  });
  r.get("/forbidden", () => {
    throw new AppError(403, "FORBIDDEN", "You can't do that");
  });
  r.post("/echo", (req, res) => {
    res.json({ body: req.body });
  });
  r.get("/query", (req, res) => {
    res.json({ query: req.query });
  });
  return r;
}

/** The platform app with test routes (no database). GET /api/v1/auth/csrf hands out real CSRF tokens. */
export function buildApp(opts: Partial<Omit<AppOptions, "config">> & { env?: Record<string, string> } = {}) {
  const { env, ...rest } = opts;
  const config = testConfig(env);
  const csrf = createCsrf(config);
  const csrfRouter = Router().get("/auth/csrf", (req, res) => {
    res.json({ csrfToken: csrf.issue(req, res) });
  });
  return createApp({ config, logger: silentLogger, csrf, routers: [testRouter(), csrfRouter], ...rest });
}
