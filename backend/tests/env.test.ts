import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";

describe("loadConfig", () => {
  it("uses safe defaults for local development", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ NODE_ENV: "development", PORT: 4000, CORS_ORIGINS: ["http://localhost:5173"], TRUST_PROXY_HOPS: 0, JSON_BODY_LIMIT: "10kb" });
    expect(c.DATABASE_URL).toBeUndefined();
  });

  it("treats empty values from .env as not set", () => {
    expect(loadConfig({ DATABASE_URL: "", REDIS_URL: "" }).REDIS_URL).toBeUndefined();
  });

  it("splits several CORS origins", () => {
    expect(loadConfig({ CORS_ORIGINS: "http://localhost:5173, https://vendora.example" }).CORS_ORIGINS).toEqual(["http://localhost:5173", "https://vendora.example"]);
  });

  it("refuses to start in production without the database and Redis, without printing secrets", () => {
    const run = () => loadConfig({ NODE_ENV: "production", CORS_ORIGINS: "https://vendora.example", REDIS_URL: "" });
    expect(run).toThrow(/DATABASE_URL: is required in production/);
    expect(run).toThrow(/REDIS_URL: is required in production/);
  });

  it("requires https frontend origins in production", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "production", CORS_ORIGINS: "http://vendora.example", DATABASE_URL: "postgresql://u:p@db.example/v", REDIS_URL: "rediss://default:p@redis.example:6379" })
    ).toThrow(/CORS_ORIGINS: must use https/);
  });

  it("never echoes the value of an invalid secret", () => {
    try {
      loadConfig({ REDIS_URL: "not a url with password s3cr3t" });
      expect.unreachable();
    } catch (err) {
      expect(String(err)).toContain("REDIS_URL");
      expect(String(err)).not.toContain("s3cr3t");
    }
  });

  it("rejects an invalid port", () => {
    expect(() => loadConfig({ PORT: "99999" })).toThrow(/PORT/);
  });
});
