import type { Redis } from "ioredis";
import { DependencyUnavailableError } from "./errors.js";

/**
 * Short-lived security data with automatic expiry: lockout counters, cooldowns,
 * the access-pass deny list. Redis in real runs; in memory for tests and for a
 * dev server without Redis (single process only).
 */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  getMany(keys: string[]): Promise<(string | null)[]>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Sets the key only if it doesn't exist yet. Returns true if it was set. */
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  /** Adds 1 and returns the new count. The expiry starts at the first increment (fixed window). */
  increment(key: string, ttlSeconds: number): Promise<number>;
  /** Seconds until the key expires, or 0 if it doesn't exist. */
  ttl(key: string): Promise<number>;
  delete(...keys: string[]): Promise<void>;
}

// INCR + EXPIRE in one atomic step, so a crash between them can't leave a counter that never expires.
const INCREMENT_SCRIPT = `local n = redis.call('INCR', KEYS[1]) if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return n`;

/** Every failure (timeout, connection down) comes out as DependencyUnavailableError, so callers can tell it apart from bugs. */
export class RedisKv implements KeyValueStore {
  constructor(private readonly redis: Redis) {}

  private async run<T>(command: () => Promise<T>): Promise<T> {
    try {
      return await command();
    } catch (err) {
      throw new DependencyUnavailableError("redis", err);
    }
  }

  get(key: string) {
    return this.run(() => this.redis.get(key));
  }
  getMany(keys: string[]) {
    return this.run(async () => (keys.length ? this.redis.mget(...keys) : []));
  }
  set(key: string, value: string, ttlSeconds: number) {
    return this.run(async () => {
      await this.redis.set(key, value, "EX", ttlSeconds);
    });
  }
  setIfAbsent(key: string, value: string, ttlSeconds: number) {
    return this.run(async () => (await this.redis.set(key, value, "EX", ttlSeconds, "NX")) === "OK");
  }
  increment(key: string, ttlSeconds: number) {
    return this.run(async () => Number(await this.redis.eval(INCREMENT_SCRIPT, 1, key, ttlSeconds)));
  }
  ttl(key: string) {
    return this.run(async () => Math.max(0, await this.redis.ttl(key)));
  }
  delete(...keys: string[]) {
    return this.run(async () => {
      if (keys.length) await this.redis.del(...keys);
    });
  }
}

export class MemoryKv implements KeyValueStore {
  private readonly data = new Map<string, { value: string; expiresAt: number }>();

  /** `now` can be replaced in tests to move time forward. */
  constructor(private readonly now: () => number = Date.now) {}

  private live(key: string) {
    const entry = this.data.get(key);
    if (entry && entry.expiresAt <= this.now()) this.data.delete(key);
    return this.data.get(key);
  }
  async get(key: string) {
    return this.live(key)?.value ?? null;
  }
  async getMany(keys: string[]) {
    return keys.map((k) => this.live(k)?.value ?? null);
  }
  async set(key: string, value: string, ttlSeconds: number) {
    this.data.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }
  async setIfAbsent(key: string, value: string, ttlSeconds: number) {
    if (this.live(key)) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }
  async increment(key: string, ttlSeconds: number) {
    const entry = this.live(key);
    const next = Number(entry?.value ?? 0) + 1;
    this.data.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? this.now() + ttlSeconds * 1000 });
    return next;
  }
  async ttl(key: string) {
    const entry = this.live(key);
    return entry ? Math.ceil((entry.expiresAt - this.now()) / 1000) : 0;
  }
  async delete(...keys: string[]) {
    for (const k of keys) this.data.delete(k);
  }
}
