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

// --- Payouts & refunds (Finance, milestone 7b) ---

export const PAYOUT_TABS = ["in_progress", "failed", "paid"] as const;
export type PayoutTab = (typeof PAYOUT_TABS)[number];
export const REFUND_TABS = ["needs_person", "retrying", "sent"] as const;
export type RefundTab = (typeof REFUND_TABS)[number];

/** Payouts: in progress (oldest first, the ones to transfer), failed, paid. */
export const payoutListSchema = z.object({
  tab: z.enum(PAYOUT_TABS, { error: "Unknown tab" }).default("in_progress"),
  /** The payout's reference (PO-2026-1123-K4Q2) or the store's name. */
  q: search,
  page
});
/** Refunds: needing a person (oldest first), retrying, sent. */
export const refundListSchema = z.object({
  tab: z.enum(REFUND_TABS, { error: "Unknown tab" }).default("needs_person"),
  /** The order number (VD-21458) or the buyer's email. */
  q: search,
  page
});

export const payoutIdSchema = z.object({ payoutId: z.uuid({ error: "Payout not found" }) });
export const refundIdSchema = z.object({ refundId: z.uuid({ error: "Refund not found" }) });

/** A bank or GCash reference number as printed on the receipt: letters, digits, spaces and - / . # */
const transferReference = z
  .string({ error: "Enter the transfer's reference number" })
  .trim()
  .min(4, { error: "Enter the transfer's reference number (4 characters or more)" })
  .max(100, { error: "Use 100 characters or fewer" })
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ./#-]*$/, { error: "Use letters, numbers, spaces and - / . # only" });

/** "Mark paid": the transfer's reference, shown to the seller. */
export const markPaidSchema = z.strictObject({ transferReference });
/** "Mark failed": why (the seller reads it). */
export const markFailedSchema = z.strictObject({
  reason: z.string({ error: "Say why the transfer failed" }).trim().min(10, { error: "Say why the transfer failed (10 characters or more)" }).max(255, { error: "Use 255 characters or fewer" })
});
/** "Mark as refunded": a refund made in PayMongo's dashboard (its id, checked with PayMongo), or another transfer. */
export const markRefundedSchema = z.discriminatedUnion(
  "via",
  [
    z.strictObject({
      via: z.literal("PAYMONGO_DASHBOARD"),
      providerRefundId: z.string({ error: "Enter PayMongo's refund id" }).trim().regex(/^ref_[A-Za-z0-9_]{6,60}$/, { error: "PayMongo refund ids look like ref_ followed by letters and numbers" })
    }),
    z.strictObject({
      via: z.literal("OTHER_TRANSFER"),
      reference: transferReference,
      note: z
        .string()
        .trim()
        .max(255, { error: "Use 255 characters or fewer" })
        .optional()
        .transform((v) => v || null)
    })
  ],
  { error: "Choose how the refund was sent" }
);

// --- Users (Support, milestone 7c) ---

export const USER_TABS = ["all", "customers", "sellers", "admins", "locked_suspended"] as const;
export type UserTab = (typeof USER_TABS)[number];
/** Export CSV: at most this many accounts per file. */
export const USER_EXPORT_LIMIT = 5000;

/** Users: newest first; search by name or email. */
export const userListSchema = z.object({ tab: z.enum(USER_TABS, { error: "Unknown tab" }).default("all"), q: search, page });
export const userExportSchema = z.strictObject({ tab: z.enum(USER_TABS, { error: "Unknown tab" }).default("all"), q: search });
export const userIdSchema = z.object({ userId: z.uuid({ error: "User not found" }) });
/** "Suspend account": the reason is emailed to the person. */
export const suspendUserSchema = z.strictObject({
  reason: z.string({ error: "Say why (the person is told)" }).trim().min(10, { error: "Say why (10 characters or more; the person is told)" }).max(500, { error: "Use 500 characters or fewer" })
});
/** "Reset two-step verification": how Support checked who the person is. */
export const twoFactorResetRequestSchema = z.strictObject({
  identityCheck: z
    .string({ error: "Write how you checked who they are" })
    .trim()
    .min(10, { error: "Write how you checked who they are (10 characters or more)" })
    .max(500, { error: "Use 500 characters or fewer" })
});

export type UserListQuery = z.infer<typeof userListSchema>;
export type PayoutListQuery = z.infer<typeof payoutListSchema>;
export type RefundListQuery = z.infer<typeof refundListSchema>;
