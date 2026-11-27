import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GoogleFlowError, GoogleService } from "../../src/modules/auth/google.service.js";
import { DevOutbox } from "../../src/lib/email.js";
import { MemoryKv } from "../../src/lib/kv.js";
import { testConfig } from "../helpers.js";
import { AUTH, createAuthHarness, GOOD_PASSWORD, totpCode, type AuthHarness } from "../support/authHarness.js";
import { setCookie } from "../support/browser.js";
import { googleProfile } from "../support/fakeGoogle.js";

let h: AuthHarness;
beforeAll(async () => {
  h = await createAuthHarness();
}, 60_000);
afterAll(() => h?.close());

const APP = "http://localhost:5173";
const location = (res: { headers: Record<string, unknown> }) => String(res.headers.location);
const userBy = (email: string) => h.db.prisma.user.findUniqueOrThrow({ where: { email }, include: { oauthAccounts: true } });
const typesOf = async (userId: string) => (await h.db.prisma.securityEvent.findMany({ where: { userId } })).map((e) => e.type);

describe("starting 'Continue with Google'", () => {
  it("is available, and sends the browser to Google with state, nonce and PKCE", async () => {
    const b = await h.browser();
    expect((await b.get("/api/v1/auth/google")).body).toEqual({ enabled: true });
    const start = await b.get("/api/v1/auth/google/start");
    expect(start.status).toBe(302);
    const google = new URL(location(start));
    expect(google.origin).toBe("https://accounts.google.test");
    expect(google.searchParams.get("redirect_uri")).toBe(`${APP}/api/v1/auth/google/callback`);
    for (const param of ["state", "nonce", "code_challenge"]) expect(google.searchParams.get(param)?.length).toBeGreaterThan(20);

    const cookie = setCookie(start, "vd_oauth") ?? "";
    for (const attribute of ["Max-Age=600", "Path=/api/v1/auth/google", "HttpOnly", "SameSite=Lax"]) expect(cookie).toContain(attribute);
    expect(cookie).toMatch(/^vd_oauth=v1\./); // encrypted…
    expect(cookie).not.toContain(google.searchParams.get("state") ?? "?"); // …so the state isn't readable in it
  });
});

