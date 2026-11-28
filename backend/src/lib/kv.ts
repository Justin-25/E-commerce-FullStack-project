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
  /** Adds a whole number (e.g. micro-dollars spent) and returns the new total. Same fixed-window expiry as `increment`. */
  incrementBy(key: string, amount: number, ttlSeconds: number): Promise<number>;
  /** Seconds until the key expires, or 0 if it doesn't exist. */
  ttl(key: string): Promise<number>;
  delete(...keys: string[]): Promise<void>;
  /**
   * Adds a member to a count of unique members (Redis HyperLogLog: about 12 KB at most, whatever
   * the count, about 1% error). The expiry is set when the count is created.
   */
  countUnique(key: string, member: string, ttlSeconds: number): Promise<void>;
  /** How many unique members a count has (0 if it doesn't exist). */
  uniqueCount(key: string): Promise<number>;
}

// INCR + EXPIRE in one atomic step, so a crash between them can't leave a counter that never expires.
const INCREMENT_SCRIPT = `local n = redis.call('INCR', KEYS[1]) if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return n`;
// INCRBY + EXPIRE (only if it has none yet) in one atomic step, for the same reason.
const INCREMENT_BY_SCRIPT = `local n = redis.call('INCRBY', KEYS[1], ARGV[1]) if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end return n`;
// PFADD + EXPIRE (only if it has none yet) in one atomic step, for the same reason.
const COUNT_UNIQUE_SCRIPT = `redis.call('PFADD', KEYS[1], ARGV[1]) if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end return 1`;

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
  incrementBy(key: string, amount: number, ttlSeconds: number) {
    return this.run(async () => Number(await this.redis.eval(INCREMENT_BY_SCRIPT, 1, key, Math.round(amount), ttlSeconds)));
  }
  ttl(key: string) {
    return this.run(async () => Math.max(0, await this.redis.ttl(key)));
  }
  delete(...keys: string[]) {
    return this.run(async () => {
      if (keys.length) await this.redis.del(...keys);
    });
  }
  countUnique(key: string, member: string, ttlSeconds: number) {
    return this.run(async () => {
      await this.redis.eval(COUNT_UNIQUE_SCRIPT, 1, key, member, ttlSeconds);
    });
  }
  uniqueCount(key: string) {
    return this.run(() => this.redis.pfcount(key));
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
    return this.incrementBy(key, 1, ttlSeconds);
  }
  async incrementBy(key: string, amount: number, ttlSeconds: number) {
    const entry = this.live(key);
    const next = Number(entry?.value ?? 0) + Math.round(amount);
    this.data.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? this.now() + ttlSeconds * 1000 });
    return next;
  }
  async ttl(key: string) {
    const entry = this.live(key);
    return entry ? Math.ceil((entry.expiresAt - this.now()) / 1000) : 0;
  }
  async delete(...keys: string[]) {
    for (const k of keys) {
      this.data.delete(k);
      this.sets.delete(k);
    }
  }
  /** Exact here (a Set), so tests can count precisely; Redis counts approximately. */
  private readonly sets = new Map<string, { members: Set<string>; expiresAt: number }>();
  async countUnique(key: string, member: string, ttlSeconds: number) {
    const entry = this.liveSet(key) ?? { members: new Set<string>(), expiresAt: this.now() + ttlSeconds * 1000 };
    entry.members.add(member);
    this.sets.set(key, entry);
  }
  async uniqueCount(key: string) {
    return this.liveSet(key)?.members.size ?? 0;
  }
  private liveSet(key: string) {
    const entry = this.sets.get(key);
    if (entry && entry.expiresAt <= this.now()) this.sets.delete(key);
    return this.sets.get(key);
  }
}
