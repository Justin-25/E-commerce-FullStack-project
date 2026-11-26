import { z } from "zod";
import { MAX_PAGE } from "../catalog/catalog.schemas.js";

export const APPLICATION_TABS = ["pending", "changes_requested", "rejected", "approved"] as const;
export type ApplicationTab = (typeof APPLICATION_TABS)[number];
export const ADMIN_PAGE_SIZE = 20;
/** Private documents open through a link that works this long. */
export const DOCUMENT_LINK_SECONDS = 5 * 60;

const search = z
  .string()
  .trim()
  .max(100, { error: "Search for at most 100 characters" })
  .optional()
  .transform((v) => v || undefined);
const page = z.coerce.number().int().min(1).max(MAX_PAGE, { error: `Only the first ${MAX_PAGE} pages are available` }).default(1);

/** Seller approvals: the queue (oldest first) and the other tabs. */
export const applicationListSchema = z.object({
  tab: z.enum(APPLICATION_TABS, { error: "Unknown tab" }).default("pending"),
  /** Store name, web address or the owner's email. */
  q: search,
  page
});

export const storeIdSchema = z.object({ storeId: z.uuid({ error: "Store not found" }) });
export const documentParamsSchema = z.object({ storeId: z.uuid({ error: "Store not found" }), documentId: z.uuid({ error: "Document not found" }) });

const note = z.string({ error: "Write a note for the seller" }).trim().min(10, { error: "Tell the seller what to change (10 characters or more)" }).max(1000, { error: "Use 1,000 characters or fewer" });

/** "Approve seller": an optional note for the seller. */
export const approveSchema = z.strictObject({
  note: z
    .string()
    .trim()
    .max(1000, { error: "Use 1,000 characters or fewer" })
    .optional()
    .transform((v) => v || null)
});
/** "Ask for changes" and "Reject": the note is required (it's what the seller reads). */
export const reviewNoteSchema = z.strictObject({ note });

export type ApplicationListQuery = z.infer<typeof applicationListSchema>;
