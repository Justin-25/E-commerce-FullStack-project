import { randomUUID } from "node:crypto";
import { pinoHttp } from "pino-http";
import type { Logger } from "../lib/logger.js";

// Simple, linear pattern (no nested quantifiers) — safe from "evil regex" slowdowns.
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Query parameters that can carry one-time credentials (e.g. Google's sign-in
 * `code` and `state` on /auth/google/callback). Their values never go into logs.
 */
const SECRET_QUERY_KEYS = new Set(["code", "state", "token", "id_token", "access_token", "refresh_token", "nonce"]);

/** The URL with secret query values replaced by "[redacted]" (the path and other parameters stay readable). */
export function redactUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const q = url.indexOf("?");
  if (q === -1) return url;
  const params = new URLSearchParams(url.slice(q + 1));
  let changed = false;
  for (const key of [...params.keys()]) {
    if (SECRET_QUERY_KEYS.has(key.toLowerCase())) {
      params.set(key, "[redacted]");
      changed = true;
    }
  }
  return changed ? `${url.slice(0, q)}?${params.toString()}` : url;
}

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
      req: (req) => ({ id: req.id, method: req.method, url: redactUrl(req.url) }),
      res: (res) => ({ statusCode: res.statusCode })
    }
  });
}
