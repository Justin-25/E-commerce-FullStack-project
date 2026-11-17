import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildApp } from "./helpers.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("GET /health (liveness)", () => {
  it("returns ok with security headers and a request id", async () => {
    const res = await request(buildApp()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.uptimeSeconds).toBe("number");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["strict-transport-security"]).toContain("max-age=");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-request-id"]).toMatch(UUID);
  });

  it("reuses a safe X-Request-Id and replaces an unsafe one", async () => {
    const app = buildApp();
    const safe = await request(app).get("/health").set("X-Request-Id", "checkout-test_42");
    expect(safe.headers["x-request-id"]).toBe("checkout-test_42");
    const unsafe = await request(app).get("/health").set("X-Request-Id", "<script>alert(1)</script>");
    expect(unsafe.headers["x-request-id"]).toMatch(UUID);
  });

  it("is not rate limited", async () => {
    const app = buildApp({ env: { RATE_LIMIT_MAX: "1" } });
    for (let i = 0; i < 3; i++) expect((await request(app).get("/health")).status).toBe(200);
  });
});

describe("GET /ready (readiness)", () => {
  it("is ready when every configured dependency answers", async () => {
    const res = await request(buildApp({ checks: { redis: async () => "PONG", database: null } })).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready", checks: { redis: "ok", database: "not_configured" } });
  });

  it("returns 503 without leaking why the dependency failed", async () => {
    const failing = async () => { throw new Error("NOAUTH secret-token-123"); };
    const res = await request(buildApp({ checks: { redis: failing } })).get("/ready");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "not_ready", checks: { redis: "error" } });
    expect(JSON.stringify(res.body)).not.toContain("secret-token");
  });

  it("treats a dependency that hangs as down", async () => {
    const hangs = () => new Promise(() => undefined);
    const res = await request(buildApp({ checks: { redis: hangs }, readinessTimeoutMs: 50 })).get("/ready");
    expect(res.status).toBe(503);
    expect(res.body.checks.redis).toBe("error");
  });
});

describe("error responses", () => {
  it("returns the standard 404 shape for unknown routes", async () => {
    const res = await request(buildApp()).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: "NOT_FOUND", message: "Route not found" });
    expect(res.body.error.requestId).toBe(res.headers["x-request-id"]);
  });

  it("rejects malformed JSON with 400 INVALID_JSON", async () => {
    const res = await request(buildApp()).post("/api/v1/echo").set("Content-Type", "application/json").send('{"email": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_JSON");
  });

  it("rejects bodies over the 10 KB limit with 413", async () => {
    const res = await request(buildApp()).post("/api/v1/echo").send({ note: "x".repeat(11 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("accepts a normal JSON body", async () => {
    const res = await request(buildApp()).post("/api/v1/echo").send({ email: "maria@example.com" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ body: { email: "maria@example.com" } });
  });

  it("hides internal error details (no message, no stack)", async () => {
    const res = await request(buildApp()).get("/api/v1/boom");
    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({ code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." });
    expect(res.text).not.toContain("hunter2");
    expect(res.text).not.toContain("at ");
  });

  it("passes safe AppError messages through", async () => {
    const res = await request(buildApp()).get("/api/v1/forbidden");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: "FORBIDDEN", message: "You can't do that" });
  });
});

describe("CORS", () => {
  it("allows the configured frontend origin with cookies", async () => {
    const res = await request(buildApp()).get("/health").set("Origin", "http://localhost:5173");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("gives no CORS permission to other origins", async () => {
    const res = await request(buildApp()).get("/health").set("Origin", "https://evil.example");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers preflight requests from the frontend", async () => {
    const res = await request(buildApp())
      .options("/api/v1/echo")
      .set("Origin", "http://localhost:5173")
      .set("Access-Control-Request-Method", "POST");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
  });
});

describe("rate limiting", () => {
  it("returns 429 RATE_LIMITED after the limit, with RateLimit headers", async () => {
    const app = buildApp({ env: { RATE_LIMIT_MAX: "2" }, checks: {} });
    expect((await request(app).get("/ready")).status).toBe(200);
    expect((await request(app).get("/ready")).status).toBe(200);
    const res = await request(app).get("/ready");
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
    expect(res.headers["ratelimit-policy"]).toBeDefined();
  });
});

describe("query string parsing", () => {
  it("keeps the last value of repeated keys and never builds nested objects", async () => {
    const res = await request(buildApp()).get("/api/v1/query?sort=price&sort=name&price[$gt]=0&__proto__=x");
    // (an object literal `{ __proto__: "x" }` would set the prototype, so compare keys one by one)
    expect(Object.keys(res.body.query).sort()).toEqual(["__proto__", "price[$gt]", "sort"]);
    expect(res.body.query.sort).toBe("name");
    expect(res.body.query["price[$gt]"]).toBe("0");
    expect(Object.getOwnPropertyDescriptor(res.body.query, "__proto__")?.value).toBe("x");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
