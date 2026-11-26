import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DependencyUnavailableError } from "../../src/lib/errors.js";
import { CloudinaryStorage, cloudinarySignature, newPublicId, parseCloudinaryUrl } from "../../src/lib/media.js";
import { testConfig } from "../helpers.js";

afterEach(() => vi.unstubAllGlobals());

const URL_ = "cloudinary://123456789012345:abcdefghijklmnopqrstuvwxyz1@vendora-test";
const NOW = new Date("2026-11-23T01:00:00Z");
const TS = String(Math.floor(NOW.getTime() / 1000));

/** Replaces fetch: records each request and answers with the given status and JSON. */
function stubFetch(...answers: { status: number; json?: unknown }[]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: string | undefined }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: { method?: string; headers?: Record<string, string>; body?: URLSearchParams }) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body?.toString() });
    const a = answers.shift() ?? { status: 500 };
    return new Response(JSON.stringify(a.json ?? {}), { status: a.status, headers: { "content-type": "application/json" } });
  });
  return calls;
}

describe("Cloudinary signatures", () => {
  it("match Cloudinary's documented example (timestamp=1315060510, secret abcd)", () => {
    expect(cloudinarySignature({ timestamp: "1315060510" }, "abcd")).toBe("a21ad0f63beb4de2e5575204b79ab90bffb02c10");
  });

  it("sort the parameters and leave out file, cloud_name, resource_type and api_key", () => {
    const sig = cloudinarySignature({ type: "upload", public_id: "a/b", timestamp: "1", api_key: "9", file: "x", cloud_name: "c", resource_type: "image" }, "s");
    expect(sig).toBe(createHash("sha1").update("public_id=a/b&timestamp=1&type=uploads").digest("hex"));
  });

  it("read the dashboard's CLOUDINARY_URL, and the config refuses anything else", () => {
    expect(parseCloudinaryUrl(URL_)).toEqual({ apiKey: "123456789012345", apiSecret: "abcdefghijklmnopqrstuvwxyz1", cloudName: "vendora-test" });
    expect(() => parseCloudinaryUrl("https://example.com")).toThrow();
    expect(testConfig({ CLOUDINARY_URL: URL_ }).CLOUDINARY_URL).toBe(URL_);
    expect(testConfig({ CLOUDINARY_URL: "" }).CLOUDINARY_URL).toBeUndefined();
    expect(() => testConfig({ CLOUDINARY_URL: "cloudinary://key:secret@cloud" })).toThrow(/CLOUDINARY_URL/);
  });

  it("make storage names from a prefix and a random part", () => {
    const a = newPublicId("vendora/store-logos/u1");
    expect(a).toMatch(/^vendora\/store-logos\/u1\/[A-Za-z0-9_-]{16}$/);
    expect(newPublicId("vendora/store-logos/u1")).not.toBe(a);
  });
});

