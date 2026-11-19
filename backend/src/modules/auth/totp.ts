import { Secret, TOTP } from "otpauth";
import type { KeyValueStore } from "../../lib/kv.js";
import { authKeys } from "./keys.js";

const ISSUER = "Vendora";
const PERIOD_SECONDS = 30;

/**
 * Authenticator-app codes (TOTP, RFC 6238), the standard used by Google
 * Authenticator, Microsoft Authenticator and others: the app and the server
 * share a secret and both turn the current 30-second window into a 6-digit code.
 */
export class TotpCodes {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** A new random 160-bit secret, plus the link an app reads from the QR code. */
  newSecret(email: string): { secret: string; otpauthUri: string } {
    const totp = new TOTP({ issuer: ISSUER, label: email, secret: new Secret({ size: 20 }), algorithm: "SHA1", digits: 6, period: PERIOD_SECONDS });
    return { secret: totp.secret.base32, otpauthUri: totp.toString() };
  }

  /**
   * True if the code is right for now (or the window just before/after, for
   * clock drift) AND hasn't been used yet. Marking it used is atomic, so the
   * same code sent twice at once only works once.
   */
  async verify(userId: string, secret: string, code: string): Promise<boolean> {
    if (!/^\d{6}$/.test(code)) return false;
    const timestamp = this.now().getTime();
    const delta = TOTP.validate({ token: code, secret: Secret.fromBase32(secret), period: PERIOD_SECONDS, timestamp, window: 1 });
    if (delta === null) return false;
    const counter = TOTP.counter({ period: PERIOD_SECONDS, timestamp }) + delta;
    return this.kv.setIfAbsent(authKeys.totpUsed(userId, counter), "1", PERIOD_SECONDS * 4);
  }
}
