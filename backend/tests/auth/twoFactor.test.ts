import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTH, createAuthHarness, GOOD_PASSWORD, totpCode, type AuthHarness } from "../support/authHarness.js";
import { setCookie, type Browser } from "../support/browser.js";

let h: AuthHarness;
beforeAll(async () => {
  h = await createAuthHarness({ TRUST_PROXY_HOPS: "1" });
}, 60_000);
afterAll(() => h?.close());

const NEW_PASSWORD = "a brand new passphrase 2026";
const BACKUP_CODE = /^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/;

/** A user with 2FA on. Returns their key and backup codes. */
async function userWithTwoFactor(email: string) {
  const { browser, user } = await h.signUp({ email });
  const twoFactor = await h.enableTwoFactor(browser);
  await h.allowCodeReuse(user.id);
  return { browser, user, ...twoFactor };
}
const signIn = (b: Browser, email: string, password = GOOD_PASSWORD) => b.post(AUTH.login, { email, password });

describe("turning two-step verification on", () => {
  it("gives a QR link and key, stores the secret encrypted, and turns on only after a correct code", async () => {
    const { browser, user } = await h.signUp({ email: "setup@example.com" });
    expect((await browser.get(AUTH.twoFactor)).body).toEqual({ enabled: false, enabledAt: null, required: false, backupCodesLeft: 0 });

    const setup = await browser.post(AUTH.twoFactorSetup);
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/Vendora:setup%40example\.com\?.*issuer=Vendora/);
    expect(setup.body.manualKey).toMatch(/^[A-Z2-7]{4}( [A-Z2-7]{4})+$/);
    const secret = setup.body.manualKey.replace(/ /g, "");
    const pending = await h.db.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(pending.twoFactorSecret).toMatch(/^v1\./); // encrypted
    expect(pending.twoFactorSecret).not.toContain(secret);
    expect(pending.twoFactorEnabledAt).toBeNull(); // not on until a code proves the app works

    const wrong = await browser.post(AUTH.twoFactorEnable, { code: totpCode(setup.body.manualKey) === "000000" ? "111111" : "000000" });
    expect(wrong.body.error.code).toBe("INVALID_CODE");

    const on = await browser.post(AUTH.twoFactorEnable, { code: totpCode(setup.body.manualKey) });
    expect(on.status).toBe(200);
    expect(on.body.backupCodes).toHaveLength(10);
    expect(new Set(on.body.backupCodes).size).toBe(10);
    for (const code of on.body.backupCodes) expect(code).toMatch(BACKUP_CODE);
    const stored = await h.db.prisma.backupCode.findMany({ where: { userId: user.id } });
    expect(stored).toHaveLength(10);
    expect(stored.every((s) => /^[0-9a-f]{64}$/.test(s.codeHash))).toBe(true);

    const status = (await browser.get(AUTH.twoFactor)).body;
    expect(status).toMatchObject({ enabled: true, required: false, backupCodesLeft: 10 });
    expect((await browser.get(AUTH.me)).body.user.twoFactorEnabled).toBe(true);
    expect(h.outbox.lastTo("setup@example.com")?.kind).toBe("two-factor-enabled");
    expect((await h.db.prisma.securityEvent.findMany({ where: { userId: user.id } })).map((e) => e.type)).toContain("TWO_FA_ENABLED");
    expect((await browser.post(AUTH.twoFactorSetup)).status).toBe(409);
  });

  it("needs a signed-in user (or a seller/admin in the middle of signing in)", async () => {
    expect((await (await h.browser()).post(AUTH.twoFactorSetup)).status).toBe(401);
  });
});

