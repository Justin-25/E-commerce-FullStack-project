import { randomToken, sha256Hex } from "../../lib/crypto.js";
import type { KeyValueStore } from "../../lib/kv.js";
import { authKeys } from "./keys.js";

/**
 * What still has to happen after a correct password:
 * - "two_factor": enter the authenticator (or backup) code
 * - "two_factor_setup": sellers and admins without 2FA must set it up first
 */
export type ChallengeType = "two_factor" | "two_factor_setup" | "google_link";

export interface Challenge {
  userId: string;
  type: ChallengeType;
  keepSignedIn: boolean;
  /**
   * A Google account waiting to be connected once this person proves they own
   * the Vendora account (password, then 2FA if on). "google_link" step: design
   * "Sign in with your password to connect Google".
   */
  linkGoogle?: { sub: string; email: string };
}

export interface IssuedChallenge {
  /** Goes into an httpOnly cookie; only its hash is used as the Redis key. */
  token: string;
  type: ChallengeType;
  expiresInSeconds: number;
}

/** Design: "Enter the 6-digit code" has 5 minutes; setting up an app (scan, type the code) gets 15. */
export const CHALLENGE_TTL_SECONDS: Record<ChallengeType, number> = { two_factor: 5 * 60, two_factor_setup: 15 * 60, google_link: 10 * 60 };
export const CHALLENGE_MAX_ATTEMPTS = 5;

/**
 * The half-finished sign-in between "password OK" and "code OK". It lives in
 * Redis for a few minutes and is used once. No session exists until the code
 * is right, so a stolen password alone gets nothing.
 */
export class SignInChallenges {
  constructor(private readonly kv: KeyValueStore) {}

  async create(challenge: Challenge): Promise<IssuedChallenge> {
    const token = randomToken(32);
    const ttl = CHALLENGE_TTL_SECONDS[challenge.type];
    await this.kv.set(authKeys.challenge(sha256Hex(token)), JSON.stringify(challenge), ttl);
    return { token, type: challenge.type, expiresInSeconds: ttl };
  }

  async find(token: string | undefined): Promise<Challenge | null> {
    if (!token) return null;
    const raw = await this.kv.get(authKeys.challenge(sha256Hex(token)));
    return raw ? (JSON.parse(raw) as Challenge) : null;
  }

  /** Counts one code attempt. Returns how many are left (0 = the challenge is used up). */
  async countAttempt(token: string): Promise<number> {
    const hash = sha256Hex(token);
    const used = await this.kv.increment(authKeys.challengeAttempts(hash), CHALLENGE_TTL_SECONDS.two_factor_setup);
    const left = CHALLENGE_MAX_ATTEMPTS - used;
    if (left <= 0) await this.remove(token);
    return Math.max(0, left);
  }

  async remove(token: string): Promise<void> {
    const hash = sha256Hex(token);
    await this.kv.delete(authKeys.challenge(hash), authKeys.challengeAttempts(hash));
  }
}
