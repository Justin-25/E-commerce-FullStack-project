import { sha256Hex } from "../../lib/crypto.js";

/** Emails are hashed before use in Redis keys, so Redis never holds them in plain text. */
export const emailKey = (email: string): string => sha256Hex(email).slice(0, 32);

/** Every Redis key the sign-in code uses, in one place. All of them expire on their own. */
export const authKeys = {
  /** An access pass that was signed out (until it would have expired anyway). */
  deniedAccess: (jti: string) => `auth:denied-jti:${jti}`,
  /** A sign-in chain that was revoked: its access passes stop working at once. */
  revokedFamily: (familyId: string) => `auth:revoked-family:${familyId}`,
  /** Access passes for this user issued before this time (Unix seconds) are refused, e.g. after a password change. */
  invalidBefore: (userId: string) => `auth:invalid-before:${userId}`,
  /** Failed sign-ins for an account, from one network (ipKey) or from anywhere. */
  failures: (account: string, ipKey?: string) => (ipKey ? `auth:fail:${account}:${ipKey}` : `auth:fail:${account}`),
  lock: (account: string, ipKey?: string) => (ipKey ? `auth:lock:${account}:${ipKey}` : `auth:lock:${account}`),
  verifyCooldown: (account: string) => `auth:cooldown:verify:${account}`,
  codesToday: (account: string) => `auth:codes-today:${account}`,
  resetCooldown: (account: string) => `auth:cooldown:reset:${account}`,
  resetsToday: (account: string) => `auth:resets-today:${account}`,
  accountExistsNotice: (account: string) => `auth:cooldown:exists:${account}`
};
