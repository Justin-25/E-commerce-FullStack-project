import type { KeyValueStore } from "../../lib/kv.js";
import { authKeys } from "./keys.js";

/**
 * Brute-force protection for sign-in (design: "5 failed sign-in attempts —
 * sign-in paused 15 min"). Counted per account AND network, so a stranger
 * elsewhere can't lock a real customer out. A higher account-wide limit stops
 * attacks spread over many networks. Locks expire by themselves.
 */
export const LOCKOUT = { perDevice: 5, perAccount: 20, windowSeconds: 15 * 60, lockSeconds: 15 * 60 } as const;

export type FailureResult = { locked: true; retryAfterSeconds: number } | { locked: false; attemptsLeft: number };

export class LoginLockout {
  constructor(private readonly kv: KeyValueStore) {}

  /** Seconds until sign-in unlocks for this account on this network (0 = not locked). */
  async secondsLocked(account: string, ipKey: string): Promise<number> {
    const [device, anywhere] = await Promise.all([this.kv.ttl(authKeys.lock(account, ipKey)), this.kv.ttl(authKeys.lock(account))]);
    return Math.max(device, anywhere);
  }

  async recordFailure(account: string, ipKey: string): Promise<FailureResult> {
    const [device, anywhere] = await Promise.all([
      this.kv.increment(authKeys.failures(account, ipKey), LOCKOUT.windowSeconds),
      this.kv.increment(authKeys.failures(account), LOCKOUT.windowSeconds)
    ]);
    if (device >= LOCKOUT.perDevice) {
      await this.kv.set(authKeys.lock(account, ipKey), "1", LOCKOUT.lockSeconds);
      await this.kv.delete(authKeys.failures(account, ipKey)); // 5 fresh attempts after the pause
    }
    if (anywhere >= LOCKOUT.perAccount) {
      await this.kv.set(authKeys.lock(account), "1", LOCKOUT.lockSeconds);
      await this.kv.delete(authKeys.failures(account));
    }
    if (device >= LOCKOUT.perDevice || anywhere >= LOCKOUT.perAccount) return { locked: true, retryAfterSeconds: LOCKOUT.lockSeconds };
    return { locked: false, attemptsLeft: LOCKOUT.perDevice - device };
  }

  async recordSuccess(account: string, ipKey: string): Promise<void> {
    await this.kv.delete(authKeys.failures(account, ipKey));
  }
}