describe("signing in with two-step verification", () => {
  it("asks for the code after the password; no session exists until the code is right", async () => {
    const { manualKey, user } = await userWithTwoFactor("tfa-login@example.com");
    const b = await h.browser();
    const step = await signIn(b, "tfa-login@example.com");
    expect(step.status).toBe(200);
    expect(step.body).toEqual({ status: "two_factor_required", expiresInSeconds: 300 });
    const stepCookie = setCookie(step, "vd_2fa") ?? "";
    for (const attribute of ["Max-Age=300", "Path=/api/v1/auth", "HttpOnly", "SameSite=Strict"]) expect(stepCookie).toContain(attribute);
    expect(setCookie(step, "vd_at")).toBeUndefined();
    expect((await b.get(AUTH.me)).status).toBe(401);

    const wrong = await b.post(AUTH.twoFactorVerify, { code: totpCode(manualKey) === "000000" ? "111111" : "000000" });
    expect(wrong.body.error).toMatchObject({ code: "INVALID_CODE", details: { attemptsLeft: 4 } });

    const ok = await b.post(AUTH.twoFactorVerify, { code: totpCode(manualKey) });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "signed_in", user: { id: user.id } });
    expect(setCookie(ok, "vd_2fa")).toContain("Expires=Thu, 01 Jan 1970");
    expect((await b.get(AUTH.me)).status).toBe(200);
    expect((await b.post(AUTH.twoFactorVerify, { code: totpCode(manualKey) })).body.error.code).toBe("CHALLENGE_EXPIRED"); // the step works once
  });

  it("won't accept the same code twice (replay)", async () => {
    const { manualKey } = await userWithTwoFactor("tfa-replay@example.com");
    const code = totpCode(manualKey);
    const first = await h.browser();
    await signIn(first, "tfa-replay@example.com");
    expect((await first.post(AUTH.twoFactorVerify, { code })).status).toBe(200);
    const second = await h.browser();
    await signIn(second, "tfa-replay@example.com");
    expect((await second.post(AUTH.twoFactorVerify, { code })).body.error.code).toBe("INVALID_CODE");
  });

  it("accepts a backup code once (typed any way), and emails the owner how many are left", async () => {
    const { backupCodes, user } = await userWithTwoFactor("tfa-backup@example.com");
    const typed = (backupCodes[0] ?? "").toUpperCase().replace("-", " ");
    const b = await h.browser();
    await signIn(b, "tfa-backup@example.com");
    expect((await b.post(AUTH.twoFactorVerify, { backupCode: typed })).status).toBe(200);
    expect(h.outbox.lastTo("tfa-backup@example.com")).toMatchObject({ kind: "backup-code-used" });
    expect(h.outbox.lastTo("tfa-backup@example.com")?.text).toContain("You have 9 left");
    expect((await b.get(AUTH.twoFactor)).body.backupCodesLeft).toBe(9);
    expect((await h.db.prisma.securityEvent.findMany({ where: { userId: user.id } })).map((e) => e.type)).toContain("BACKUP_CODE_USED");

    const again = await h.browser();
    await signIn(again, "tfa-backup@example.com");
    expect((await again.post(AUTH.twoFactorVerify, { backupCode: backupCodes[0] })).body.error).toMatchObject({
      code: "INVALID_CODE",
      message: "That backup code isn't right or was already used."
    });
  });

  it("5 wrong codes end the step and pause sign-in, like 5 wrong passwords", async () => {
    const { manualKey } = await userWithTwoFactor("tfa-guess@example.com");
    const b = await h.browser({ "X-Forwarded-For": "203.0.113.50" });
    await signIn(b, "tfa-guess@example.com");
    const wrong = totpCode(manualKey) === "000000" ? "111111" : "000000";
    for (const left of [4, 3, 2, 1]) expect((await b.post(AUTH.twoFactorVerify, { code: wrong })).body.error.details.attemptsLeft).toBe(left);
    expect((await b.post(AUTH.twoFactorVerify, { code: wrong })).body.error.code).toBe("ACCOUNT_LOCKED");
    expect((await b.post(AUTH.twoFactorVerify, { code: totpCode(manualKey) })).body.error.code).toBe("CHALLENGE_EXPIRED");
    expect((await signIn(b, "tfa-guess@example.com")).body.error.code).toBe("ACCOUNT_LOCKED");
  });

  it("the step expires after 5 minutes", async () => {
    const { manualKey } = await userWithTwoFactor("tfa-slow@example.com");
    const b = await h.browser();
    await signIn(b, "tfa-slow@example.com");
    h.advance(301);
    expect((await b.post(AUTH.twoFactorVerify, { code: totpCode(manualKey) })).body.error.code).toBe("CHALLENGE_EXPIRED");
  });

  it("validates the input: the app code or a backup code, not both", async () => {
    const b = await h.browser();
    const both = await b.post(AUTH.twoFactorVerify, { code: "123456", backupCode: "abcde-fghjk" });
    expect(both.body.error.code).toBe("VALIDATION_ERROR");
    const neither = await b.post(AUTH.twoFactorVerify, {});
    expect(neither.body.error.fields[0]).toMatchObject({ path: "code" });
  });
});