describe("signing in with Google", () => {
  it("a new person gets a verified shopper account with no password, and is signed in", async () => {
    const b = await h.browser();
    const res = await h.googleSignIn(b, googleProfile("new-via-google@gmail.com", { name: "Juan Dela Cruz" }));
    expect(res.status).toBe(302);
    expect(location(res)).toBe(`${APP}/`);
    expect(setCookie(res, "vd_at")).toBeDefined();
    expect(setCookie(res, "vd_oauth")).toContain("Expires=Thu, 01 Jan 1970"); // each attempt works once

    const me = await b.get(AUTH.me);
    expect(me.body.user).toMatchObject({ email: "new-via-google@gmail.com", name: "Juan Dela Cruz", role: "CUSTOMER", emailVerified: true });
    const user = await userBy("new-via-google@gmail.com");
    expect(user.passwordHash).toBeNull();
    expect(user.oauthAccounts).toMatchObject([{ provider: "GOOGLE", providerUserId: "google-new-via-google@gmail.com", email: "new-via-google@gmail.com" }]);
    expect(await typesOf(user.id)).toEqual(expect.arrayContaining(["GOOGLE_CONNECTED", "LOGIN_OK"]));
    await b.loadCsrfToken(); // the page gets its CSRF token after the redirect
    expect((await b.get(AUTH.security)).body).toMatchObject({ hasPassword: false, google: { connected: true, email: "new-via-google@gmail.com" }, confirmMethod: "email" });
  });

  it("a returning person signs in to the same account, and 'keep me signed in' lasts 30 days", async () => {
    const profile = googleProfile("returning@gmail.com");
    await h.googleSignIn(await h.browser(), profile);
    const again = await h.googleSignIn(await h.browser(), profile, { keepSignedIn: "true" });
    expect(location(again)).toBe(`${APP}/`);
    expect(setCookie(again, "vd_rt")).toContain("Expires=");
    expect(await h.db.prisma.user.count({ where: { email: "returning@gmail.com" } })).toBe(1);
  });

  it("an existing password account is connected only after its password (the user's choice)", async () => {
    await h.signUp({ email: "has-password@gmail.com" });
    const b = await h.browser();
    const res = await h.googleSignIn(b, googleProfile("has-password@gmail.com"));
    expect(location(res)).toBe(`${APP}/sign-in?step=google-link`);
    expect(setCookie(res, "vd_at")).toBeUndefined(); // not signed in yet
    expect(setCookie(res, "vd_2fa")).toBeDefined();

    const wrong = await b.post("/api/v1/auth/google/link", { password: "not my password" });
    expect(wrong.body.error).toMatchObject({ code: "INVALID_CREDENTIALS", details: { attemptsLeft: 4 } });
    const ok = await b.post("/api/v1/auth/google/link", { password: GOOD_PASSWORD });
    expect(ok.body).toMatchObject({ status: "signed_in", user: { email: "has-password@gmail.com" } });
    expect((await userBy("has-password@gmail.com")).oauthAccounts).toHaveLength(1);

    // From now on Google goes straight in.
    expect(location(await h.googleSignIn(await h.browser(), googleProfile("has-password@gmail.com")))).toBe(`${APP}/`);
  });

  it("with two-step verification on: Google replaces the password, not the code", async () => {
    const { browser: setup, user } = await h.signUp({ email: "google-2fa@gmail.com" });
    const { manualKey } = await h.enableTwoFactor(setup);

    // Connecting: password, then the app code, then connected.
    await h.allowCodeReuse(user.id);
    const b = await h.browser();
    await h.googleSignIn(b, googleProfile("google-2fa@gmail.com"));
    expect((await b.post("/api/v1/auth/google/link", { password: GOOD_PASSWORD })).body.status).toBe("two_factor_required");
    expect((await b.post(AUTH.twoFactorVerify, { code: totpCode(manualKey) })).body.status).toBe("signed_in");
    expect((await userBy("google-2fa@gmail.com")).oauthAccounts).toHaveLength(1);

    // Signing in with Google later still asks for the code.
    await h.allowCodeReuse(user.id);
    const later = await h.browser();
    const res = await h.googleSignIn(later, googleProfile("google-2fa@gmail.com"));
    expect(location(res)).toBe(`${APP}/sign-in?step=two-factor`);
    expect((await later.get(AUTH.me)).status).toBe(401);
    expect((await later.post(AUTH.twoFactorVerify, { code: totpCode(manualKey) })).body.status).toBe("signed_in");
  });

  it("sellers signing in with Google must still set up two-step verification", async () => {
    await h.googleSignIn(await h.browser(), googleProfile("seller-google@gmail.com"));
    await h.db.prisma.user.update({ where: { email: "seller-google@gmail.com" }, data: { role: "SELLER" } });
    expect(location(await h.googleSignIn(await h.browser(), googleProfile("seller-google@gmail.com")))).toBe(`${APP}/sign-in?step=two-factor-setup`);
  });

  it("takes over an account that was never verified: Google proves the inbox, and the unknown password is erased", async () => {
    const squatter = await h.browser();
    await squatter.post(AUTH.register, { name: "Someone", email: "pre-registered@gmail.com", password: "squatter password 1" });
    const res = await h.googleSignIn(await h.browser(), googleProfile("pre-registered@gmail.com"));
    expect(location(res)).toBe(`${APP}/`);
    const user = await userBy("pre-registered@gmail.com");
    expect(user).toMatchObject({ passwordHash: null });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect((await (await h.browser()).post(AUTH.login, { email: "pre-registered@gmail.com", password: "squatter password 1" })).status).toBe(401);
  });

  it("refuses unverified Google emails and suspended accounts, and handles 'Cancel' on Google", async () => {
    const unverified = await h.googleSignIn(await h.browser(), googleProfile("unverified@example.com", { emailVerified: false }));
    expect(location(unverified)).toBe(`${APP}/sign-in?error=google_email_unverified`);
    expect(await h.db.prisma.user.count({ where: { email: "unverified@example.com" } })).toBe(0);

    await h.googleSignIn(await h.browser(), googleProfile("banned@gmail.com"));
    await h.db.prisma.user.update({ where: { email: "banned@gmail.com" }, data: { status: "SUSPENDED", suspendedAt: new Date(), suspendedReason: "Test: suspended" } });
    expect(location(await h.googleSignIn(await h.browser(), googleProfile("banned@gmail.com")))).toBe(`${APP}/sign-in?error=account_suspended`);

    const b = await h.browser();
    const start = await b.get("/api/v1/auth/google/start");
    const state = new URL(location(start)).searchParams.get("state") ?? "";
    const cancelled = await b.get(`/api/v1/auth/google/callback?error=access_denied&state=${state}`);
    expect(location(cancelled)).toBe(`${APP}/sign-in?error=google_cancelled`);
  });

  it("refuses forged, mismatched and replayed callbacks", async () => {
    const profile = googleProfile("attacked@gmail.com");
    const b = await h.browser();
    const start = await b.get("/api/v1/auth/google/start");
    const state = new URL(location(start)).searchParams.get("state") ?? "";
    const code = h.fakeGoogle.choose(state, profile);

    // Someone else's browser (no state cookie) can't use the code: login CSRF blocked.
    const otherBrowser = await (await h.browser()).get(`/api/v1/auth/google/callback?code=${code}&state=${state}`);
    expect(location(otherBrowser)).toBe(`${APP}/sign-in?error=google_failed`);

    // A different state than the one this browser started with.
    const b2 = await h.browser();
    const start2 = await b2.get("/api/v1/auth/google/start");
    const state2 = new URL(location(start2)).searchParams.get("state") ?? "";
    const code2 = h.fakeGoogle.choose(state2, profile);
    expect(location(await b2.get(`/api/v1/auth/google/callback?code=${code2}&state=${state}`))).toBe(`${APP}/sign-in?error=google_failed`);

    // A tampered state cookie (a plain request, so ONLY the forged cookie is sent).
    const b3 = await h.browser();
    const start3 = await b3.get("/api/v1/auth/google/start");
    const state3 = new URL(location(start3)).searchParams.get("state") ?? "";
    const code3 = h.fakeGoogle.choose(state3, profile);
    const tampered = await request(h.app).get(`/api/v1/auth/google/callback?code=${code3}&state=${state3}`).set("Cookie", "vd_oauth=v1.AAAA.BBBB.CCCC");
    expect(location(tampered)).toBe(`${APP}/sign-in?error=google_failed`);

    // The exact code + state that just worked, sent again: refused (state cookie used up, code single-use).
    const b4 = await h.browser();
    const start4 = await b4.get("/api/v1/auth/google/start");
    const state4 = new URL(location(start4)).searchParams.get("state") ?? "";
    const callback = `/api/v1/auth/google/callback?code=${h.fakeGoogle.choose(state4, profile)}&state=${state4}`;
    expect(location(await b4.get(callback))).toBe(`${APP}/`);
    expect(location(await b4.get(callback))).toBe(`${APP}/sign-in?error=google_failed`);
    const stolenCookie = setCookie(start4, "vd_oauth")?.split(";")[0] ?? "";
    expect(location(await request(h.app).get(callback).set("Cookie", stolenCookie))).toBe(`${APP}/sign-in?error=google_failed`);
    expect(await h.db.prisma.user.count({ where: { email: "attacked@gmail.com" } })).toBe(1);
  });
});

