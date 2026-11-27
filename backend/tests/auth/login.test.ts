import { argon2Sync, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Browser, setCookie } from "../support/browser.js";
import { AUTH, createAuthHarness, GOOD_PASSWORD, type AuthHarness } from "../support/authHarness.js";

let h: AuthHarness;
// One proxy hop, so tests can pretend to come from different networks with X-Forwarded-For.
beforeAll(async () => {
  h = await createAuthHarness({ TRUST_PROXY_HOPS: "1" });
}, 60_000);
afterAll(() => h?.close());

const fromNetwork = (ip: string) => h.browser({ "X-Forwarded-For": ip });
const login = (b: Browser, email: string, password: string, keepSignedIn?: boolean) =>
  b.post(AUTH.login, { email, password, ...(keepSignedIn === undefined ? {} : { keepSignedIn }) });

describe("POST /auth/login", () => {
  it("signs in with the right password; 'keep me signed in' makes the cookies last 30 days", async () => {
    await h.signUp({ email: "keep@example.com" });
    const res = await login(await h.browser(), "Keep@Example.com", GOOD_PASSWORD, true);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("keep@example.com");
    expect(setCookie(res, "vd_at")).toContain("Max-Age=900");
    const expires = /Expires=([^;]+)/.exec(setCookie(res, "vd_rt") ?? "")?.[1];
    const days = (new Date(expires ?? 0).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    const user = await h.db.prisma.user.findUniqueOrThrow({ where: { email: "keep@example.com" } });
    expect(user.lastLoginAt).not.toBeNull();
  });

  it("without 'keep me signed in' the sign-in ends with the browser (and after 1 day at most)", async () => {
    await h.signUp({ email: "brief@example.com" });
    const res = await login(await h.browser(), "brief@example.com", GOOD_PASSWORD);
    expect(setCookie(res, "vd_rt")).not.toMatch(/Expires|Max-Age/);
    const session = await h.db.prisma.session.findFirstOrThrow({ where: { user: { email: "brief@example.com" }, revokedAt: null }, orderBy: { createdAt: "desc" } });
    expect(session.persistent).toBe(false);
    expect(session.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(86_400_000);
  });

  it("shows attempts left, then pauses sign-in for 15 minutes after 5 wrong passwords", async () => {
    const { user } = await h.signUp({ email: "locked@example.com" });
    const b = await fromNetwork("203.0.113.10");
    for (const left of [4, 3, 2, 1]) {
      const res = await login(b, "locked@example.com", "wrong password!");
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({ code: "INVALID_CREDENTIALS", message: "Email or password is incorrect.", details: { attemptsLeft: left } });
    }
    const fifth = await login(b, "locked@example.com", "wrong password!");
    expect(fifth.status).toBe(429);
    expect(fifth.body.error).toMatchObject({ code: "ACCOUNT_LOCKED", details: { retryAfterSeconds: 900 } });
    expect(fifth.headers["retry-after"]).toBe("900");

    // Even the right password waits until the pause is over…
    expect((await login(b, "locked@example.com", GOOD_PASSWORD)).body.error.code).toBe("ACCOUNT_LOCKED");
    const events = await h.db.prisma.securityEvent.groupBy({ by: ["type"], where: { userId: user.id }, _count: true });
    expect(Object.fromEntries(events.map((e) => [e.type, e._count]))).toEqual({ LOGIN_OK: 1, LOGIN_FAILED: 5, LOCKED: 1 });

    // …then it unlocks by itself.
    h.advance(15 * 60 + 1);
    expect((await login(b, "locked@example.com", GOOD_PASSWORD)).status).toBe(200);
  });

  it("treats an email with no account exactly like a wrong password (nothing to learn)", async () => {
    await h.signUp({ email: "real@example.com" });
    const b = await fromNetwork("203.0.113.20");
    const real = await login(b, "real@example.com", "wrong password!");
    const ghost = await login(b, "ghost-account@example.com", "wrong password!");
    const strip = (body: { error: Record<string, unknown> }) => ({ ...body.error, requestId: undefined });
    expect(strip(ghost.body)).toEqual(strip(real.body));
    for (let i = 0; i < 3; i++) await login(b, "ghost-account@example.com", "wrong password!");
    expect((await login(b, "ghost-account@example.com", "wrong password!")).body.error.code).toBe("ACCOUNT_LOCKED");
  });

  it("only pauses the network the attempts came from, so a stranger can't lock you out", async () => {
    await h.signUp({ email: "target@example.com" });
    const attacker = await fromNetwork("198.51.100.66");
    for (let i = 0; i < 5; i++) await login(attacker, "target@example.com", "guess " + i);
    expect((await login(attacker, "target@example.com", GOOD_PASSWORD)).status).toBe(429);
    expect((await login(await fromNetwork("192.0.2.44"), "target@example.com", GOOD_PASSWORD)).status).toBe(200);
  });

  it("pauses an account attacked from many networks after 20 failures", async () => {
    await h.signUp({ email: "botnet@example.com" });
    const results: number[] = [];
    for (let i = 1; i <= 20; i++) results.push((await login(await fromNetwork(`10.0.${i}.1`), "botnet@example.com", "guess")).status);
    expect(results.slice(0, 19).every((s) => s === 401)).toBe(true);
    expect(results[19]).toBe(429);
    expect((await login(await fromNetwork("10.99.0.1"), "botnet@example.com", GOOD_PASSWORD)).body.error.code).toBe("ACCOUNT_LOCKED");
  });

  it("resets the count after a successful sign-in", async () => {
    await h.signUp({ email: "reset@example.com" });
    const b = await fromNetwork("203.0.113.30");
    for (let i = 0; i < 3; i++) await login(b, "reset@example.com", "wrong password!");
    expect((await login(b, "reset@example.com", GOOD_PASSWORD)).status).toBe(200);
    const next = await login(await fromNetwork("203.0.113.30"), "reset@example.com", "wrong password!");
    expect(next.body.error.details.attemptsLeft).toBe(4);
  });

  it("asks unverified accounts to verify — only after the right password — and emails a new code", async () => {
    const b = await h.browser();
    await b.post(AUTH.register, { name: "Unverified", email: "unverified@example.com", password: GOOD_PASSWORD });
    h.advance(61); // past the one-email-per-minute cooldown
    const before = h.outbox.sent.length;

    const wrong = await login(b, "unverified@example.com", "wrong password!");
    expect(wrong.body.error.code).toBe("INVALID_CREDENTIALS");
    const right = await login(b, "unverified@example.com", GOOD_PASSWORD);
    expect(right.status).toBe(403);
    expect(right.body.error).toMatchObject({ code: "EMAIL_NOT_VERIFIED", details: { email: "unverified@example.com" } });
    expect(h.outbox.sent.length).toBe(before + 1);
    expect(setCookie(right, "vd_at")).toBeUndefined();
  });

  it("refuses suspended accounts (after the right password) and accounts with no password", async () => {
    await h.signUp({ email: "suspended@example.com" });
    await h.db.prisma.user.update({ where: { email: "suspended@example.com" }, data: { status: "SUSPENDED", suspendedAt: new Date(), suspendedReason: "Test: suspended" } });
    expect((await login(await h.browser(), "suspended@example.com", GOOD_PASSWORD)).body.error.code).toBe("ACCOUNT_SUSPENDED");

    await h.db.prisma.user.create({ data: { email: "google-only@example.com", name: "Google User", emailVerifiedAt: new Date() } });
    expect((await login(await h.browser(), "google-only@example.com", "anything at all")).body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("upgrades a password hash made with older, weaker settings at the next sign-in", async () => {
    await h.signUp({ email: "upgrade@example.com" });
    const salt = randomBytes(16);
    const weak = argon2Sync("argon2id", { message: GOOD_PASSWORD, nonce: salt, memory: 8192, passes: 1, parallelism: 1, tagLength: 32 });
    const b64 = (x: Buffer) => x.toString("base64").replace(/=+$/, "");
    await h.db.prisma.user.update({ where: { email: "upgrade@example.com" }, data: { passwordHash: `$argon2id$v=19$m=8192,t=1,p=1$${b64(salt)}$${b64(weak)}` } });

    expect((await login(await h.browser(), "upgrade@example.com", GOOD_PASSWORD)).status).toBe(200);
    const user = await h.db.prisma.user.findUniqueOrThrow({ where: { email: "upgrade@example.com" } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it("limits sign-in requests per IP (stricter than the rest of the API)", async () => {
    const app = h.buildApp({ AUTH_RATE_LIMIT_MAX: "3" });
    const b = await Browser.open(app, { "X-Forwarded-For": "203.0.113.99" });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await login(b, `rl${i}@example.com`, "whatever pass")).status);
    expect(statuses).toEqual([401, 401, 401, 429]);
  });

  it("validates input", async () => {
    const res = await (await h.browser()).post(AUTH.login, { email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.body.error.fields.map((f: { path: string }) => f.path).sort()).toEqual(["email", "password"]);
  });
});
