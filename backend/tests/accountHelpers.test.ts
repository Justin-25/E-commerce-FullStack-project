/** Unit tests for the small helpers behind the Security settings page. */
import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { locationFrom } from "../src/lib/location.js";
import { describeDevice } from "../src/lib/userAgent.js";
import { maskEmail } from "../src/modules/auth/security.service.js";
import { UA } from "./support/userAgents.js";


describe("describeDevice (design: 'Chrome on Windows', 'Safari on iPhone')", () => {
  it.each([
    [UA.chromeWindows, "Chrome on Windows", "desktop"],
    [UA.edgeWindows, "Edge on Windows", "desktop"],
    [UA.safariIphone, "Safari on iPhone", "mobile"],
    [UA.chromeIphone, "Chrome on iPhone", "mobile"],
    [UA.safariIpad, "Safari on iPad", "tablet"],
    [UA.firefoxMac, "Firefox on macOS", "desktop"],
    [UA.samsungAndroid, "Samsung Internet on Android", "mobile"],
    [UA.chromeAndroidTablet, "Chrome on Android", "tablet"],
    ["curl/8.5.0", "Unknown device", "unknown"],
    [undefined, "Unknown device", "unknown"]
  ])("%s → %s", (ua, label, type) => {
    expect(describeDevice(ua)).toEqual({ label, type });
  });

  it("handles very long input quickly (no risky patterns)", () => {
    const started = Date.now();
    describeDevice("Mozilla/5.0 ".repeat(100_000));
    expect(Date.now() - started).toBeLessThan(50);
  });
});

describe("locationFrom (hosting provider headers)", () => {
  const req = (headers: Record<string, string>) => ({ get: (name: string) => headers[name.toLowerCase()] }) as unknown as Request;

  it("reads Vercel's headers (URL-encoded city) and Cloudflare's", () => {
    expect(locationFrom(req({ "x-vercel-ip-city": "Quezon%20City", "x-vercel-ip-country": "PH" }), "vercel")).toBe("Quezon City, PH");
    expect(locationFrom(req({ "cf-ipcity": "Cebu City", "cf-ipcountry": "ph" }), "cloudflare")).toBe("Cebu City, PH");
    expect(locationFrom(req({ "x-vercel-ip-country": "PH" }), "vercel")).toBe("PH");
  });

  it("ignores the headers unless the config says we run behind that provider", () => {
    expect(locationFrom(req({ "x-vercel-ip-city": "Manila", "x-vercel-ip-country": "PH" }), "none")).toBeUndefined();
    expect(locationFrom(req({ "cf-ipcity": "Manila" }), "vercel")).toBeUndefined();
  });

  it("drops values that don't look like a place (no markup or odd characters stored)", () => {
    expect(locationFrom(req({ "x-vercel-ip-city": "<script>alert(1)</script>", "x-vercel-ip-country": "PHL" }), "vercel")).toBeUndefined();
    expect(locationFrom(req({ "x-vercel-ip-city": "%E0%A4%A", "x-vercel-ip-country": "PH" }), "vercel")).toBe("PH");
  });
});

describe("maskEmail", () => {
  it("keeps enough to recognise, not enough to copy", () => {
    expect(maskEmail("maria.santos@gmail.com")).toBe("maria.•••@gmail.com");
    expect(maskEmail("jo@example.com")).toBe("j•••@example.com");
  });
});
