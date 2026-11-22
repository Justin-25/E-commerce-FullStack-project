import type { Request } from "express";
import { ipKeyGenerator } from "express-rate-limit";
import type { Config } from "../../config/env.js";
import type { Prisma, SecurityEventType } from "../../generated/prisma/client.js";
import { locationFrom } from "../../lib/location.js";

/** Who is making the request, as far as security records go. */
export interface ClientInfo {
  ip: string;
  /** The IP grouped for counting (IPv6 by /56), so one person can't dodge limits by rotating addresses. */
  ipKey: string;
  userAgent?: string | undefined;
  /** "Manila, PH", from the hosting provider's location headers (none on your PC). */
  location?: string | undefined;
}

/** The ClientInfo of a request (behind a proxy, `req.ip` is the real visitor once `trust proxy` is set). */
export function clientInfoFrom(req: Request, geoHeaders: Config["GEO_HEADERS"]): ClientInfo {
  const ip = req.ip ?? "unknown";
  return { ip, ipKey: ipKeyGenerator(ip, 56), userAgent: req.get("user-agent"), location: locationFrom(req, geoHeaders) };
}

/** One row in "Recent security activity". */
export function recordSecurityEvent(db: Prisma.TransactionClient, userId: string, type: SecurityEventType, client: ClientInfo) {
  return db.securityEvent.create({
    data: {
      userId,
      type,
      ipAddress: client.ip.slice(0, 45),
      userAgent: client.userAgent?.slice(0, 512) ?? null,
      location: client.location?.slice(0, 100) ?? null
    }
  });
}
