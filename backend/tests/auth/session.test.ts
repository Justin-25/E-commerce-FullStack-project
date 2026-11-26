import { SignJWT } from "jose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/lib/crypto.js";
import { authKeys } from "../../src/modules/auth/keys.js";
import { TokenService } from "../../src/modules/auth/tokens.js";
import { TEST_SECRETS, testConfig } from "../helpers.js";
import { AUTH, createAuthHarness, type AuthHarness } from "../support/authHarness.js";
import { setCookie } from "../support/browser.js";

let h: AuthHarness;
beforeAll(async () => {
  h = await createAuthHarness();
}, 60_000);
afterAll(() => h?.close());

/** The raw (still URL-encoded) cookie value, as a browser would send it back. */
const raw = (res: { headers: Record<string, unknown> }, name: string) => setCookie(res, name)?.split(";")[0]?.slice(name.length + 1) ?? "";

/** A request from a different client that only has the cookies we give it (e.g. a stolen refresh pass). */
async function postWithCookies(path: string, cookies: Record<string, string>) {
  const csrf = await request(h.app).get("/api/v1/auth/csrf");
  const jar = { vd_csid: raw(csrf, "vd_csid"), vd_csrf: raw(csrf, "vd_csrf"), ...cookies };
  return request(h.app)
    .post(path)
    .set("Cookie", Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; "))
    .set("X-CSRF-Token", csrf.body.csrfToken)
    .send({});
}
const meWith = (accessToken: string) => request(h.app).get(AUTH.me).set("Cookie", `vd_at=${accessToken}`);
const key = new Uint8Array(Buffer.from(TEST_SECRETS.ACCESS_TOKEN_SECRET, "base64url"));

describe("GET /auth/me", () => {
  it("is 401 when signed out and returns the user when signed in", async () => {
    expect((await request(h.app).get(AUTH.me)).body.error.code).toBe("UNAUTHORIZED");
    const { browser } = await h.signUp({ email: "me@example.com" });
    const res = await browser.get(AUTH.me);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: "me@example.com", role: "CUSTOMER", emailVerified: true });
    expect(Object.keys(res.body.user).sort()).toEqual(["createdAt", "email", "emailVerified", "id", "name", "role", "twoFactorEnabled"]);
  });

  it("refuses forged, tampered, expired and unsigned passes", async () => {
    const { res, user } = await h.signUp({ email: "forge@example.com" });
    const valid = raw(res, "vd_at");
    expect((await meWith(valid)).status).toBe(200);

    const claims = { sid: "00000000-0000-7000-8000-000000000000", fid: "00000000-0000-4000-8000-000000000000", role: "ADMIN" };
    const sign = (secret: Uint8Array, exp: number | string) =>
      new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setSubject(user.id).setJti("x").setIssuer("vendora-api").setAudience("vendora-web").setIssuedAt().setExpirationTime(exp).sign(secret);

    const otherKey = await sign(new Uint8Array(32).fill(7), "15m");
    const expired = await sign(key, Math.floor(Date.now() / 1000) - 60);
    const [header, , signature] = valid.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({ ...claims, sub: user.id, role: "ADMIN" })).toString("base64url");
    const tampered = `${header}.${tamperedPayload}.${signature}`;
    const unsigned = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${tamperedPayload}.`;

    for (const token of [otherKey, expired, tampered, unsigned, "not-a-jwt"]) {
      expect((await meWith(token)).status).toBe(401);
    }
  });

  it("refuses a pass for an account that was suspended after signing in", async () => {
    const { browser } = await h.signUp({ email: "later-suspended@example.com" });
    await h.db.prisma.user.update({ where: { email: "later-suspended@example.com" }, data: { status: "SUSPENDED" } });
    expect((await browser.get(AUTH.me)).status).toBe(401);
  });

  it("refuses passes issued before the account's 'invalid before' time (used by password changes in 3b)", async () => {
    const { browser, res, user } = await h.signUp({ email: "invalid-before@example.com" });
    const claims = await new TokenService(testConfig()).verifyAccess(raw(res, "vd_at"));
    await h.kv.set(authKeys.invalidBefore(user.id), String((claims?.issuedAt ?? 0) + 1), 900);
    expect((await browser.get(AUTH.me)).status).toBe(401);
  });
});

describe("POST /auth/refresh", () => {
  it("swaps both passes; the old refresh pass is marked as used; the end date never moves", async () => {
    const { browser, res } = await h.signUp({ email: "rotate@example.com", keepSignedIn: true });
    const oldRefresh = raw(res, "vd_rt");
    const before = await h.db.prisma.session.findUniqueOrThrow({ where: { refreshTokenHash: sha256Hex(oldRefresh) } });

    const refreshed = await browser.post(AUTH.refresh);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.user.email).toBe("rotate@example.com");
    const newRefresh = raw(refreshed, "vd_rt");
    expect(newRefresh).not.toBe(oldRefresh);
    expect(raw(refreshed, "vd_at")).not.toBe(raw(res, "vd_at"));

    const old = await h.db.prisma.session.findUniqueOrThrow({ where: { id: before.id } });
    const next = await h.db.prisma.session.findUniqueOrThrow({ where: { refreshTokenHash: sha256Hex(newRefresh) } });
    expect(old.revokedReason).toBe("rotated");
    expect(next).toMatchObject({ familyId: before.familyId, expiresAt: before.expiresAt, persistent: true, revokedAt: null });
    expect((await browser.get(AUTH.me)).status).toBe(200);
  });

  it("signs out every device in the chain when a used refresh pass comes back (stolen copy)", async () => {
    const { browser, res, user } = await h.signUp({ email: "theft@example.com" });
    const stolen = raw(res, "vd_rt");
    const refreshed = await browser.post(AUTH.refresh);
    const currentAccess = raw(refreshed, "vd_at");
    // Pretend the real refresh happened more than 10 seconds ago (outside the two-tabs grace window).
    await h.db.prisma.session.update({ where: { refreshTokenHash: sha256Hex(stolen) }, data: { revokedAt: new Date(Date.now() - 11_000) } });

    const thief = await postWithCookies(AUTH.refresh, { vd_rt: stolen });
    expect(thief.status).toBe(401);

    const family = await h.db.prisma.session.findMany({ where: { userId: user.id } });
    expect(family.every((s) => s.revokedAt !== null)).toBe(true);
    expect(family.map((s) => s.revokedReason)).toContain("reuse_detected");
    expect(await h.db.prisma.securityEvent.count({ where: { userId: user.id, type: "TOKEN_REUSE_DETECTED" } })).toBe(1);
    expect((await browser.post(AUTH.refresh)).status).toBe(401); // the real device is signed out too
    expect((await meWith(currentAccess)).status).toBe(401); // and its access pass stopped working at once
  });

  it("answers 409 (not theft) when two tabs refresh at the same moment", async () => {
    const { browser, res } = await h.signUp({ email: "two-tabs@example.com" });
    const first = raw(res, "vd_rt");
    expect((await browser.post(AUTH.refresh)).status).toBe(200);
    const slowTab = await postWithCookies(AUTH.refresh, { vd_rt: first });
    expect(slowTab.status).toBe(409);
    expect(slowTab.body.error.code).toBe("CONFLICT");
    expect((await browser.post(AUTH.refresh)).status).toBe(200); // still signed in
  });

  it("refuses an expired sign-in and clears the cookies", async () => {
    const { browser, user } = await h.signUp({ email: "expired@example.com" });
    await h.db.prisma.session.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await browser.post(AUTH.refresh);
    expect(res.status).toBe(401);
    expect(setCookie(res, "vd_at")).toContain("Expires=Thu, 01 Jan 1970");
    expect(setCookie(res, "vd_rt")).toContain("Path=/api/v1/auth");
  });

  it("refuses a missing or made-up refresh pass", async () => {
    expect((await (await h.browser()).post(AUTH.refresh)).status).toBe(401);
    expect((await postWithCookies(AUTH.refresh, { vd_rt: "made-up-token" })).status).toBe(401);
  });
});

describe("POST /auth/logout", () => {
  it("ends the sign-in at once: the access pass, the refresh pass and the cookies all stop working", async () => {
    const { browser, res, user } = await h.signUp({ email: "bye@example.com" });
    const access = raw(res, "vd_at");
    const refresh = raw(res, "vd_rt");
    const out = await browser.post(AUTH.logout);
    expect(out.status).toBe(200);
    expect(typeof out.body.csrfToken).toBe("string");
    expect(setCookie(out, "vd_at")).toContain("Expires=Thu, 01 Jan 1970");

    expect((await meWith(access)).status).toBe(401);
    expect((await postWithCookies(AUTH.refresh, { vd_rt: refresh })).status).toBe(401);
    const sessions = await h.db.prisma.session.findMany({ where: { userId: user.id } });
    expect(sessions.map((s) => s.revokedReason)).toEqual(["logout"]);
  });

  it("is harmless when already signed out", async () => {
    const res = await (await h.browser()).post(AUTH.logout);
    expect(res.status).toBe(200);
  });
});

describe("role checks", () => {
  it("gives 401 signed out, 403 to shoppers, and lets admins in (a role change applies at the next refresh)", async () => {
    expect((await request(h.app).get("/api/v1/test/admin-only")).status).toBe(401);
    const { browser } = await h.signUp({ email: "future-admin@example.com" });
    const denied = await browser.get("/api/v1/test/admin-only");
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("FORBIDDEN");

    await h.db.prisma.user.update({ where: { email: "future-admin@example.com" }, data: { role: "ADMIN", adminRoles: ["SUPPORT"] } });
    await browser.post(AUTH.refresh);
    expect((await browser.get("/api/v1/test/admin-only")).status).toBe(200);
  });

  it("optional sign-in: pages can tell who's there without requiring it", async () => {
    expect((await request(h.app).get("/api/v1/test/whoami")).body).toEqual({ userId: null });
    const { browser, user } = await h.signUp({ email: "whoami@example.com" });
    expect((await browser.get("/api/v1/test/whoami")).body).toEqual({ userId: user.id });
  });
});
