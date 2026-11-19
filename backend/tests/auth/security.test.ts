import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTH, createAuthHarness, GOOD_PASSWORD, totpCode, type AuthHarness } from "../support/authHarness.js";
import { Browser, setCookie } from "../support/browser.js";
import { UA } from "../support/userAgents.js";

let h: AuthHarness;
beforeAll(async () => {
  h = await createAuthHarness({ TRUST_PROXY_HOPS: "1" });
}, 60_000);
afterAll(() => h?.close());

const raw = (res: { headers: Record<string, unknown> }, name: string) => setCookie(res, name)?.split(";")[0]?.slice(name.length + 1) ?? "";
const meWith = (accessToken: string) => request(h.app).get(AUTH.me).set("Cookie", `vd_at=${accessToken}`);
const signInAs = async (email: string, headers: Record<string, string> = {}) => {
  const b = await h.browser(headers);
  const res = await b.post(AUTH.login, { email, password: GOOD_PASSWORD });
  expect(res.body.status).toBe("signed_in");
  return { browser: b, res };
};
const confirmWithPassword = async (b: Browser) => expect((await b.post(AUTH.confirm, { password: GOOD_PASSWORD })).status).toBe(200);
const typesOf = async (userId: string) => (await h.db.prisma.securityEvent.findMany({ where: { userId } })).map((e) => e.type);

describe("GET /auth/security", () => {
  it("shows the account's sign-in details and which proof 'Confirm it's you' will ask for", async () => {
    const { browser, user } = await h.signUp({ email: "overview@example.com" });
    const res = await browser.get(AUTH.security);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      email: "overview@example.com",
      emailVerified: true,
      hasPassword: true,
      passwordChangedAt: null,
      twoFactor: { enabled: false, required: false, backupCodesLeft: 0 },
      confirmMethod: "password"
    });
    await h.enableTwoFactor(browser);
    expect((await browser.get(AUTH.security)).body.confirmMethod).toBe("app");
    await h.db.prisma.user.update({ where: { id: user.id }, data: { passwordHash: null, twoFactorEnabledAt: null, twoFactorSecret: null } });
    expect((await browser.get(AUTH.security)).body).toMatchObject({ hasPassword: false, confirmMethod: "email" });
  });
});

describe("Confirm it's you", () => {
  it("with the password: lasts 10 minutes, on this device only", async () => {
    await h.signUp({ email: "confirm-pw@example.com" });
    const { browser: laptop } = await signInAs("confirm-pw@example.com");
    const { browser: phone } = await signInAs("confirm-pw@example.com");
    expect((await laptop.get(AUTH.confirm)).body).toEqual({ method: "password", confirmed: false, expiresInSeconds: 0 });

    const wrong = await laptop.post(AUTH.confirm, { password: "not my password" });
    expect(wrong.body.error).toMatchObject({ code: "VALIDATION_ERROR", fields: [{ path: "password", message: "That's not your password." }], details: { attemptsLeft: 4 } });

    const ok = await laptop.post(AUTH.confirm, { password: GOOD_PASSWORD });
    expect(ok.body).toEqual({ confirmed: true, expiresInSeconds: 600 });
    expect((await laptop.get(AUTH.confirm)).body).toMatchObject({ confirmed: true });
    expect((await phone.get(AUTH.confirm)).body.confirmed).toBe(false); // a different sign-in (device) isn't confirmed

    h.advance(601);
    expect((await laptop.get(AUTH.confirm)).body.confirmed).toBe(false);
  });

  it("with the authenticator app when two-step verification is on (the password isn't enough)", async () => {
    const { browser, user } = await h.signUp({ email: "confirm-app@example.com" });
    const { manualKey } = await h.enableTwoFactor(browser);
    await h.allowCodeReuse(user.id);
    expect((await browser.post(AUTH.confirm, { password: GOOD_PASSWORD })).body.error.fields[0]).toMatchObject({ path: "code" });
    expect((await browser.post(AUTH.confirm, { code: totpCode(manualKey) })).body.confirmed).toBe(true);
  });

  it("with an emailed code for accounts without a password", async () => {
    const { browser, user } = await h.signUp({ email: "confirm-email@example.com" });
    await h.db.prisma.user.update({ where: { id: user.id }, data: { passwordHash: null } });
    expect((await browser.get(AUTH.confirm)).body.method).toBe("email");

    const sent = await browser.post(AUTH.confirmSendCode);
    expect(sent.status).toBe(202);
    expect(sent.body).toEqual({ status: "code_sent", email: "confirm•••@example.com", expiresInSeconds: 600 });
    expect(h.outbox.lastTo("confirm-email@example.com")?.kind).toBe("confirm-code");
    const code = h.codeFor("confirm-email@example.com");
    expect((await browser.post(AUTH.confirm, { code })).body.confirmed).toBe(true);
    expect((await browser.post(AUTH.confirm, { code })).body.error.code).toBe("INVALID_CODE"); // works once
  });

  it("doesn't email codes to accounts that confirm another way", async () => {
    const { browser } = await h.signUp({ email: "no-email-code@example.com" });
    expect((await browser.post(AUTH.confirmSendCode)).status).toBe(409);
  });

  it("wrong passwords count toward the sign-in lockout", async () => {
    await h.signUp({ email: "confirm-guess@example.com" });
    const { browser } = await signInAs("confirm-guess@example.com", { "X-Forwarded-For": "203.0.113.61" });
    for (let i = 0; i < 4; i++) await browser.post(AUTH.confirm, { password: `guess ${i}` });
    expect((await browser.post(AUTH.confirm, { password: "guess 5" })).body.error.code).toBe("ACCOUNT_LOCKED");
    expect((await browser.post(AUTH.confirm, { password: GOOD_PASSWORD })).body.error.code).toBe("ACCOUNT_LOCKED");
  });
});

