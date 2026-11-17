import { pino, type Logger } from "pino";
import type { Config } from "../config/env.js";

/**
 * Structured JSON logs (pretty-printed on your PC). Secrets are redacted so
 * cookies, auth headers, passwords and tokens never end up in log files.
 */
export function createLogger(config: Pick<Config, "LOG_LEVEL" | "NODE_ENV">): Logger {
  return pino({
    level: config.NODE_ENV === "test" ? "silent" : config.LOG_LEVEL,
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]', "*.password", "*.token", "*.refreshToken"],
      censor: "[redacted]"
    },
    ...(config.NODE_ENV === "development"
      ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" } } }
      : {})
  });
}

export type { Logger };
