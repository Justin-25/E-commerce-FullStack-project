import { randomBytes } from "node:crypto";
import { calculatePKCECodeChallenge } from "openid-client";
import type { GoogleIdentity, GoogleProfile } from "../../src/lib/google.js";

interface Authorization {
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}

/**
 * A stand-in for Google that checks what the real one checks: the code is
 * single-use, and state, nonce, PKCE verifier and redirect address must all
 * match the sign-in attempt that started it.
 */
export class FakeGoogle implements GoogleIdentity {
  private readonly codes = new Map<string, Authorization & { profile: GoogleProfile }>();
  private readonly started = new Map<string, Authorization>();

  async authorizationUrl(input: Authorization): Promise<URL> {
    this.started.set(input.state, input);
    const url = new URL("https://accounts.google.test/o/oauth2/v2/auth");
    for (const [k, v] of Object.entries({ state: input.state, nonce: input.nonce, redirect_uri: input.redirectUri, code_challenge: input.codeChallenge })) {
      url.searchParams.set(k, v);
    }
    return url;
  }

  /** The person picks this Google account for the attempt with this state; returns the code Google would send back. */
  choose(state: string, profile: GoogleProfile): string {
    const attempt = this.started.get(state);
    if (!attempt) throw new Error("no sign-in attempt with that state");
    const code = `fake-code-${randomBytes(8).toString("hex")}`;
    this.codes.set(code, { ...attempt, profile });
    return code;
  }

  async exchangeCode({ callbackUrl, state, nonce, codeVerifier }: { callbackUrl: URL; state: string; nonce: string; codeVerifier: string }): Promise<GoogleProfile> {
    const code = callbackUrl.searchParams.get("code") ?? "";
    const grant = this.codes.get(code);
    this.codes.delete(code); // single use
    if (!grant) throw new Error("invalid_grant");
    if (callbackUrl.searchParams.get("state") !== state || grant.state !== state) throw new Error("state mismatch");
    if (grant.nonce !== nonce) throw new Error("nonce mismatch");
    if ((await calculatePKCECodeChallenge(codeVerifier)) !== grant.codeChallenge) throw new Error("PKCE verifier mismatch");
    if (`${callbackUrl.origin}${callbackUrl.pathname}` !== grant.redirectUri) throw new Error("redirect_uri mismatch");
    return grant.profile;
  }
}

/** A typical Google account for tests. */
export const googleProfile = (email: string, overrides: Partial<GoogleProfile> = {}): GoogleProfile => ({
  sub: `google-${email}`,
  email,
  emailVerified: true,
  name: "Maria Santos",
  ...overrides
});