describe("trust this device for 30 days", () => {
  it("skips the code on that browser only, for that account only, until the password changes", async () => {
    const { manualKey, user } = await userWithTwoFactor("tfa-trust@example.com");
    const laptop = await h.browser();
    await signIn(laptop, "tfa-trust@example.com");
    const trusted = await laptop.post(AUTH.twoFactorVerify, { code: totpCode(manualKey), trustDevice: true });
    const cookie = setCookie(trusted, "vd_td") ?? "";
    expect(cookie).toMatch(/Path=\/api\/v1\/auth; Expires=.*; HttpOnly; SameSite=Strict/);
    const days = (new Date(/Expires=([^;]+)/.exec(cookie)?.[1] ?? 0).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    const row = await h.db.prisma.trustedDevice.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    await laptop.post(AUTH.logout);
    expect((await signIn(laptop, "tfa-trust@example.com")).body.status).toBe("signed_in"); // no code needed
    expect((await signIn(await h.browser(), "tfa-trust@example.com")).body.status).toBe("two_factor_required"); // other browsers still need it

    // Another account on the same laptop doesn't inherit the trust.
    const other = await userWithTwoFactor("tfa-trust-other@example.com");
    expect(other.user.id).not.toBe(user.id);
    expect((await signIn(laptop, "tfa-trust-other@example.com")).body.status).toBe("two_factor_required");

    // A password change ends every device's trust.
    await laptop.post(AUTH.login, { email: "tfa-trust@example.com", password: GOOD_PASSWORD });
    expect((await laptop.post(AUTH.change, { currentPassword: GOOD_PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(200);
    await laptop.post(AUTH.logout);
    expect((await signIn(laptop, "tfa-trust@example.com", NEW_PASSWORD)).body.status).toBe("two_factor_required");
  });
});

describe("sellers and admins", () => {
  it("must set up two-step verification while signing in, then are signed in; they can't turn it off", async () => {
    const { user } = await h.signUp({ email: "seller@example.com" });
    await h.db.prisma.user.update({ where: { id: user.id }, data: { role: "SELLER" } });
    const b = await h.browser();

    const step = await signIn(b, "seller@example.com");
    expect(step.body).toEqual({ status: "two_factor_setup_required", expiresInSeconds: 900 });
    expect((await b.get(AUTH.me)).status).toBe(401);

    const setup = await b.post(AUTH.twoFactorSetup);
    expect(setup.status).toBe(200);
    const on = await b.post(AUTH.twoFactorEnable, { code: totpCode(setup.body.manualKey) });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ status: "signed_in", user: { role: "SELLER", twoFactorEnabled: true } });
    expect(on.body.backupCodes).toHaveLength(10);
    expect((await b.get(AUTH.me)).status).toBe(200);
    expect((await b.get(AUTH.twoFactor)).body).toMatchObject({ enabled: true, required: true });

    const off = await b.post(AUTH.twoFactorDisable, { code: totpCode(setup.body.manualKey, 1) });
    expect(off.status).toBe(403);
    expect(off.body.error.code).toBe("FORBIDDEN");
  });

  it("the set-up step can't be used by a shopper's '2FA code' step or without signing in", async () => {
    const { user } = await h.signUp({ email: "admin@example.com" });
    await h.db.prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
    expect((await (await h.browser()).post(AUTH.twoFactorEnable, { code: "123456" })).status).toBe(401);
    const shopper = await userWithTwoFactor("not-setup@example.com");
    const b = await h.browser();
    await signIn(b, "not-setup@example.com");
    expect((await b.post(AUTH.twoFactorSetup)).status).toBe(401); // a "two_factor" step is not a "set-up" step
    expect(shopper.user.id).toBeTruthy();
  });
});

describe("password reset with two-step verification on", () => {
  it("still asks for the code: an email link alone never opens the account", async () => {
    const { manualKey } = await userWithTwoFactor("tfa-reset@example.com");
    const b = await h.browser();
    await b.post(AUTH.forgot, { email: "tfa-reset@example.com" });
    const reset = await b.post(AUTH.reset, { token: h.resetTokenFor("tfa-reset@example.com"), password: NEW_PASSWORD });
    expect(reset.body).toEqual({ status: "two_factor_required", expiresInSeconds: 300 });
    expect((await b.get(AUTH.me)).status).toBe(401);
    expect((await b.post(AUTH.twoFactorVerify, { code: totpCode(manualKey) })).body.status).toBe("signed_in");
  });
});

describe("turning off and new backup codes", () => {
  it("turning off needs a code, removes backup codes and trust, and emails the owner", async () => {
    const { browser, manualKey, user } = await userWithTwoFactor("tfa-off@example.com");
    const wrong = await browser.post(AUTH.twoFactorDisable, { code: totpCode(manualKey) === "000000" ? "111111" : "000000" });
    expect(wrong.body.error.code).toBe("INVALID_CODE");
    const off = await browser.post(AUTH.twoFactorDisable, { code: totpCode(manualKey) });
    expect(off.body).toEqual({ enabled: false });

    const after = await h.db.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after).toMatchObject({ twoFactorSecret: null, twoFactorEnabledAt: null });
    expect(await h.db.prisma.backupCode.count({ where: { userId: user.id } })).toBe(0);
    expect(h.outbox.lastTo("tfa-off@example.com")?.kind).toBe("two-factor-disabled");
    expect((await signIn(await h.browser(), "tfa-off@example.com")).body.status).toBe("signed_in");
  });

  it("new backup codes need an app code; the old ones stop working", async () => {
    const { browser, manualKey, backupCodes, user } = await userWithTwoFactor("tfa-renew@example.com");
    expect((await browser.post(AUTH.backupCodes, { backupCode: backupCodes[1] })).body.error.code).toBe("VALIDATION_ERROR");
    const renewed = await browser.post(AUTH.backupCodes, { code: totpCode(manualKey) });
    expect(renewed.status).toBe(200);
    expect(renewed.body.backupCodes).toHaveLength(10);
    expect(renewed.body.backupCodes).not.toContain(backupCodes[1]);

    const old = await h.browser();
    await signIn(old, "tfa-renew@example.com");
    expect((await old.post(AUTH.twoFactorVerify, { backupCode: backupCodes[1] })).body.error.code).toBe("INVALID_CODE");
    h.advance(15 * 60); // the wrong code above counted toward the lockout; start fresh
    const fresh = await h.browser();
    await signIn(fresh, "tfa-renew@example.com");
    expect((await fresh.post(AUTH.twoFactorVerify, { backupCode: renewed.body.backupCodes[0] })).status).toBe(200);
    expect((await h.db.prisma.securityEvent.findMany({ where: { userId: user.id } })).map((e) => e.type)).toContain("BACKUP_CODES_RENEWED");
  });
});
