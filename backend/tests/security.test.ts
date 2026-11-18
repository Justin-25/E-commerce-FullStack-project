/** Unit tests for the security building blocks used by sign-in. */
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createHibpCheck } from "../src/lib/breachedPasswords.js";
import { hmacHex, safeEqualHex, sixDigitCode } from "../src/lib/crypto.js";
import { MemoryKv } from "../src/lib/kv.js";
import { hashPassword, needsRehash, verifyPassword } from "../src/lib/password.js";

describe("password hashing (Argon2id)", () => {
  it("stores a salted PHC string that verifies only the right password", async () => {
    const a = await hashPassword("correct horse battery staple");
    const b = await hashPassword("correct horse battery staple");
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(a).not.toBe(b); // different random salt each time
    expect(await verifyPassword("correct horse battery staple", a)).toBe(true);
    expect(await verifyPassword("correct horse battery stapl", a)).toBe(false);
    expect(await verifyPassword("anything", "not a hash")).toBe(false);
  });

  it("treats the same text typed in different Unicode forms as the same password", async () => {
    const composed = "café-latte-2026"; // é as one character
    const decomposed = "café-latte-2026"; // e + combining accent
    expect(await verifyPassword(decomposed, await hashPassword(composed))).toBe(true);
  });

  it("flags hashes made with older settings for upgrade", async () => {
    expect(needsRehash(await hashPassword("x".repeat(10)))).toBe(false);
    expect(needsRehash("$argon2id$v=19$m=8192,t=1,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(true);
  });
});

describe("codes and keyed hashes", () => {
  it("makes 6-digit codes, including ones starting with 0", () => {
    const codes = Array.from({ length: 2000 }, sixDigitCode);
    expect(codes.every((c) => /^\d{6}$/.test(c))).toBe(true);
    expect(new Set(codes).size).toBeGreaterThan(1990);
  });

  it("hashes depend on the key, and comparison handles bad input", () => {
    const key = "a".repeat(43);
    expect(hmacHex(key, "123456")).toMatch(/^[0-9a-f]{64}$/);
    expect(hmacHex(key, "123456")).not.toBe(hmacHex("b".repeat(43), "123456"));
    expect(safeEqualHex(hmacHex(key, "1"), hmacHex(key, "1"))).toBe(true);
    expect(safeEqualHex(hmacHex(key, "1"), hmacHex(key, "2"))).toBe(false);
    expect(safeEqualHex("", "")).toBe(false);
    expect(safeEqualHex("abcd", "abcdef")).toBe(false);
  });
});

describe("MemoryKv (stand-in for Redis)", () => {
  it("expires keys, and counters keep the expiry from their first increment", async () => {
    let now = 0;
    const kv = new MemoryKv(() => now);
    expect(await kv.increment("c", 60)).toBe(1);
    now += 50_000;
    expect(await kv.increment("c", 60)).toBe(2); // doesn't restart the window
    expect(await kv.ttl("c")).toBe(10);
    now += 10_000;
    expect(await kv.get("c")).toBeNull();
    expect(await kv.ttl("c")).toBe(0);
  });

  it("setIfAbsent only sets once until expiry", async () => {
    let now = 0;
    const kv = new MemoryKv(() => now);
    expect(await kv.setIfAbsent("k", "1", 5)).toBe(true);
    expect(await kv.setIfAbsent("k", "2", 5)).toBe(false);
    now += 5000;
    expect(await kv.setIfAbsent("k", "3", 5)).toBe(true);
    expect(await kv.getMany(["k", "missing"])).toEqual(["3", null]);
  });
});

describe("breached-password check (Have I Been Pwned)", () => {
  const logger = pino({ level: "silent" });
  // SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
  const answer = (body: string, status = 200) => vi.fn(async () => new Response(body, { status }));

  it("sends only the first 5 characters of the hash, with padding requested", async () => {
    const fetchImpl = answer("1E4C9B93F3F0682250B6CF8331B7EE68FD8:3861493\r\n0000000000000000000000000000000000A:0");
    const check = createHibpCheck({ logger, fetchImpl });
    expect(await check("password")).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.pwnedpasswords.com/range/5BAA6");
    expect(new Headers(init.headers).get("Add-Padding")).toBe("true");
  });

  it("ignores padding lines (count 0) and unknown passwords", async () => {
    const check = createHibpCheck({ logger, fetchImpl: answer("1E4C9B93F3F0682250B6CF8331B7EE68FD8:0") });
    expect(await check("password")).toBe(false);
  });

  it("lets sign-up continue when the service is down or slow, and logs a warning", async () => {
    const warn = vi.fn();
    const down = createHibpCheck({ logger: { warn } as unknown as typeof logger, fetchImpl: answer("", 503) });
    expect(await down("password")).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    const hang = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("timeout")))));
    const slow = createHibpCheck({ logger, timeoutMs: 20, fetchImpl: hang as unknown as typeof fetch });
    expect(await slow("password")).toBe(false);
  });
});
