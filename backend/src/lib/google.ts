import * as oidc from "openid-client";

/** What we use from a Google account. `sub` is Google's permanent account id. */
export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

/**
 * The two server-side steps of "Continue with Google" (OAuth 2.0 authorization
 * code flow with PKCE, OpenID Connect). Behind an interface so tests can use a
 * fake Google instead of the real one.
 */
export interface GoogleIdentity {
  /** Where to send the browser: Google's account chooser. */
  authorizationUrl(input: { redirectUri: string; state: string; nonce: string; codeChallenge: string }): Promise<URL>;
  /**
   * Exchanges the one-time code (server to server, with the client secret and
   * the PKCE verifier) and returns the checked ID token's profile. Throws if
   * the state, nonce or signature don't match.
   */
  exchangeCode(input: { callbackUrl: URL; state: string; nonce: string; codeVerifier: string }): Promise<GoogleProfile>;
}

/** Random values for one sign-in attempt: state (against forged callbacks), nonce (against replayed ID tokens), PKCE. */
export async function newGoogleFlow() {
  const codeVerifier = oidc.randomPKCECodeVerifier();
  return { state: oidc.randomState(), nonce: oidc.randomNonce(), codeVerifier, codeChallenge: await oidc.calculatePKCECodeChallenge(codeVerifier) };
}

/**
 * The real Google, via openid-client (certified OpenID Connect library). Google's
 * settings and signing keys are fetched from its discovery document once and reused.
 */
export function createGoogleIdentity(clientId: string, clientSecret: string): GoogleIdentity {
  let config: Promise<oidc.Configuration> | undefined;
  const getConfig = () => {
    config ??= oidc.discovery(new URL("https://accounts.google.com"), clientId, clientSecret).catch((err: unknown) => {
      config = undefined; // try again next time instead of caching the failure
      throw err;
    });
    return config;
  };

  return {
    async authorizationUrl({ redirectUri, state, nonce, codeChallenge }) {
      return oidc.buildAuthorizationUrl(await getConfig(), {
        redirect_uri: redirectUri,
        scope: "openid email profile",
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        prompt: "select_account"
      });
    },

    async exchangeCode({ callbackUrl, state, nonce, codeVerifier }) {
      const tokens = await oidc.authorizationCodeGrant(await getConfig(), callbackUrl, {
        expectedState: state,
        expectedNonce: nonce,
        pkceCodeVerifier: codeVerifier,
        idTokenExpected: true
      });
      const claims = tokens.claims();
      if (!claims || typeof claims.sub !== "string" || typeof claims.email !== "string") throw new Error("Google did not return an email address");
      const name = typeof claims.name === "string" && claims.name.trim() ? claims.name.trim() : claims.email.split("@")[0];
      return { sub: claims.sub, email: claims.email.toLowerCase(), emailVerified: claims.email_verified === true, name: (name ?? "Vendora shopper").slice(0, 100) };
    }
  };
}