describe("connecting and disconnecting Google in Security settings", () => {
  it("connecting needs 'Confirm it's you', and a Google account can't serve two Vendora accounts", async () => {
    const { browser } = await h.signUp({ email: "connect-me@example.com" });
    const noConfirm = await browser.get("/api/v1/auth/google/start?mode=connect");
    expect(location(noConfirm)).toBe(`${APP}/account/security?error=reauth_required`);

    await browser.post(AUTH.confirm, { password: GOOD_PASSWORD });
    const res = await h.googleSignIn(browser, googleProfile("connect-me.personal@gmail.com"), { mode: "connect" });
    expect(location(res)).toBe(`${APP}/account/security?google=connected`);
    expect((await browser.get(AUTH.security)).body.google).toEqual({ connected: true, email: "connect-me.personal@gmail.com" });
    expect(h.outbox.lastTo("connect-me@example.com")?.kind).toBe("google-connected");

    const { browser: other } = await h.signUp({ email: "wants-same-google@example.com" });
    await other.post(AUTH.confirm, { password: GOOD_PASSWORD });
    const taken = await h.googleSignIn(other, googleProfile("connect-me.personal@gmail.com"), { mode: "connect" });
    expect(location(taken)).toBe(`${APP}/account/security?error=google_already_used`);

    const signedOut = await (await h.browser()).get("/api/v1/auth/google/start?mode=connect");
    expect(location(signedOut)).toBe(`${APP}/account/security?error=sign_in_required`);
  });

  it("disconnecting needs 'Confirm it's you' and a password, so nobody locks themselves out", async () => {
    // Google-only account: can't disconnect.
    const googleOnly = await h.browser();
    await h.googleSignIn(googleOnly, googleProfile("google-only@gmail.com"));
    await googleOnly.loadCsrfToken();
    await googleOnly.post(AUTH.confirmSendCode);
    await googleOnly.post(AUTH.confirm, { code: h.codeFor("google-only@gmail.com") });
    const refused = await googleOnly.post("/api/v1/auth/google/disconnect");
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain("Add a password first");

    // Account with a password: confirm, then disconnect.
    const { browser, user } = await h.signUp({ email: "disconnect-me@example.com" });
    await browser.post(AUTH.confirm, { password: GOOD_PASSWORD });
    await h.googleSignIn(browser, googleProfile("disconnect-me.g@gmail.com"), { mode: "connect" });
    h.advance(601); // the confirmation expired
    expect((await browser.post("/api/v1/auth/google/disconnect")).body.error.code).toBe("REAUTH_REQUIRED");
    await browser.post(AUTH.confirm, { password: GOOD_PASSWORD });
    expect((await browser.post("/api/v1/auth/google/disconnect")).body).toEqual({ connected: false });
    expect(await typesOf(user.id)).toEqual(expect.arrayContaining(["GOOGLE_CONNECTED", "GOOGLE_DISCONNECTED"]));
    expect(h.outbox.lastTo("disconnect-me@example.com")?.kind).toBe("google-disconnected");
    expect((await browser.get(AUTH.security)).body.google).toEqual({ connected: false, email: null });
  });
});

describe("when Google sign-in isn't set up", () => {
  it("says so, and 'Continue with Google' sends the person back with an error", async () => {
    const off = new GoogleService({ prisma: h.db.prisma, kv: new MemoryKv(), auth: {} as never, identity: null, email: new DevOutbox(), config: testConfig() });
    expect(off.enabled).toBe(false);
    await expect(off.start({ mode: "sign_in", keepSignedIn: false })).rejects.toBeInstanceOf(GoogleFlowError);
  });
});
