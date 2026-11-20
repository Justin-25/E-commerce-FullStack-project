import { DependencyUnavailableError } from "./errors.js";
import type { KeyValueStore } from "./kv.js";
import type { Logger } from "./logger.js";

/**
 * Read-through cache in Redis for data many visitors ask for (categories, Home
 * sections). A cache must never break the shop: if Redis is down, the data is
 * simply loaded from the database (logged), and the request still succeeds.
 * Values go through JSON, so keep them plain (no Date objects).
 */
export async function cached<T>(kv: KeyValueStore, key: string, ttlSeconds: number, load: () => Promise<T>, logger?: Logger): Promise<T> {
  try {
    const hit = await kv.get(key);
    if (hit !== null) return JSON.parse(hit) as T;
  } catch (err) {
    if (!(err instanceof DependencyUnavailableError)) throw err;
    logger?.warn({ key }, "cache unavailable (redis down): loading from the database");
    return load();
  }
  const value = await load();
  try {
    await kv.set(key, JSON.stringify(value), ttlSeconds);
  } catch (err) {
    if (!(err instanceof DependencyUnavailableError)) throw err;
  }
  return value;
}
