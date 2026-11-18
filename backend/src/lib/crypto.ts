import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** A random, URL-safe secret (256 bits by default). Used for refresh passes and links. */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

/** SHA-256 as 64 hex characters. Fine for long random tokens: they can't be guessed from the hash. */
export const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * Keyed hash (HMAC-SHA256) as 64 hex characters. Used for short codes: a
 * 6-digit code has only a million options, so a plain hash would be reversed
 * instantly from a stolen database. Without the server key, it can't.
 */
export const hmacHex = (keyBase64Url: string, value: string): string =>
  createHmac("sha256", Buffer.from(keyBase64Url, "base64url")).update(value).digest("hex");

/** A 6-digit code from a cryptographically secure source, e.g. "048213". */
export const sixDigitCode = (): string => randomInt(0, 1_000_000).toString().padStart(6, "0");

/** Compares two hex strings in constant time, so response timing can't leak how much matched. */
export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
