import { Router } from "express";
import { pino } from "pino";
import { createApp, type AppOptions } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { AppError } from "../src/lib/errors.js";

export const silentLogger = pino({ level: "silent" });

export function testConfig(env: Record<string, string> = {}) {
  return loadConfig({ NODE_ENV: "test", CORS_ORIGINS: "http://localhost:5173", ...env });
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

export function buildApp(opts: Partial<Omit<AppOptions, "config">> & { env?: Record<string, string> } = {}) {
  const { env, ...rest } = opts;
  return createApp({ config: testConfig(env), logger: silentLogger, routers: [testRouter()], ...rest });
}