describe("CloudinaryStorage", () => {
  it("issues a signed upload ticket for exactly one place, type and set of formats, that can never replace a file", () => {
    const ticket = new CloudinaryStorage(URL_, undefined, () => NOW).ticket({ publicId: "vendora/store-documents/u1/abc", access: "private", allowedFormats: ["jpg", "pdf"], maxBytes: 10 });
    expect(ticket.url).toBe("https://api.cloudinary.com/v1_1/vendora-test/image/upload");
    const signed = { allowed_formats: "jpg,pdf", overwrite: "false", public_id: "vendora/store-documents/u1/abc", timestamp: TS, type: "authenticated" };
    expect(ticket.fields).toEqual({ ...signed, api_key: "123456789012345", signature: cloudinarySignature(signed, "abcdefghijklmnopqrstuvwxyz1") });
    expect(ticket.expiresAt).toBe(new Date(NOW.getTime() + 3_600_000).toISOString());
    expect(JSON.stringify(ticket)).not.toContain("abcdefghijklmnopqrstuvwxyz1"); // the secret never leaves the server
  });

  it("opens a private document through a signed download link that stops working after the given seconds", () => {
    const url = new URL(new CloudinaryStorage(URL_, undefined, () => NOW).downloadUrl("vendora/store-documents/u1/abc", "private", "pdf", 300));
    expect(url.origin + url.pathname).toBe("https://api.cloudinary.com/v1_1/vendora-test/image/download");
    const signed = { expires_at: String(Number(TS) + 300), format: "pdf", public_id: "vendora/store-documents/u1/abc", timestamp: TS, type: "authenticated" };
    expect(Object.fromEntries(url.searchParams)).toEqual({ ...signed, api_key: "123456789012345", signature: cloudinarySignature(signed, "abcdefghijklmnopqrstuvwxyz1") });
    expect(url.toString()).not.toContain("abcdefghijklmnopqrstuvwxyz1");
  });

  it("checks an upload with the Admin API (Basic auth) and reads its type, size and link", async () => {
    const calls = stubFetch({ status: 200, json: { public_id: "vendora/store-logos/u1/abc", format: "PNG", bytes: 1234, type: "upload", secure_url: "https://res.cloudinary.com/vendora-test/image/upload/v1/vendora/store-logos/u1/abc.png" } });
    const found = await new CloudinaryStorage(URL_).find("vendora/store-logos/u1/abc", "public");
    expect(found).toEqual({ publicId: "vendora/store-logos/u1/abc", access: "public", format: "png", bytes: 1234, url: "https://res.cloudinary.com/vendora-test/image/upload/v1/vendora/store-logos/u1/abc.png" });
    expect(calls[0]?.url).toBe("https://api.cloudinary.com/v1_1/vendora-test/resources/image/upload/vendora/store-logos/u1/abc");
    expect(calls[0]?.headers.authorization).toBe(`Basic ${Buffer.from("123456789012345:abcdefghijklmnopqrstuvwxyz1").toString("base64")}`);
  });

  it("looks private files up as 'authenticated' and never returns a link for them", async () => {
    const calls = stubFetch({ status: 200, json: { public_id: "p/u1/abc", format: "pdf", bytes: 99, secure_url: "https://res.cloudinary.com/x" } });
    expect((await new CloudinaryStorage(URL_).find("p/u1/abc", "private"))?.url).toBeNull();
    expect(calls[0]?.url).toContain("/resources/image/authenticated/p/u1/abc");
  });

  it("answers null for a file that isn't there, and 'unavailable' for outages and rate limits", async () => {
    stubFetch({ status: 404, json: { error: { message: "Resource not found" } } });
    expect(await new CloudinaryStorage(URL_).find("a/b/c", "public")).toBeNull();
    for (const status of [500, 503, 420]) {
      stubFetch({ status });
      await expect(new CloudinaryStorage(URL_).find("a/b/c", "public")).rejects.toBeInstanceOf(DependencyUnavailableError);
    }
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(new CloudinaryStorage(URL_).find("a/b/c", "public")).rejects.toBeInstanceOf(DependencyUnavailableError);
  });

  it("deletes with a signed destroy call that also clears cached copies", async () => {
    const calls = stubFetch({ status: 200, json: { result: "ok" } });
    await new CloudinaryStorage(URL_, undefined, () => NOW).remove("p/u1/abc", "private");
    expect(calls[0]?.url).toBe("https://api.cloudinary.com/v1_1/vendora-test/image/destroy");
    expect(calls[0]?.method).toBe("POST");
    const form = Object.fromEntries(new URLSearchParams(calls[0]?.body));
    const signed = { invalidate: "true", public_id: "p/u1/abc", timestamp: TS, type: "authenticated" };
    expect(form).toEqual({ ...signed, api_key: "123456789012345", signature: cloudinarySignature(signed, "abcdefghijklmnopqrstuvwxyz1") });
  });
});
