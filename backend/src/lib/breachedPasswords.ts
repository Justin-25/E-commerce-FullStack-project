import { createHash } from "node:crypto";
import type { Logger } from "./logger.js";

/** Resolves true if the password appears in a known data breach. */
export type BreachCheck = (password: string) => Promise<boolean>;

/**
 * Checks Have I Been Pwned's list of ~1 billion breached passwords without
 * sending the password: only the first 5 characters of its SHA-1 hash leave
 * the server ("k-anonymity"), and HIBP returns every hash with that prefix
 * (plus padding, so even the response size reveals nothing).
 * If the service is slow or down, sign-up still works (fail open) and a warning is logged.
 */
export function createHibpCheck({ logger, timeoutMs = 2000, fetchImpl = fetch }: { logger: Logger; timeoutMs?: number; fetchImpl?: typeof fetch }): BreachCheck {
  return async (password) => {
    const sha1 = createHash("sha1").update(password.normalize("NFKC")).digest("hex").toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);
    try {
      const res = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, {
        headers: { "Add-Padding": "true", "User-Agent": "vendora-api" },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) throw new Error(`HIBP answered ${res.status}`);
      for (const line of (await res.text()).split("\n")) {
        const [hashSuffix, count] = line.trim().split(":");
        if (hashSuffix === suffix && Number(count) > 0) return true; // padding lines have count 0
      }
      return false;
    } catch (err) {
      logger.warn({ err: { message: (err as Error).message } }, "breached-password check unavailable; password allowed");
      return false;
    }
  };
}
