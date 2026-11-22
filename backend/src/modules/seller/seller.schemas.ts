import { z } from "zod";
import { normalizePhone } from "../addresses/addresses.schemas.js";

/** Store names that would confuse buyers (or impersonate us), checked on the web address made from the name. */
export const RESERVED_STORE_SLUGS = ["admin", "administrator", "api", "help", "moderator", "official", "root", "seller", "sellers", "shop", "staff", "store", "stores", "support", "system", "www"];

/** "Hearth & Home" → "hearth-home". The web address of the store page, and what makes names unique. */
export function storeSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // "Café" → "Cafe"
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

/** Banks Vendora pays out to (BANK payouts must name one). */
export const BANKS = [
  "BDO Unibank",
  "BPI",
  "China Bank",
  "EastWest Bank",
  "GoTyme Bank",
  "Landbank",
  "Maya Bank",
  "Metrobank",
  "PNB",
  "PSBank",
  "RCBC",
  "Security Bank",
  "UnionBank"
] as const;

/** Verification documents a store can upload. A selfie check isn't designed, so it isn't offered. */
export const UPLOADABLE_DOCUMENTS = ["GOV_ID", "DTI_CERT", "SEC_CERT", "BIR_2303"] as const;
export const MAX_DOCUMENTS = 10;

/** What can be uploaded where (sizes from the design: documents 10 MB; images 5 MB). */
export const UPLOAD_RULES = {
  store_logo: { access: "public", allowedFormats: ["jpg", "png", "webp"], maxBytes: 5 * 1024 * 1024, folder: "store-logos" },
  store_document: { access: "private", allowedFormats: ["jpg", "png", "pdf"], maxBytes: 10 * 1024 * 1024, folder: "store-documents" }
} as const;
export type UploadPurpose = keyof typeof UPLOAD_RULES;
/** Upload permissions per account per hour (each one lets a single file in). */
export const UPLOAD_TICKETS_PER_HOUR = 30;

const text = (label: string, min: number, max: number) =>
  z
    .string({ error: `Enter the ${label}` })
    .trim()
    .min(min, { error: min > 1 ? `Use at least ${min} characters` : `Enter the ${label}` })
    .max(max, { error: `Use ${max} characters or fewer` });

/** Step 1: store details. The name becomes the store's web address, so it's unique and locked once submitted. */
export const storeDetailsSchema = z.strictObject({
  name: text("store name", 3, 40)
    .regex(/^[\p{L}\p{N}][\p{L}\p{N} &'.,-]*$/u, { error: "Use letters, numbers, spaces and & ' . , -" })
    .refine((v) => storeSlug(v).length >= 3, { error: "Use at least 3 letters or numbers" }),
  category: z.string({ error: "Choose what your store sells" }).regex(/^[a-z0-9-]{1,80}$/, { error: "Choose what your store sells" }),
  description: z
    .string()
    .trim()
    .max(1000, { error: "Use 1,000 characters or fewer" })
    .transform((v) => v || null)
    .nullable()
    .default(null),
  shipsFrom: text("city you ship from", 2, 100)
});

/** Logos, documents: the place the browser uploaded to (from the upload ticket). */
const publicIdSchema = z.string({ error: "Upload the file first" }).regex(/^[A-Za-z0-9_/-]{10,200}$/, { error: "Upload the file first" });
export const logoSchema = z.strictObject({ publicId: publicIdSchema });
export const documentSchema = z.strictObject({ type: z.enum(UPLOADABLE_DOCUMENTS, { error: "Choose what this document is" }), publicId: publicIdSchema });

/** "123-456-789-000": 9 digits, plus a 3- or 5-digit branch code. Stored as digits only, encrypted. */
const tin = z
  .string({ error: "Enter your TIN" })
  .transform((v) => v.replace(/[\s-]/g, ""))
  .refine((v) => /^(\d{9}|\d{12}|\d{14})$/.test(v), { error: "Enter your 9- to 14-digit TIN, like 123-456-789-000" });

/** Step 2: business verification. A TIN is required for everyone (payouts and BIR receipts need it). */
export const verificationSchema = z
  .strictObject({
    businessType: z.enum(["INDIVIDUAL", "REGISTERED_BUSINESS"], { error: "Choose individual seller or registered business" }),
    /** Individual: full name as on the ID. Business: the registered business name. */
    legalName: text("name", 2, 150),
    registrationNo: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9 -]{3,48}[A-Z0-9]$/, { error: "Enter the DTI or SEC registration number" })
      .nullable()
      .default(null),
    tin
  })
  .superRefine((v, ctx) => {
    if (v.businessType === "REGISTERED_BUSINESS" && !v.registrationNo) ctx.addIssue({ code: "custom", path: ["registrationNo"], message: "Enter the DTI or SEC registration number" });
    if (v.businessType === "INDIVIDUAL" && v.registrationNo) ctx.addIssue({ code: "custom", path: ["registrationNo"], message: "Individual sellers don't have a registration number" });
  });

const accountName = text("account name", 2, 100);

/** Step 3: where the money goes. GCash: the mobile number. Bank: one of the listed banks. */
export const payoutAccountSchema = z.discriminatedUnion(
  "method",
  [
    z.strictObject({
      method: z.literal("GCASH"),
      accountName,
      accountNumber: z
        .string({ error: "Enter your GCash number" })
        .transform((v, ctx) => {
          const phone = normalizePhone(v);
          if (!phone) {
            ctx.addIssue({ code: "custom", message: "Enter a mobile number like 0917 123 4567" });
            return z.NEVER;
          }
          return phone;
        })
    }),
    z.strictObject({
      method: z.literal("BANK"),
      bankName: z.enum(BANKS, { error: "Choose your bank" }),
      accountName,
      accountNumber: z
        .string({ error: "Enter the account number" })
        .transform((v) => v.replace(/[\s-]/g, ""))
        .refine((v) => /^\d{10,16}$/.test(v), { error: "Enter the 10- to 16-digit account number" })
    })
  ],
  { error: "Choose GCash or bank" }
);

export const uploadTicketSchema = z.strictObject({ purpose: z.enum(["store_logo", "store_document"], { error: "Unknown upload" }) });
export const documentIdSchema = z.object({ id: z.uuid({ error: "Document not found" }) });

export type StoreDetailsInput = z.infer<typeof storeDetailsSchema>;
export type VerificationInput = z.infer<typeof verificationSchema>;
export type PayoutAccountInput = z.infer<typeof payoutAccountSchema>;
export type DocumentInput = z.infer<typeof documentSchema>;
