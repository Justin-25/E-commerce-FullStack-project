import { AppError } from "../../lib/errors.js";
import type { KeyValueStore } from "../../lib/kv.js";
import type { Logger } from "../../lib/logger.js";
import { newPublicId, type MediaAccess, type MediaStorage, type StoredMedia, type UploadTicket } from "../../lib/media.js";
import { UPLOAD_RULES, UPLOAD_TICKETS_PER_HOUR, type UploadPurpose } from "./seller.schemas.js";

export const uploadsOff = () => new AppError(503, "SERVICE_UNAVAILABLE", "Uploads are unavailable right now. Please try again later.");
const badUpload = (path: string, message: string) => new AppError(400, "VALIDATION_ERROR", "Some fields are invalid", { fields: [{ path, message }] });

/**
 * Seller uploads (logos, documents, product photos), in one place. The browser uploads
 * straight to the storage service with a one-time ticket from us; afterwards, what it says
 * it uploaded is only a claim that `check` verifies.
 */
export class SellerUploads {
  constructor(private readonly deps: { kv: KeyValueStore; media: MediaStorage | null; logger?: Logger }) {}

  /** A one-time permission to upload one file, in this account's own folder (limited per hour). */
  async ticket(userId: string, purpose: UploadPurpose): Promise<UploadTicket> {
    const media = this.deps.media;
    if (!media) throw uploadsOff();
    const rule = UPLOAD_RULES[purpose];
    const limit = UPLOAD_TICKETS_PER_HOUR[rule.hourlyLimit];
    // The store allowance keeps its 6a key, so counts carry over.
    const key = rule.hourlyLimit === "store" ? `uploads:tickets:${userId}` : `uploads:${rule.hourlyLimit}-tickets:${userId}`;
    if ((await this.deps.kv.increment(key, 60 * 60)) > limit) {
      throw new AppError(429, "RATE_LIMITED", "Too many uploads. Please try again in an hour.");
    }
    return media.ticket({ publicId: newPublicId(prefixFor(purpose, userId)), access: rule.access, allowedFormats: [...rule.allowedFormats], maxBytes: rule.maxBytes });
  }

  /**
   * The place must be one OUR server handed this account, and the file there must exist with
   * an allowed type and size. A file that breaks the rules is deleted. `path` names the form
   * field for the error ("publicId", "photos.2.publicId").
   */
  async check(userId: string, purpose: UploadPurpose, publicId: string, path = "publicId"): Promise<StoredMedia> {
    const media = this.deps.media;
    if (!media) throw uploadsOff();
    const rule = UPLOAD_RULES[purpose];
    const prefix = prefixFor(purpose, userId);
    if (!publicId.startsWith(`${prefix}/`) || publicId.split("/").length !== prefix.split("/").length + 1) {
      throw badUpload(path, "This upload doesn't belong to your account. Please upload the file again.");
    }
    const found = await media.find(publicId, rule.access);
    if (!found) throw badUpload(path, "We couldn't find that upload. Please upload the file again.");
    const formats: readonly string[] = rule.allowedFormats;
    if (!formats.includes(found.format) || found.bytes > rule.maxBytes) {
      await this.discard(publicId, rule.access);
      throw badUpload(path, `Use ${rule.allowedFormats.map((f) => f.toUpperCase()).join(", ")} up to ${rule.maxBytes / 1024 / 1024} MB.`);
    }
    return found;
  }

  /** Deletes a file nobody uses any more. Best effort: a leftover file is unreferenced, and storage being down mustn't fail the change. */
  async discard(publicId: string, access: MediaAccess): Promise<void> {
    await this.deps.media?.remove(publicId, access).catch((err: unknown) => this.deps.logger?.warn({ err, publicId }, "couldn't delete an unused upload"));
  }
}

/** "vendora/store-logos/<user id>": one folder per purpose and account. */
const prefixFor = (purpose: UploadPurpose, userId: string) => `vendora/${UPLOAD_RULES[purpose].folder}/${userId}`;