describe("change email address", () => {
  it("needs 'Confirm it's you' first", async () => {
    const { browser } = await h.signUp({ email: "change-needs-confirm@example.com" });
    const res = await browser.post(AUTH.emailChange, { newEmail: "elsewhere@example.com" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: "REAUTH_REQUIRED", message: "Please confirm it's you to continue." });
  });

  it("proves the new address with a code, then changes it, tells the old address, and ends old links", async () => {
    const { browser, user } = await h.signUp({ email: "old-address@example.com", name: "Maria Santos" });
    await (await h.browser()).post(AUTH.forgot, { email: "old-address@example.com" }); // a reset link sitting in the old inbox
    const oldResetToken = h.resetTokenFor("old-address@example.com");
    await confirmWithPassword(browser);

    const start = await browser.post(AUTH.emailChange, { newEmail: " New-Address@Example.com " });
    expect(start.status).toBe(202);
    expect(start.body).toEqual({ status: "code_sent", email: "new-address@example.com", codeExpiresInSeconds: 600 });
    expect(h.outbox.lastTo("new-address@example.com")?.kind).toBe("email-change-code");
    expect((await h.db.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe("old-address@example.com"); // not yet

    const done = await browser.post(AUTH.emailChangeConfirm, { code: h.codeFor("new-address@example.com") });
    expect(done.status).toBe(200);
    expect(done.body.user).toMatchObject({ email: "new-address@example.com", emailVerified: true });

    const notice = h.outbox.lastTo("old-address@example.com");
    expect(notice?.kind).toBe("email-changed");
    expect(notice?.text).toContain("new-ad•••@example.com");
    expect((await (await h.browser()).post(AUTH.login, { email: "old-address@example.com", password: GOOD_PASSWORD })).status).toBe(401);
    expect((await (await h.browser()).post(AUTH.login, { email: "new-address@example.com", password: GOOD_PASSWORD })).status).toBe(200);
    expect((await (await h.browser()).post(AUTH.reset, { token: oldResetToken, password: "a brand new passphrase" })).body.error.code).toBe("INVALID_LINK");
    expect(await typesOf(user.id)).toContain("EMAIL_CHANGED");
  });

  it("refuses the current address, one used by another account, and invalid ones", async () => {
    await h.signUp({ email: "taken-elsewhere@example.com" });
    const { browser } = await h.signUp({ email: "wants-new@example.com" });
    await confirmWithPassword(browser);
    const field = async (newEmail: string) => (await browser.post(AUTH.emailChange, { newEmail })).body.error.fields[0];
    expect(await field("wants-new@example.com")).toMatchObject({ path: "newEmail", message: "That's already your email address." });
    expect(await field("taken-elsewhere@example.com")).toMatchObject({ path: "newEmail", message: "Another account already uses this email address." });
    expect(await field("not-an-email")).toMatchObject({ path: "newEmail" });
  });

  it("allows one code a minute per address, and a wrong code doesn't change anything", async () => {
    const { browser, user } = await h.signUp({ email: "slow-down@example.com" });
    await confirmWithPassword(browser);
    expect((await browser.post(AUTH.emailChange, { newEmail: "first-try@example.com" })).status).toBe(202);
    const again = await browser.post(AUTH.emailChange, { newEmail: "first-try@example.com" });
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe("RATE_LIMITED");
    expect((await browser.post(AUTH.emailChange, { newEmail: "typo-fixed@example.com" })).status).toBe(202); // fixing a typo is fine

    const code = h.codeFor("typo-fixed@example.com");
    expect((await browser.post(AUTH.emailChangeConfirm, { code: code === "000000" ? "111111" : "000000" })).body.error.code).toBe("INVALID_CODE");
    expect((await h.db.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe("slow-down@example.com");
    // Only the newest code works: the first address's code was replaced.
    expect((await browser.post(AUTH.emailChangeConfirm, { code })).body.user.email).toBe("typo-fixed@example.com");
  });
});

describe("where you're signed in", () => {
  it("lists each device once, this one first, with a readable name", async () => {
    await h.signUp({ email: "devices@example.com" });
    const { browser: laptop } = await signInAs("devices@example.com", { "User-Agent": UA.chromeWindows });
    await signInAs("devices@example.com", { "User-Agent": UA.safariIphone });
    await laptop.post(AUTH.refresh); // a refresh must not show up as another device

    const res = await laptop.get(AUTH.sessions);
    expect(res.status).toBe(200);
    const mine = res.body.sessions.filter((s: { device: string }) => s.device !== "Unknown device"); // (the sign-up browser has no UA)
    expect(mine.map((s: { device: string; deviceType: string; current: boolean }) => [s.device, s.deviceType, s.current])).toEqual([
      ["Chrome on Windows", "desktop", true],
      ["Safari on iPhone", "mobile", false]
    ]);
    const current = res.body.sessions[0];
    expect(current.location).toBeNull(); // no hosting location headers on a PC
    expect(new Date(current.signedInAt).getTime()).toBeLessThanOrEqual(new Date(current.lastActiveAt).getTime());
  });

  it("signs one other device out at once, and only your own devices", async () => {
    const { user } = await h.signUp({ email: "kick@example.com" });
    const { browser: laptop } = await signInAs("kick@example.com", { "User-Agent": UA.chromeWindows });
    const { browser: phone, res: phoneSignIn } = await signInAs("kick@example.com", { "User-Agent": UA.safariIphone });
    const phoneId = (await laptop.get(AUTH.sessions)).body.sessions.find((s: { device: string }) => s.device === "Safari on iPhone").id;

    expect((await laptop.post(AUTH.signOutDevice(phoneId))).body).toEqual({ signedOut: true, current: false });
    expect((await meWith(raw(phoneSignIn, "vd_at"))).status).toBe(401); // immediately
    expect((await phone.post(AUTH.refresh)).status).toBe(401);
    expect((await laptop.get(AUTH.me)).status).toBe(200);
    expect(await typesOf(user.id)).toContain("SESSION_REVOKED");

    const { browser: stranger } = await h.signUp({ email: "stranger@example.com" });
    const laptopId = (await laptop.get(AUTH.sessions)).body.sessions.find((s: { current: boolean }) => s.current).id;
    expect((await stranger.post(AUTH.signOutDevice(laptopId))).status).toBe(404);
    expect((await laptop.post(AUTH.signOutDevice("not-a-uuid"))).status).toBe(400);
    expect((await laptop.get(AUTH.me)).status).toBe(200);
  });

  it("'Sign out' on this device's own row is a normal sign-out", async () => {
    const { browser } = await h.signUp({ email: "self-row@example.com" });
    const id = (await browser.get(AUTH.sessions)).body.sessions[0].id;
    const res = await browser.post(AUTH.signOutDevice(id));
    expect(res.body).toMatchObject({ signedOut: true, current: true });
    expect(typeof res.body.csrfToken).toBe("string");
    expect(setCookie(res, "vd_at")).toContain("Expires=Thu, 01 Jan 1970");
    expect((await browser.get(AUTH.me)).status).toBe(401);
  });

  it("'Sign out of all other devices' ends them all at once and removes their 2FA trust, but keeps this one", async () => {
    const { browser: setup, user } = await h.signUp({ email: "all-others@example.com" });
    const { manualKey } = await h.enableTwoFactor(setup);
    const trustedSignIn = async () => {
      await h.allowCodeReuse(user.id);
      const b = await h.browser();
      await b.post(AUTH.login, { email: "all-others@example.com", password: GOOD_PASSWORD });
      expect((await b.post(AUTH.twoFactorVerify, { code: totpCode(manualKey), trustDevice: true })).body.status).toBe("signed_in");
      return b;
    };
    const laptop = await trustedSignIn();
    const tablet = await trustedSignIn();

    const res = await laptop.post(AUTH.signOutOthers);
    expect(res.body).toEqual({ signedOut: 2 }); // the tablet and the set-up browser
    expect((await tablet.get(AUTH.me)).status).toBe(401);
    expect((await setup.get(AUTH.me)).status).toBe(401);
    expect((await laptop.get(AUTH.me)).status).toBe(200);
    expect(await typesOf(user.id)).toContain("LOGOUT_ALL");

    // The tablet must enter a code again; the laptop is still trusted.
    expect((await tablet.post(AUTH.login, { email: "all-others@example.com", password: GOOD_PASSWORD })).body.status).toBe("two_factor_required");
    await laptop.post(AUTH.logout);
    expect((await laptop.post(AUTH.login, { email: "all-others@example.com", password: GOOD_PASSWORD })).body.status).toBe("signed_in");
  });

  it("shows the city from the hosting provider's headers, only when configured to trust them", async () => {
    await h.signUp({ email: "located@example.com" });
    const geoHeaders = { "x-vercel-ip-city": "Quezon%20City", "x-vercel-ip-country": "PH", "User-Agent": UA.firefoxMac };
    const vercelApp = h.buildApp({ GEO_HEADERS: "vercel" });
    const b = await Browser.open(vercelApp, geoHeaders);
    await b.post(AUTH.login, { email: "located@example.com", password: GOOD_PASSWORD });
    expect((await b.get(AUTH.sessions)).body.sessions[0]).toMatchObject({ device: "Firefox on macOS", location: "Quezon City, PH", current: true });
    expect((await b.get(AUTH.activity)).body.events[0]).toMatchObject({ type: "LOGIN_OK", location: "Quezon City, PH" });

    const spoofed = await h.browser(geoHeaders); // the default app trusts no location headers
    await spoofed.post(AUTH.login, { email: "located@example.com", password: GOOD_PASSWORD });
    expect((await spoofed.get(AUTH.sessions)).body.sessions[0].location).toBeNull();
  });
});

describe("recent security activity", () => {
  it("lists meaningful events newest first (failed attempts summarised by the pause), page by page", async () => {
    await h.signUp({ email: "activity@example.com" });
    const ip = { "X-Forwarded-For": "198.51.100.90", "User-Agent": UA.edgeWindows };
    const attacker = await h.browser(ip);
    for (let i = 0; i < 5; i++) await attacker.post(AUTH.login, { email: "activity@example.com", password: `guess ${i}` });
    const { browser } = await signInAs("activity@example.com", { "User-Agent": UA.chromeWindows });
    await browser.post(AUTH.change, { currentPassword: GOOD_PASSWORD, newPassword: "a brand new passphrase" });

    const all = await browser.get(AUTH.activity);
    expect(all.status).toBe(200);
    const types = all.body.events.map((e: { type: string }) => e.type);
    expect(types).toEqual(["PASSWORD_CHANGED", "LOGIN_OK", "LOCKED", "LOGIN_OK"]);
    expect(types).not.toContain("LOGIN_FAILED");
    expect(all.body.events[2]).toMatchObject({ type: "LOCKED", device: "Edge on Windows", deviceType: "desktop" });
    expect(all.body.nextCursor).toBeNull();

    const first = await browser.get(`${AUTH.activity}?limit=2`);
    expect(first.body.events.map((e: { type: string }) => e.type)).toEqual(["PASSWORD_CHANGED", "LOGIN_OK"]);
    const second = await browser.get(`${AUTH.activity}?limit=2&before=${first.body.nextCursor}`);
    expect(second.body.events.map((e: { type: string }) => e.type)).toEqual(["LOCKED", "LOGIN_OK"]);
    expect((await browser.get(`${AUTH.activity}?before=nope`)).status).toBe(400);
    expect((await browser.get(`${AUTH.activity}?limit=500`)).status).toBe(400);
  });

  it("only ever shows your own events", async () => {
    const { browser } = await h.signUp({ email: "only-mine@example.com" });
    const res = await browser.get(AUTH.activity);
    expect(res.body.events.map((e: { type: string }) => e.type)).toEqual(["LOGIN_OK"]);
  });
});
