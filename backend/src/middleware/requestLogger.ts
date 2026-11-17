import { randomUUID } from "node:crypto";
import { pinoHttp } from "pino-http";
import type { Logger } from "../lib/logger.js";

// Simple, linear pattern (no nested quantifiers) — safe from "evil regex" slowdowns.
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Gives every request an ID (reusing a safe X-Request-Id from the client),
 * returns it in the X-Request-Id header and logs one line per request.
 */
export function requestLogger(logger: Logger) {
  return pinoHttp({
    logger,
    genReqId: (req, res) => {
      const incoming = req.headers["x-request-id"];
      const id = typeof incoming === "string" && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
      res.setHeader("X-Request-Id", id);
      return id;
    },
    customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, url: req.url }),
      res: (res) => ({ statusCode: res.statusCode })
    }
  });
}
