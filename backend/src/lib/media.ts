import { createHash, randomBytes } from "node:crypto";
import { DependencyUnavailableError } from "./errors.js";
import type { Logger } from "./logger.js";

/**
 * File storage for store logos, product photos and verification documents, behind one small
 * interface so the shop's code never talks HTTP and tests can use a fake (tests/support/fakeMedia.ts).
 *
 * The browser uploads the file STRAIGHT to the storage service with a one-time permission
 * ("ticket") from our server, so files never pass through our API. Our server then checks
 * what actually arrived (type, size, owner) before using it.
 */

/** Public: logos and product photos. Private: ID and business documents (admins only, through expiring links). */
export type MediaAccess = "public" | "private";

export interface UploadTicket {
  /** POST the file here as multipart/form-data: every entry of `fields`, then `file`. */
  url: string;
  fields: Record<string, string>;
  /** Where the file will be stored, chosen by our server. Send it back after uploading. */
  publicId: string;
  allowedFormats: string[];
  maxBytes: number;
  expiresAt: string;
}

export interface StoredMedia {
  publicId: string;
  access: MediaAccess;
  format: string;
  bytes: number;
  /** Public files only: the https link to show. Private files have none. */
  url: string | null;
}

export interface MediaStorage {
  /** A permission to upload ONE file to exactly this place, in these formats, valid for an hour. */
  ticket(input: { publicId: string; access: MediaAccess; allowedFormats: string[]; maxBytes: number }): UploadTicket;
  /** What was really uploaded there, or null if nothing was. */
  find(publicId: string, access: MediaAccess): Promise<StoredMedia | null>;
  remove(publicId: string, access: MediaAccess): Promise<void>;
}

/** Storage names are made by our server, never by the browser: a prefix per purpose and owner + a random part. */
export const newPublicId = (prefix: string) => `${prefix}/${randomBytes(12).toString("base64url")}`;

const TICKET_SECONDS = 60 * 60; // Cloudinary accepts a signature for one hour after its timestamp
const TIMEOUT_MS = 10_000;

/** "cloudinary://<api key>:<api secret>@<cloud name>": the dashboard's "API environment variable". */
export function parseCloudinaryUrl(url: string): { apiKey: string; apiSecret: string; cloudName: string } {
  const m = /^cloudinary:\/\/(\d+):([^@]+)@([a-z0-9_-]+)$/.exec(url);
  if (!m?.[1] || !m[2] || !m[3]) throw new Error("CLOUDINARY_URL is not in the form cloudinary://<key>:<secret>@<cloud name>");
  return { apiKey: m[1], apiSecret: m[2], cloudName: m[3] };
}

/**
 * Cloudinary's request signature (docs: "Authentication signatures"): every parameter sent except
 * file, cloud_name, resource_type and api_key, as name=value pairs sorted by name and joined with
 * "&", followed directly by the API secret, hashed with SHA-1 (hex).
 */
export function cloudinarySignature(params: Record<string, string>, apiSecret: string): string {
  const signed = Object.keys(params)
    .filter((k) => !["file", "cloud_name", "resource_type", "api_key"].includes(k))
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return createHash("sha1").update(signed + apiSecret).digest("hex");
}

/** Our access levels → Cloudinary delivery types. "authenticated": the file and every version of it need a signed link. */
const TYPE: Record<MediaAccess, string> = { public: "upload", private: "authenticated" };

/** Cloudinary, read from the docs on 2026-11-22. Images and PDFs are both "image" resources. */
export class CloudinaryStorage implements MediaStorage {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly cloudName: string;
  private readonly auth: string;

  constructor(
    url: string,
    private readonly logger?: Logger,
    private readonly now: () => Date = () => new Date()
  ) {
    ({ apiKey: this.apiKey, apiSecret: this.apiSecret, cloudName: this.cloudName } = parseCloudinaryUrl(url));
    this.auth = `Basic ${Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString("base64")}`;
  }

  ticket({ publicId, access, allowedFormats, maxBytes }: { publicId: string; access: MediaAccess; allowedFormats: string[]; maxBytes: number }): UploadTicket {
    const timestamp = Math.floor(this.now().getTime() / 1000);
    const params = { allowed_formats: allowedFormats.join(","), public_id: publicId, timestamp: String(timestamp), type: TYPE[access] };
    return {
      url: `https://api.cloudinary.com/v1_1/${this.cloudName}/image/upload`,
      fields: { ...params, api_key: this.apiKey, signature: cloudinarySignature(params, this.apiSecret) },
      publicId,
      allowedFormats,
      maxBytes,
      expiresAt: new Date((timestamp + TICKET_SECONDS) * 1000).toISOString()
    };
  }

  async find(publicId: string, access: MediaAccess): Promise<StoredMedia | null> {
    const path = publicId.split("/").map(encodeURIComponent).join("/");
    const res = await this.call(`https://api.cloudinary.com/v1_1/${this.cloudName}/resources/image/${TYPE[access]}/${path}`, { headers: { authorization: this.auth } });
    if (res.status === 404) return null;
    const body = (await res.json().catch(() => null)) as { public_id?: unknown; format?: unknown; bytes?: unknown; secure_url?: unknown } | null;
    if (!res.ok || typeof body?.public_id !== "string" || typeof body.format !== "string" || typeof body.bytes !== "number") {
      throw new Error(`Cloudinary: unexpected answer (${res.status}) when checking an upload`);
    }
    return { publicId: body.public_id, access, format: body.format.toLowerCase(), bytes: body.bytes, url: access === "public" && typeof body.secure_url === "string" ? body.secure_url : null };
  }

  async remove(publicId: string, access: MediaAccess): Promise<void> {
    const params = { invalidate: "true", public_id: publicId, timestamp: String(Math.floor(this.now().getTime() / 1000)), type: TYPE[access] };
    const form = new URLSearchParams({ ...params, api_key: this.apiKey, signature: cloudinarySignature(params, this.apiSecret) });
    const res = await this.call(`https://api.cloudinary.com/v1_1/${this.cloudName}/image/destroy`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`Cloudinary: couldn't delete a file (${res.status})`);
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (cause) {
      throw new DependencyUnavailableError("cloudinary", cause);
    }
    if (res.status >= 500) throw new DependencyUnavailableError("cloudinary", new Error(`Cloudinary ${res.status}`));
    if (res.status === 420 || res.status === 429) {
      this.logger?.warn({ status: res.status }, "Cloudinary rate limit reached (Admin API: 500 requests an hour on the free plan)");
      throw new DependencyUnavailableError("cloudinary", new Error("rate limited"));
    }
    return res;
  }
}
