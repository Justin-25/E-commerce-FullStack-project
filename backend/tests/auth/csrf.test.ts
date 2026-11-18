import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTH, createAuthHarness, GOOD_PASSWORD, type AuthHarness } from "../support/authHarness.js";
import { Browser, setCookie } from "../support/browser.js";

let h: AuthHarness;
beforeAll(async () => {
  h = await createAuthHarness();
}, 60_000);
afterAll(() => h?.close());

describe("CSRF protection", () => {
  it("hands out a token with httpOnly cookies", async () => {
    const res = await request(h.app).get("/api/v1/auth/csrf");
    expect(res.status).toBe(200);
    expect(typeof res.body.csrfToken).toBe("string");
    expect(setCookie(res, "vd_csrf")).toMatch(/HttpOnly; SameSite=Strict/);
    expect(setCookie(res, "vd_csid")).toMatch(/HttpOnly; SameSite=Lax/);
  });

  it("refuses a POST without the token, or with a token from another browser", async () => {
    const b = await h.browser();
    const missing = await b.agent.post(AUTH.login).send({ email: "a@example.com", password: "x" });
    expect(missing.status).toBe(403);
    expect(missing.body.error.code).toBe("CSRF_INVALID");

    const other = await h.browser();
    const foreign = await b.agent.post(AUTH.login).set("X-CSRF-Token", other.csrfToken).send({ email: "a@example.com", password: "x" });
    expect(foreign.body.error.code).toBe("CSRF_INVALID");

    const noCookies = await request(h.app).post(AUTH.login).set("X-CSRF-Token", b.csrfToken).send({ email: "a@example.com", password: "x" });
    expect(noCookies.body.error.code).toBe("CSRF_INVALID");
  });

  it("refuses requests from another website even with a valid token", async () => {
    const b = await h.browser();
    const evil = await b.agent.post(AUTH.login).set("Origin", "https://evil.example").set("X-CSRF-Token", b.csrfToken).send({ email: "a@example.com", password: "x" });
    expect(evil.status).toBe(403);
    expect(evil.body.error.code).toBe("CSRF_INVALID");

    const crossSite = await b.agent.post(AUTH.login).set("Sec-Fetch-Site", "cross-site").set("X-CSRF-Token", b.csrfToken).send({ email: "a@example.com", password: "x" });
    expect(crossSite.body.error.code).toBe("CSRF_INVALID");

    const ours = await b.agent.post(AUTH.login).set("Origin", "http://localhost:5173").set("X-CSRF-Token", b.csrfToken).send({ email: "a@example.com", password: "x" });
    expect(ours.body.error.code).toBe("INVALID_CREDENTIALS"); // got past CSRF to the real check
  });

  it("issues a new token at sign-in and sign-out; the old one stops working", async () => {
    await h.signUp({ email: "csrf-rotate@example.com" });
    const b = await h.browser();
    const anonymousToken = b.csrfToken;
    const signedIn = await b.post(AUTH.login, { email: "csrf-rotate@example.com", password: GOOD_PASSWORD });
    expect(signedIn.status).toBe(200);
    expect(b.csrfToken).not.toBe(anonymousToken);

    const stale = await b.agent.post(AUTH.refresh).set("X-CSRF-Token", anonymousToken).send({});
    expect(stale.body.error.code).toBe("CSRF_INVALID");
    expect((await b.post(AUTH.refresh)).status).toBe(200); // the new token works

    const signedInToken = b.csrfToken;
    await b.post(AUTH.logout);
    expect((await b.agent.post(AUTH.login).set("X-CSRF-Token", signedInToken).send({})).body.error.code).toBe("CSRF_INVALID");
  });

  it("doesn't need a token for reading (GET)", async () => {
    const res = await new Browser(h.app).get(AUTH.me);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });
});
