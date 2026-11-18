/**
 * What sign-in does while Redis is down (decision A):
 * - endpoints that need brute-force protection answer 503 instead of running without it;
 * - people already signed in keep using the shop (logged);
 * - staying signed in (refresh) and signing out keep working.
 */
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AUTH, createAuthHarness, GOOD_PASSWORD, type AuthHarness } from "../support/authHarness.js";
import { setCookie } from "../support/browser.js";

let h: AuthHarness;
beforeAll(async () => {
  h = await createAuthHarness();
}, 60_000);
afterAll(() => h?.close());
afterEach(() => {
  h.redis.down = false;
});

const raw = (res: { headers: Record<string, unknown> }, name: string) => setCookie(res, name)?.split(";")[0]?.slice(name.length + 1) ?? "";
const logged = (text: string) => h.logs.some((l) => l.msg.includes(text));

describe("while Redis is down", () => {
  it("sign-in, sign-up, code and password endpoints answer 503 with Retry-After, before touching the database", async () => {
    const { browser } = await h.signUp({ email: "outage-user@example.com" });
    const anon = await h.browser();
    h.redis.down = true;

    const calls = [
      () => anon.post(AUTH.register, { name: "New", email: "outage-new@example.com", password: GOOD_PASSWORD }),
      () => anon.post(AUTH.login, { email: "outage-user@example.com", password: GOOD_PASSWORD }),
      () => anon.post(AUTH.verifyEmail, { email: "outage-user@example.com", code: "123456" }),
      () => anon.post(AUTH.resend, { email: "outage-user@example.com" }),
      () => anon.post(AUTH.forgot, { email: "outage-user@example.com" }),
      () => anon.post(AUTH.reset, { token: "x".repeat(43), password: GOOD_PASSWORD }),
      () => browser.post(AUTH.change, { currentPassword: GOOD_PASSWORD, newPassword: "another good passphrase" })
    ];
    for (const call of calls) {
      const res = await call();
      expect(res.status).toBe(503);
      expect(res.body.error).toMatchObject({ code: "SERVICE_UNAVAILABLE", message: "This is briefly unavailable. Please try again in a minute.", details: { retryAfterSeconds: 30 } });
      expect(res.headers["retry-after"]).toBe("30");
    }
    expect(await h.db.prisma.user.count({ where: { email: "outage-new@example.com" } })).toBe(0);
  });

  it("people already signed in keep using the shop (logged as a warning)", async () => {
    const { browser } = await h.signUp({ email: "outage-shopper@example.com" });
    h.redis.down = true;
    const res = await browser.get(AUTH.me);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("outage-shopper@example.com");
    expect(logged("access pass accepted without the sign-out check")).toBe(true);
  });

  it("staying signed in (refresh) keeps working: it only needs the database", async () => {
    const { browser } = await h.signUp({ email: "outage-refresh@example.com" });
    h.redis.down = true;
    expect((await browser.post(AUTH.refresh)).status).toBe(200);
    expect((await browser.get(AUTH.me)).status).toBe(200);
  });

  it("signing out still works; the known trade-off is that the old pass stays valid until it expires (logged)", async () => {
    const { browser, res, user } = await h.signUp({ email: "outage-logout@example.com" });
    const access = raw(res, "vd_at");
    const refresh = raw(res, "vd_rt");
    h.redis.down = true;

    const out = await browser.post(AUTH.logout);
    expect(out.status).toBe(200);
    expect(setCookie(out, "vd_at")).toContain("Expires=Thu, 01 Jan 1970");
    expect((await h.db.prisma.session.findMany({ where: { userId: user.id } })).map((s) => s.revokedReason)).toEqual(["logout"]);
    expect(logged("signed-out access pass stays valid up to 15 minutes")).toBe(true);

    h.redis.down = false;
    // The sign-out list couldn't be saved, so this copied pass keeps working until it expires (≤ 15 min)…
    expect((await request(h.app).get(AUTH.me).set("Cookie", `vd_at=${access}`)).status).toBe(200);
    // …but the sign-in itself is over in the database: it can't be renewed.
    const csrf = await request(h.app).get("/api/v1/auth/csrf");
    const renew = await request(h.app)
      .post(AUTH.refresh)
      .set("Cookie", `vd_csid=${raw(csrf, "vd_csid")}; vd_csrf=${raw(csrf, "vd_csrf")}; vd_rt=${refresh}`)
      .set("X-CSRF-Token", csrf.body.csrfToken)
      .send({});
    expect(renew.status).toBe(401);
  });
});

describe("when Redis is back", () => {
  it("everything works normally again", async () => {
    await h.signUp({ email: "outage-recovered@example.com" });
    h.redis.down = true;
    expect((await (await h.browser()).post(AUTH.login, { email: "outage-recovered@example.com", password: GOOD_PASSWORD })).status).toBe(503);
    h.redis.down = false;
    expect((await (await h.browser()).post(AUTH.login, { email: "outage-recovered@example.com", password: GOOD_PASSWORD })).status).toBe(200);
  });
});
