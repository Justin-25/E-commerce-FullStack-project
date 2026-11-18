import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";
import { TEST_SECRETS } from "./helpers.js";

const prod = {
  NODE_ENV: "production",
  CORS_ORIGINS: "https://vendora.example",
  APP_URL: "https://vendora.example",
  DATABASE_URL: "postgresql://u:p@db.example/v",
  REDIS_URL: "rediss://default:p@redis.example:6379",
  ...TEST_SECRETS
};

describe("loadConfig", () => {
  it("uses safe defaults for local development", () => {
    const c = loadConfig({ ...TEST_SECRETS });
    expect(c).toMatchObject({ NODE_ENV: "development", PORT: 4000, CORS_ORIGINS: ["http://localhost:5173"], TRUST_PROXY_HOPS: 0, JSON_BODY_LIMIT: "10kb" });
    expect(c).toMatchObject({ APP_URL: "http://localhost:5173", AUTH_RATE_LIMIT_MAX: 30, EMAIL_PROVIDER: "outbox" });
    expect(c.DATABASE_URL).toBeUndefined();
  });

  it("treats empty values from .env as not set", () => {
    expect(loadConfig({ ...TEST_SECRETS, DATABASE_URL: "", REDIS_URL: "" }).REDIS_URL).toBeUndefined();
  });

  it("splits several CORS origins", () => {
    expect(loadConfig({ ...TEST_SECRETS, CORS_ORIGINS: "http://localhost:5173, https://vendora.example" }).CORS_ORIGINS).toEqual(["http://localhost:5173", "https://vendora.example"]);
  });

  it("refuses to start without the secret keys, and says how to create them", () => {
    expect(() => loadConfig({})).toThrow(/ACCESS_TOKEN_SECRET: is missing \(run "npm run secrets"/);
    expect(() => loadConfig({})).toThrow(/CSRF_SECRET/);
    expect(() => loadConfig({})).toThrow(/CODE_HASH_SECRET/);
  });

  it("refuses short or reused secret keys", () => {
    expect(() => loadConfig({ ...TEST_SECRETS, CSRF_SECRET: "too-short" })).toThrow(/CSRF_SECRET: must be at least 32 random bytes/);
    expect(() => loadConfig({ ...TEST_SECRETS, CSRF_SECRET: TEST_SECRETS.ACCESS_TOKEN_SECRET })).toThrow(/each secret key must be different/);
  });

  it("refuses to start in production without the database and Redis, without printing secrets", () => {
    const run = () => loadConfig({ ...prod, DATABASE_URL: "", REDIS_URL: "" });
    expect(run).toThrow(/DATABASE_URL: is required in production/);
    expect(run).toThrow(/REDIS_URL: is required in production/);
  });

  it("requires https origins and a real email provider in production", () => {
    expect(() => loadConfig({ ...prod, CORS_ORIGINS: "http://vendora.example" })).toThrow(/CORS_ORIGINS: must use https/);
    expect(() => loadConfig({ ...prod, APP_URL: "http://vendora.example" })).toThrow(/APP_URL: must use https/);
    expect(() => loadConfig(prod)).toThrow(/EMAIL_PROVIDER: the dev outbox prints codes in the log/);
  });

  it("never echoes the value of an invalid secret", () => {
    for (const env of [{ REDIS_URL: "not a url with password s3cr3t" }, { ACCESS_TOKEN_SECRET: "s3cr3t" }]) {
      try {
        loadConfig({ ...TEST_SECRETS, ...env });
        expect.unreachable();
      } catch (err) {
        expect(String(err)).not.toContain("s3cr3t");
      }
    }
  });

  it("rejects an invalid port", () => {
    expect(() => loadConfig({ ...TEST_SECRETS, PORT: "99999" })).toThrow(/PORT/);
  });
});
