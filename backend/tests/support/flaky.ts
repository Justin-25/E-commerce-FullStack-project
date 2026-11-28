/** Test doubles for "Redis is down": they work normally until the switch is flipped. */
import { MemoryStore, type ClientRateLimitInfo, type Options, type Store } from "express-rate-limit";
import { DependencyUnavailableError } from "../../src/lib/errors.js";
import type { KeyValueStore } from "../../src/lib/kv.js";

export interface RedisSwitch {
  down: boolean;
}

const fail = () => Promise.reject(new DependencyUnavailableError("redis", new Error("Command timed out")));

/** A KeyValueStore that fails like RedisKv does while `redis.down` is true. */
export class FlakyKv implements KeyValueStore {
  constructor(
    private readonly inner: KeyValueStore,
    private readonly redis: RedisSwitch
  ) {}
  get(key: string) {
    return this.redis.down ? fail() : this.inner.get(key);
  }
  getMany(keys: string[]) {
    return this.redis.down ? fail() : this.inner.getMany(keys);
  }
  set(key: string, value: string, ttl: number) {
    return this.redis.down ? fail() : this.inner.set(key, value, ttl);
  }
  setIfAbsent(key: string, value: string, ttl: number) {
    return this.redis.down ? fail() : this.inner.setIfAbsent(key, value, ttl);
  }
  increment(key: string, ttl: number) {
    return this.redis.down ? fail() : this.inner.increment(key, ttl);
  }
  incrementBy(key: string, amount: number, ttl: number) {
    return this.redis.down ? fail() : this.inner.incrementBy(key, amount, ttl);
  }
  ttl(key: string) {
    return this.redis.down ? fail() : this.inner.ttl(key);
  }
  delete(...keys: string[]) {
    return this.redis.down ? fail() : this.inner.delete(...keys);
  }
  countUnique(key: string, member: string, ttl: number) {
    return this.redis.down ? fail() : this.inner.countUnique(key, member, ttl);
  }
  uniqueCount(key: string) {
    return this.redis.down ? fail() : this.inner.uniqueCount(key);
  }
}

/** A rate-limit store that fails (like rate-limit-redis would) while `redis.down` is true. */
export class FlakyStore implements Store {
  private readonly inner = new MemoryStore();
  constructor(private readonly redis: RedisSwitch) {}
  init(options: Options) {
    this.inner.init(options);
  }
  async increment(key: string): Promise<ClientRateLimitInfo> {
    if (this.redis.down) throw new Error("Command timed out");
    return this.inner.increment(key);
  }
  async decrement(key: string) {
    if (!this.redis.down) await this.inner.decrement(key);
  }
  async resetKey(key: string) {
    if (!this.redis.down) await this.inner.resetKey(key);
  }
}
