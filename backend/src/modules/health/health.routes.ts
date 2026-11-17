import { Router } from "express";

/** A readiness check resolves when the dependency answers; `null` = not configured. */
export type ReadinessCheck = () => Promise<unknown>;
export type ReadinessChecks = Record<string, ReadinessCheck | null>;
type CheckResult = "ok" | "error" | "not_configured";

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

export function healthRouter(checks: ReadinessChecks, timeoutMs = 2000): Router {
  const router = Router();

  // Liveness: the process is up. No dependencies → always fast.
  router.get("/health", (_req, res) => {
    res.json({ status: "ok", uptimeSeconds: Math.round(process.uptime() * 10) / 10 });
  });

  // Readiness: every configured dependency answers within the timeout.
  router.get("/ready", async (req, res) => {
    const results: Record<string, CheckResult> = {};
    for (const name of Object.keys(checks)) results[name] = "not_configured";
    await Promise.all(
      Object.entries(checks).map(async ([name, check]) => {
        if (!check) return;
        try {
          await withTimeout(check(), timeoutMs);
          results[name] = "ok";
        } catch (err) {
          results[name] = "error";
          req.log.error({ err, check: name }, "readiness check failed"); // details stay in the log
        }
      })
    );
    const ready = !Object.values(results).includes("error");
    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", checks: results });
  });

  return router;
}
