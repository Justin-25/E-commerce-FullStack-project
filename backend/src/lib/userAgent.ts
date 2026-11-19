/**
 * Turns a browser's User-Agent text into what the design shows: "Chrome on
 * Windows", "Safari on iPhone". Covers the common browsers with simple,
 * linear checks (no library, no risky regular expressions). Anything else is
 * "Unknown device".
 */
export type DeviceType = "desktop" | "mobile" | "tablet" | "unknown";

export interface DeviceDescription {
  label: string;
  type: DeviceType;
}

const BROWSERS: [test: string, name: string][] = [
  // Order matters: Edge, Opera and Samsung also say "Chrome"; Chrome also says "Safari".
  ["Edg/", "Edge"],
  ["EdgiOS/", "Edge"],
  ["OPR/", "Opera"],
  ["SamsungBrowser/", "Samsung Internet"],
  ["Firefox/", "Firefox"],
  ["FxiOS/", "Firefox"],
  ["CriOS/", "Chrome"],
  ["Chrome/", "Chrome"],
  ["Safari/", "Safari"]
];

const SYSTEMS: [test: string, name: string, type: DeviceType][] = [
  ["iPhone", "iPhone", "mobile"],
  ["iPad", "iPad", "tablet"],
  ["Android", "Android", "mobile"],
  ["Windows", "Windows", "desktop"],
  ["CrOS", "ChromeOS", "desktop"],
  ["Macintosh", "macOS", "desktop"],
  ["Linux", "Linux", "desktop"]
];

export function describeDevice(userAgent: string | null | undefined): DeviceDescription {
  const ua = (userAgent ?? "").slice(0, 512);
  const browser = BROWSERS.find(([test]) => ua.includes(test))?.[1];
  const system = SYSTEMS.find(([test]) => ua.includes(test));
  if (!browser && !system) return { label: "Unknown device", type: "unknown" };
  // Android tablets don't say "Mobile".
  const type = system?.[1] === "Android" && !ua.includes("Mobile") ? "tablet" : (system?.[2] ?? "unknown");
  const label = browser && system ? `${browser} on ${system[1]}` : (browser ?? `${system?.[1]} device`);
  return { label, type };
}
