import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTH, createAuthHarness, GOOD_PASSWORD, type AuthHarness } from "../support/authHarness.js";
import { setCookie } from "../support/browser.js";

let h: AuthHarness;
beforeAll(async () => {
  h = await createAuthHarness();
}, 60_000);
afterAll(() => h?.close());

const sentBody = (email: string) => ({ status: "verification_sent", email, codeExpiresInSeconds: 600 });

describe("POST /auth/register", () => {
  it("creates an unverified shopper, stores only an Argon2id hash, and emails a 6-digit code", async () => {
    const b = await h.browser();
    const res = await b.post(AUTH.register, { name: " Maria Santos ", email: " Maria.Santos@Example.com ", password: GOOD_PASSWORD });

    expect(res.status).toBe(202);
    expect(res.body).toEqual(sentBody("maria.santos@example.com"));
    const user = await h.db.prisma.user.findUniqueOrThrow({ where: { email: "maria.santos@example.com" } });
    expect(user).toMatchObject({ name: "Maria Santos", role: "CUSTOMER", emailVerifiedAt: null });
    expect(user.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(user.passwordHash).not.toContain("horse");

    const mail = h.outbox.lastTo("maria.santos@example.com");
    expect(mail?.kind).toBe("verify-email");
    expect(mail?.text).toContain("expires in 10 minutes");
    expect(mail?.text).not.toContain("Maria"); // the typed-in name never goes into the email
    const code = h.codeFor("maria.santos@example.com");
    const stored = await h.db.prisma.authToken.findFirstOrThrow({ where: { userId: user.id, type: "EMAIL_VERIFY" } });
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/); // a keyed hash, never the code itself
    expect(stored.tokenHash).not.toContain(code);
  });

  it("gives the same answer for an email that already has an account, and tells the owner instead", async () => {
    await h.signUp({ email: "taken@example.com", name: "Original Owner" });
    const b = await h.browser();
    const res = await b.post(AUTH.register, { name: "Someone Else", email: "taken@example.com", password: "another good password" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual(sentBody("taken@example.com"));
    expect(h.outbox.lastTo("taken@example.com")?.kind).toBe("account-exists");
    const user = await h.db.prisma.user.findUniqueOrThrow({ where: { email: "taken@example.com" } });
    expect(user.name).toBe("Original Owner");
    const login = await (await h.browser()).post(AUTH.login, { email: "taken@example.com", password: GOOD_PASSWORD });
    expect(login.status).toBe(200); // the original password still works
  });

  it("sends the 'someone tried to sign up' notice at most once an hour", async () => {
    await h.signUp({ email: "notice@example.com" });
    const b = await h.browser();
    const before = h.outbox.sent.length;
    for (let i = 0; i < 3; i++) await b.post(AUTH.register, { name: "X", email: "notice@example.com", password: "another good password" });
    expect(h.outbox.sent.length - before).toBe(1);
  });

  it("lets a new sign-up replace the name and password of an account that was never verified", async () => {
    const b = await h.browser();
    await b.post(AUTH.register, { name: "First Try", email: "pending@example.com", password: "first password here" });
    const code = h.codeFor("pending@example.com");
    await b.post(AUTH.register, { name: "Second Try", email: "pending@example.com", password: "second password here" });

    const verified = await b.post(AUTH.verifyEmail, { email: "pending@example.com", code });
    expect(verified.status).toBe(200);
    expect(verified.body.user.name).toBe("Second Try");
    expect((await (await h.browser()).post(AUTH.login, { email: "pending@example.com", password: "first password here" })).status).toBe(401);
    expect((await (await h.browser()).post(AUTH.login, { email: "pending@example.com", password: "second password here" })).status).toBe(200);
  });

  it("rejects weak input with field errors, including passwords from data breaches", async () => {
    const b = await h.browser();
    const short = await b.post(AUTH.register, { name: "Ana", email: "ana@example.com", password: "short" });
    expect(short.status).toBe(400);
    expect(short.body.error.fields).toEqual([{ path: "password", message: "Use at least 8 characters" }]);

    const tooLong = await b.post(AUTH.register, { name: "Ana", email: "ana@example.com", password: "x".repeat(129) });
    expect(tooLong.body.error.fields[0].path).toBe("password");

    const breached = await b.post(AUTH.register, { name: "Ana", email: "ana@example.com", password: "password123" });
    expect(breached.status).toBe(400);
    expect(breached.body.error.fields[0]).toMatchObject({ path: "password", message: expect.stringContaining("data breach") });

    const bad = await b.post(AUTH.register, { name: "", email: "not-an-email", password: GOOD_PASSWORD });
    expect(bad.body.error.fields.map((f: { path: string }) => f.path).sort()).toEqual(["email", "name"]);
    expect(await h.db.prisma.user.count({ where: { email: "ana@example.com" } })).toBe(0);
  });

  it("only reads allowed fields: nobody can make themselves an admin or pre-verified", async () => {
    const b = await h.browser();
    await b.post(AUTH.register, { name: "Sneaky", email: "sneaky@example.com", password: GOOD_PASSWORD, role: "ADMIN", emailVerifiedAt: "2026-01-01T00:00:00Z" });
    const user = await h.db.prisma.user.findUniqueOrThrow({ where: { email: "sneaky@example.com" } });
    expect(user.role).toBe("CUSTOMER");
    expect(user.emailVerifiedAt).toBeNull();
  });
});

describe("POST /auth/verify-email", () => {
  it("signs in after the right code with httpOnly cookies, and returns no secrets", async () => {
    const { res, user } = await h.signUp({ email: "verify@example.com" });

    expect(res.body.user).toMatchObject({ email: "verify@example.com", role: "CUSTOMER", emailVerified: true, twoFactorEnabled: false });
    expect(typeof res.body.csrfToken).toBe("string");
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|passwordHash|twoFactorSecret/);

    const access = setCookie(res, "vd_at");
    const refresh = setCookie(res, "vd_rt");
    expect(access).toMatch(/; Path=\/; HttpOnly; SameSite=Lax$/); // no Expires: ends when the browser closes
    expect(refresh).toMatch(/; Path=\/api\/v1\/auth; HttpOnly; SameSite=Strict$/);

    const events = await h.db.prisma.securityEvent.findMany({ where: { userId: user.id } });
    expect(events.map((e) => e.type)).toEqual(["LOGIN_OK"]);
  });

  it("stops accepting even the right code after 5 wrong tries", async () => {
    const b = await h.browser();
    await b.post(AUTH.register, { name: "Guesser", email: "guess@example.com", password: GOOD_PASSWORD });
    const code = h.codeFor("guess@example.com");
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      const res = await b.post(AUTH.verifyEmail, { email: "guess@example.com", code: wrong });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_CODE");
    }
    expect((await b.post(AUTH.verifyEmail, { email: "guess@example.com", code })).body.error.code).toBe("INVALID_CODE");
  });

  it("refuses an expired code", async () => {
    const b = await h.browser();
    await b.post(AUTH.register, { name: "Late", email: "late@example.com", password: GOOD_PASSWORD });
    await h.db.prisma.authToken.updateMany({ where: { user: { email: "late@example.com" } }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await b.post(AUTH.verifyEmail, { email: "late@example.com", code: h.codeFor("late@example.com") });
    expect(res.body.error.code).toBe("INVALID_CODE");
  });

  it("accepts a code only once", async () => {
    const { browser } = await h.signUp({ email: "once@example.com" });
    const again = await browser.post(AUTH.verifyEmail, { email: "once@example.com", code: h.codeFor("once@example.com") });
    expect(again.body.error.code).toBe("INVALID_CODE");
  });

  it("gives unknown emails the same INVALID_CODE answer, and validates the code format", async () => {
    const b = await h.browser();
    const unknown = await b.post(AUTH.verifyEmail, { email: "nobody@example.com", code: "123456" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("INVALID_CODE");
    const malformed = await b.post(AUTH.verifyEmail, { email: "nobody@example.com", code: "12ab" });
    expect(malformed.body.error).toMatchObject({ code: "VALIDATION_ERROR", fields: [{ path: "code", message: "Enter the 6-digit code" }] });
  });
});

describe("POST /auth/resend-verification", () => {
  it("sends a new code at most once a minute, and the old code stops working", async () => {
    const b = await h.browser();
    await b.post(AUTH.register, { name: "Resender", email: "resend@example.com", password: GOOD_PASSWORD });
    const first = h.codeFor("resend@example.com");
    const count = h.outbox.sent.length;

    expect((await b.post(AUTH.resend, { email: "resend@example.com" })).status).toBe(202);
    expect(h.outbox.sent.length).toBe(count); // too soon: nothing sent

    h.advance(61);
    expect((await b.post(AUTH.resend, { email: "resend@example.com" })).body).toEqual(sentBody("resend@example.com"));
    expect(h.outbox.sent.length).toBe(count + 1);
    const second = h.codeFor("resend@example.com");
    if (first !== second) expect((await b.post(AUTH.verifyEmail, { email: "resend@example.com", code: first })).status).toBe(400);
    expect((await b.post(AUTH.verifyEmail, { email: "resend@example.com", code: second })).status).toBe(200);
  });

  it("answers 202 for unknown and already-verified emails without sending anything", async () => {
    await h.signUp({ email: "done@example.com" });
    h.advance(61);
    const b = await h.browser();
    const count = h.outbox.sent.length;
    expect((await b.post(AUTH.resend, { email: "done@example.com" })).status).toBe(202);
    expect((await b.post(AUTH.resend, { email: "ghost@example.com" })).body).toEqual(sentBody("ghost@example.com"));
    expect(h.outbox.sent.length).toBe(count);
  });
});
