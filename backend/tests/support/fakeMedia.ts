import { DependencyUnavailableError } from "../../src/lib/errors.js";
import type { MediaAccess, MediaStorage, StoredMedia, UploadTicket } from "../../src/lib/media.js";

/**
 * A stand-in for Cloudinary with the behaviour the shop depends on: tickets for one place,
 * the browser's upload (refused outside the ticket's formats, like Cloudinary's
 * allowed_formats), checking what's there, deleting, and outages. Like the real service, a
 * ticket doesn't limit the SIZE: that's why our server checks every file after upload.
 */
export class FakeMedia implements MediaStorage {
  readonly tickets = new Map<string, { access: MediaAccess; allowedFormats: string[]; maxBytes: number }>();
  readonly files = new Map<string, StoredMedia>();
  readonly removed: string[] = [];
  down = false;

  ticket({ publicId, access, allowedFormats, maxBytes }: { publicId: string; access: MediaAccess; allowedFormats: string[]; maxBytes: number }): UploadTicket {
    this.tickets.set(publicId, { access, allowedFormats, maxBytes });
    return {
      url: "https://upload.example.test/image/upload",
      fields: { public_id: publicId, type: access === "public" ? "upload" : "authenticated", allowed_formats: allowedFormats.join(","), timestamp: "0", api_key: "1", signature: "fake" },
      publicId,
      allowedFormats,
      maxBytes,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString()
    };
  }

  /** The browser uploading a file with a ticket. */
  upload(publicId: string, { format = "jpg", bytes = 250_000 }: { format?: string; bytes?: number } = {}): StoredMedia {
    const ticket = this.tickets.get(publicId);
    if (!ticket) throw new Error(`no ticket for ${publicId}`);
    if (!ticket.allowedFormats.includes(format)) throw new Error(`the storage service refuses ${format}`);
    return this.put({ publicId, access: ticket.access, format, bytes, url: ticket.access === "public" ? `https://media.example.test/${publicId}.${format}` : null });
  }

  /** A file placed directly (e.g. someone else's), to test that the server checks who it belongs to. */
  put(media: StoredMedia): StoredMedia {
    this.files.set(`${media.access}:${media.publicId}`, media);
    return media;
  }

  async find(publicId: string, access: MediaAccess): Promise<StoredMedia | null> {
    if (this.down) throw new DependencyUnavailableError("cloudinary", new Error("fake outage"));
    return this.files.get(`${access}:${publicId}`) ?? null;
  }

  async remove(publicId: string, access: MediaAccess): Promise<void> {
    if (this.down) throw new DependencyUnavailableError("cloudinary", new Error("fake outage"));
    this.files.delete(`${access}:${publicId}`);
    this.removed.push(publicId);
  }
}
