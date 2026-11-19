import type { Request } from "express";
import type { Config } from "../config/env.js";

/**
 * "Manila, PH" from the hosting provider's location headers, which they add to
 * every request for free (nothing is sent to a third party). Only trusted when
 * the config says the API runs behind that provider, otherwise anyone could
 * send the headers. On your PC: no location.
 */
export function locationFrom(req: Request, mode: Config["GEO_HEADERS"]): string | undefined {
  if (mode === "none") return undefined;
  const [cityHeader, countryHeader] = mode === "vercel" ? ["x-vercel-ip-city", "x-vercel-ip-country"] : ["cf-ipcity", "cf-ipcountry"];
  const city = clean(decode(req.get(cityHeader)));
  const country = clean(req.get(countryHeader))?.toUpperCase();
  const parts = [city, country && /^[A-Z]{2}$/.test(country) ? country : undefined].filter(Boolean);
  return parts.length ? parts.join(", ").slice(0, 100) : undefined;
}

const decode = (value: string | undefined) => {
  try {
    return value ? decodeURIComponent(value) : undefined; // Vercel URL-encodes city names ("Quezon%20City")
  } catch {
    return undefined;
  }
};

// Letters (any language), spaces, dots, apostrophes and dashes only; at most 60 characters.
const clean = (value: string | undefined) => (value && /^[\p{L}\p{M} .'-]{1,60}$/u.test(value) ? value.trim() : undefined);
