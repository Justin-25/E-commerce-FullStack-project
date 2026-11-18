import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hmacHex } from "../../src/lib/crypto.js";
import { TEST_SECRETS } from "../helpers.js";
import { AUTH, createAuthHarness, GOOD_PASSWORD, type AuthHarness } from "../support/authHarness.js";
import { setCookie } from "../support/browser.js";

let h: AuthHarness;
// One proxy hop, so tests can pretend to come from different networks with X-Forwarded-For.
beforeAll(async () => {
  h = await createAuthHarness({ TRUST_PROXY_HOPS: "1" });
}, 60_000);
afterAll(() => h?.close());

const NEW_PASSWORD = "a brand new passphrase 2026";
const raw = (res: { headers: Record<string, unknown> }, name: string) => setCookie(res, name)?.split(";")[0]?.slice(name.length + 1) ?? "";
const meWith = (accessToken: string) => request(h.app).get(AUTH.me).set("Cookie", `vd_at=${accessToken}`);
const signIn = async (email: string, password: string, ip = "198.51.100.1") => (await h.browser({ "X-Forwarded-For": ip })).post(AUTH.login, { email, password });
const sentBody = (email: string) => ({ status: "reset_link_sent", email, expiresInSeconds: 1800 });

describe("POST /auth/forgot-password", () => {
  it("emails a single-use link that expires in 30 minutes; only a keyed hash is stored", async () => {
    const { user } = await h.signUp({ email: "forgot@example.com", name: "Maria Santos" });
    const res = await (await h.browser()).post(AUTH.forgot, { email: "Forgot@Example.com" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual(sentBody("forgot@example.com"));
    const mail = h.outbox.lastTo("forgot@example.com");
    expect(mail).toMatchObject({ kind: "password-reset", subject: "Reset your Vendora password" });
    expect(mail?.text).toContain("http://localhost:5173/reset-password#token=");
    expect(mail?.text).toContain("Hi Maria Santos");

    const token = h.resetTokenFor("forgot@example.com");
    const stored = await h.db.prisma.authToken.findFirstOrThrow({ where: { userId: user.id, type: "PASSWORD_RESET" } });
    expect(stored.tokenHash).toBe(hmacHex(TEST_SECRETS.CODE_HASH_SECRET, `link:PASSWORD_RESET:${token}`));
    expect(stored.tokenHash).not.toContain(token);
    const minutes = (stored.expiresAt.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(29.5);
    expect(minutes).toBeLessThanOrEqual(30);
  });

  it("gives the same answer for unknown emails and sends nothing", async () => {
    const before = h.outbox.sent.length;
    const res = await (await h.browser()).post(AUTH.forgot, { email: "nobody-here@example.com" });
    expect(res.status).toBe(202);
    expect(res.body).toEqual(sentBody("nobody-here@example.com"));
    expect(h.outbox.sent.length).toBe(before);
  });

  it("sends at most one email a minute; a newer link cancels the older one", async () => {
    await h.signUp({ email: "twice@example.com" });
    const b = await h.browser();
    await b.post(AUTH.forgot, { email: "twice@example.com" });
    const first = h.resetTokenFor("twice@example.com");
    const count = h.outbox.sent.length;
    await b.post(AUTH.forgot, { email: "twice@example.com" });
    expect(h.outbox.sent.length).toBe(count);

    h.advance(61);
    await b.post(AUTH.forgot, { email: "twice@example.com" });
    const second = h.resetTokenFor("twice@example.com");
    expect(second).not.toBe(first);
    expect((await b.post(AUTH.reset, { token: first, password: NEW_PASSWORD })).body.error.code).toBe("INVALID_LINK");
    expect((await b.post(AUTH.reset, { token: second, password: NEW_PASSWORD })).status).toBe(200);
  });

  it("sends at most 5 links a day per address", async () => {
    await h.signUp({ email: "daily@example.com" });
    const b = await h.browser();
    const before = h.outbox.sent.filter((m) => m.to === "daily@example.com" && m.kind === "password-reset").length;
    for (let i = 0; i < 7; i++) {
      await b.post(AUTH.forgot, { email: "daily@example.com" });
      h.advance(61);
    }
    const after = h.outbox.sent.filter((m) => m.to === "daily@example.com" && m.kind === "password-reset").length;
    expect(after - before).toBe(5);
  });

  it("sends nothing to suspended accounts", async () => {
    await h.signUp({ email: "suspended-reset@example.com" });
    await h.db.prisma.user.update({ where: { email: "suspended-reset@example.com" }, data: { status: "SUSPENDED" } });
    const before = h.outbox.sent.length;
    expect((await (await h.browser()).post(AUTH.forgot, { email: "suspended-reset@example.com" })).status).toBe(202);
    expect(h.outbox.sent.length).toBe(before);
  });
});

describe("POST /auth/reset-password", () => {
  it("sets the new password, signs this device in and signs every other device out at once", async () => {
    const { browser: otherDevice, res: otherSignIn, user } = await h.signUp({ email: "reset@example.com" });
    const otherAccess = raw(otherSignIn, "vd_at");
    const b = await h.browser();
    await b.post(AUTH.forgot, { email: "reset@example.com" });

    const res = await b.post(AUTH.reset, { token: h.resetTokenFor("reset@example.com"), password: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("reset@example.com");
    expect(typeof res.body.csrfToken).toBe("string");
    expect((await b.get(AUTH.me)).status).toBe(200); // this device: signed in

    expect((await meWith(otherAccess)).status).toBe(401); // other device: its pass stopped working immediately
    expect((await otherDevice.post(AUTH.refresh)).status).toBe(401); // and it can't refresh

    expect((await signIn("reset@example.com", GOOD_PASSWORD)).status).toBe(401);
    expect((await signIn("reset@example.com", NEW_PASSWORD)).status).toBe(200);

    const updated = await h.db.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.passwordChangedAt).not.toBeNull();
    const events = (await h.db.prisma.securityEvent.findMany({ where: { userId: user.id } })).map((e) => e.type);
    expect(events).toContain("PASSWORD_RESET");
    expect(h.outbox.sent.filter((m) => m.to === "reset@example.com").map((m) => m.kind)).toContain("password-changed");
  });

  it("works once", async () => {
    await h.signUp({ email: "reuse-link@example.com" });
    const b = await h.browser();
    await b.post(AUTH.forgot, { email: "reuse-link@example.com" });
    const token = h.resetTokenFor("reuse-link@example.com");
    expect((await b.post(AUTH.reset, { token, password: NEW_PASSWORD })).status).toBe(200);
    const again = await b.post(AUTH.reset, { token, password: "yet another passphrase" });
    expect(again.status).toBe(400);
    expect(again.body.error).toMatchObject({ code: "INVALID_LINK", message: "This reset link has expired or was already used. Request a new one." });
  });

  it("refuses expired and made-up links, and incomplete ones", async () => {
    await h.signUp({ email: "expired-link@example.com" });
    const b = await h.browser();
    await b.post(AUTH.forgot, { email: "expired-link@example.com" });
    await h.db.prisma.authToken.updateMany({ where: { user: { email: "expired-link@example.com" }, type: "PASSWORD_RESET" }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await b.post(AUTH.reset, { token: h.resetTokenFor("expired-link@example.com"), password: NEW_PASSWORD })).body.error.code).toBe("INVALID_LINK");
    expect((await b.post(AUTH.reset, { token: "x".repeat(43), password: NEW_PASSWORD })).body.error.code).toBe("INVALID_LINK");
    const incomplete = await b.post(AUTH.reset, { token: "abc", password: NEW_PASSWORD });
    expect(incomplete.body.error.fields).toEqual([{ path: "token", message: "This reset link is incomplete" }]);
  });

  it("rejects weak or breached new passwords without using up the link", async () => {
    await h.signUp({ email: "weak-reset@example.com" });
    const b = await h.browser();
    await b.post(AUTH.forgot, { email: "weak-reset@example.com" });
    const token = h.resetTokenFor("weak-reset@example.com");
    expect((await b.post(AUTH.reset, { token, password: "short" })).body.error.fields[0].path).toBe("password");
    const breached = await b.post(AUTH.reset, { token, password: "password123" });
    expect(breached.body.error.fields[0]).toMatchObject({ path: "password", message: expect.stringContaining("data breach") });
    expect((await b.post(AUTH.reset, { token, password: NEW_PASSWORD })).status).toBe(200);
  });

  it("lifts the 15-minute sign-in pause ('Reset password instead' on the locked screen)", async () => {
    await h.signUp({ email: "locked-reset@example.com" });
    const ip = "203.0.113.77";
    for (let i = 0; i < 5; i++) await signIn("locked-reset@example.com", "wrong password!", ip);
    expect((await signIn("locked-reset@example.com", GOOD_PASSWORD, ip)).body.error.code).toBe("ACCOUNT_LOCKED");

    const b = await h.browser({ "X-Forwarded-For": ip });
    await b.post(AUTH.forgot, { email: "locked-reset@example.com" });
    expect((await b.post(AUTH.reset, { token: h.resetTokenFor("locked-reset@example.com"), password: NEW_PASSWORD })).status).toBe(200);
    expect((await signIn("locked-reset@example.com", NEW_PASSWORD, ip)).status).toBe(200);
  });

  it("verifies the email of an account that was never verified (the link proves inbox ownership)", async () => {
    const b = await h.browser();
    await b.post(AUTH.register, { name: "Never Verified", email: "never-verified@example.com", password: GOOD_PASSWORD });
    await b.post(AUTH.forgot, { email: "never-verified@example.com" });
    const res = await b.post(AUTH.reset, { token: h.resetTokenFor("never-verified@example.com"), password: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.emailVerified).toBe(true);
  });
});

describe("POST /auth/change-password", () => {
  it("needs a signed-in user", async () => {
    const res = await (await h.browser()).post(AUTH.change, { currentPassword: GOOD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(401);
  });

  it("changes the password, keeps this device signed in, and signs every other device out at once", async () => {
    const { browser: phone, res: phoneSignIn, user } = await h.signUp({ email: "change@example.com", keepSignedIn: true });
    const laptop = await h.browser();
    const laptopSignIn = await laptop.post(AUTH.login, { email: "change@example.com", password: GOOD_PASSWORD });
    const oldPhoneAccess = raw(phoneSignIn, "vd_at");

    const res = await phone.post(AUTH.change, { currentPassword: GOOD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("change@example.com");
    expect(setCookie(res, "vd_rt")).toContain("Expires="); // still "keep me signed in"

    expect((await phone.get(AUTH.me)).status).toBe(200);
    expect((await phone.post(AUTH.refresh)).status).toBe(200);
    expect((await meWith(oldPhoneAccess)).status).toBe(401); // passes from before the change are refused
    expect((await meWith(raw(laptopSignIn, "vd_at"))).status).toBe(401);
    expect((await laptop.post(AUTH.refresh)).status).toBe(401);

    expect((await signIn("change@example.com", GOOD_PASSWORD)).status).toBe(401);
    expect((await signIn("change@example.com", NEW_PASSWORD)).status).toBe(200);
    const events = (await h.db.prisma.securityEvent.findMany({ where: { userId: user.id } })).map((e) => e.type);
    expect(events).toContain("PASSWORD_CHANGED");
    expect(h.outbox.lastTo("change@example.com")?.kind).toBe("password-changed");
  });

  it("counts wrong current passwords toward the same 5-try lockout as sign-in", async () => {
    await h.signUp({ email: "guess-current@example.com" });
    const b = await h.browser({ "X-Forwarded-For": "203.0.113.88" });
    await b.post(AUTH.login, { email: "guess-current@example.com", password: GOOD_PASSWORD });
    for (const left of [4, 3, 2, 1]) {
      const res = await b.post(AUTH.change, { currentPassword: "not it at all", newPassword: NEW_PASSWORD });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ fields: [{ path: "currentPassword", message: "That's not your current password." }], details: { attemptsLeft: left } });
    }
    expect((await b.post(AUTH.change, { currentPassword: "not it at all", newPassword: NEW_PASSWORD })).body.error.code).toBe("ACCOUNT_LOCKED");
    expect((await signIn("guess-current@example.com", GOOD_PASSWORD, "203.0.113.88")).body.error.code).toBe("ACCOUNT_LOCKED");
    expect((await b.get(AUTH.me)).status).toBe(200); // the lockout doesn't sign anyone out
  });

  it("refuses the same password, breached passwords and weak ones", async () => {
    const { browser } = await h.signUp({ email: "same@example.com" });
    const same = await browser.post(AUTH.change, { currentPassword: GOOD_PASSWORD, newPassword: GOOD_PASSWORD });
    expect(same.body.error.fields).toEqual([{ path: "newPassword", message: "Choose a different password from the one you use now." }]);
    const breached = await browser.post(AUTH.change, { currentPassword: GOOD_PASSWORD, newPassword: "iloveyou2024" });
    expect(breached.body.error.fields[0]).toMatchObject({ path: "newPassword", message: expect.stringContaining("data breach") });
    const weak = await browser.post(AUTH.change, { currentPassword: GOOD_PASSWORD, newPassword: "short" });
    expect(weak.body.error.fields[0].path).toBe("newPassword");
    expect((await signIn("same@example.com", GOOD_PASSWORD)).status).toBe(200); // nothing changed
  });

  it("tells accounts without a password to use 'Forgot password?'", async () => {
    const { browser, user } = await h.signUp({ email: "no-password@example.com" });
    await h.db.prisma.user.update({ where: { id: user.id }, data: { passwordHash: null } });
    const res = await browser.post(AUTH.change, { currentPassword: "anything", newPassword: NEW_PASSWORD });
    expect(res.body.error.fields[0]).toMatchObject({ path: "currentPassword", message: expect.stringContaining("Forgot password?") });
  });
});
