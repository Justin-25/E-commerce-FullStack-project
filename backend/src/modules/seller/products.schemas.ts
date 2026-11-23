import { z } from "zod";
import { MAX_PAGE } from "../catalog/catalog.schemas.js";
import { publicIdSchema } from "./seller.schemas.js";

/** From the Add product design: "4 of 8" photos; the first is the cover. */
export const MAX_PHOTOS = 8;
export const MAX_VARIANTS = 30;
/** The Specifications tab on the product page (the database allows 30). */
export const MAX_SPECS = 30;
/** "9 left" in the products list, and "Alert me when a variant has fewer than 10 left". */
export const SELLER_LOW_STOCK = 10;
export const SELLER_PAGE_SIZE = 20;
export const MIN_PRICE_CENTAVOS = 100; // ₱1
export const MAX_PRICE_CENTAVOS = 100_000_000; // ₱1,000,000
export const MAX_STOCK = 100_000;
/** "Deal ends": in the future, at most this many days ahead. */
export const MAX_DEAL_DAYS = 90;
/** A published product needs a real description (drafts can be empty). */
export const MIN_DESCRIPTION = 20;
export const MAX_WEIGHT_GRAMS = 50_000; // 50 kg

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const LINE_BREAKS = /[\n\r\t]/;

/** One-line text: trimmed, within limits, no invisible control characters or line breaks. */
const text = (label: string, min: number, max: number) =>
  z
    .string({ error: `Enter the ${label}` })
    .trim()
    .min(min, { error: min > 1 ? `Use at least ${min} characters` : `Enter the ${label}` })
    .max(max, { error: `Use ${max} characters or fewer` })
    .refine((v) => !CONTROL_CHARS.test(v) && !LINE_BREAKS.test(v), { error: "Remove special characters" });

const price = (label: string) =>
  z
    .int({ error: `Enter the ${label}` })
    .min(MIN_PRICE_CENTAVOS, { error: "Use at least ₱1" })
    .max(MAX_PRICE_CENTAVOS, { error: "Use at most ₱1,000,000" });

const stock = z
  .int({ error: "Enter the stock" })
  .min(0, { error: "Stock can't be below 0" })
  .max(MAX_STOCK, { error: `Use at most ${MAX_STOCK.toLocaleString("en-PH")}` });

/**
 * A variant row ("Midnight Black · ₱7,499 · 42 · SC-AURA-PRO-BLK"). Existing variants send
 * their id and `stockWas`, the stock the form showed: the change is applied as a difference,
 * so units sold while the seller was editing aren't overwritten.
 */
export const variantInputSchema = z
  .strictObject({
    id: z.uuid({ error: "Unknown variant" }).optional(),
    name: text("variant name", 1, 100),
    /** Empty: we make one up (unique in the store). */
    sku: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9._-]{0,63}$/, { error: "Use letters, numbers, dots, dashes or underscores" })
      .nullable()
      .default(null),
    priceCentavos: price("price"),
    compareAtCentavos: price("compare-at price").nullable().default(null),
    stock,
    stockWas: stock.optional()
  })
  .superRefine((v, ctx) => {
    if (v.compareAtCentavos !== null && v.compareAtCentavos <= v.priceCentavos) {
      ctx.addIssue({ code: "custom", path: ["compareAtCentavos"], message: "Make the compare-at price higher than the price" });
    }
    if (v.id !== undefined && v.stockWas === undefined) ctx.addIssue({ code: "custom", path: ["stockWas"], message: "Missing the stock you started from. Reload and try again." });
  });

/** A photo: one already on the product (id) or a new upload (publicId from the upload ticket). */
const photoInputSchema = z
  .strictObject({
    id: z.uuid({ error: "Unknown photo" }).optional(),
    publicId: publicIdSchema.optional(),
    /** Describes the photo for screen readers; the title is used when empty. */
    alt: text("photo description", 1, 200).nullable().default(null)
  })
  .refine((p) => (p.id === undefined) !== (p.publicId === undefined), { error: "Use either a photo already on the product or a new upload" });

const specSchema = z.strictObject({ label: text("label", 1, 40), value: text("value", 1, 200) });

/** Reports the second and later copies of the same value as errors on their own row. */
function noDuplicates(ctx: z.RefinementCtx, values: (string | undefined)[], path: (i: number) => (string | number)[], message: string) {
  const seen = new Set<string>();
  values.forEach((v, i) => {
    if (v === undefined) return;
    if (seen.has(v)) ctx.addIssue({ code: "custom", path: path(i), message });
    seen.add(v);
  });
}

/**
 * The Add / Edit product form. "Save draft" (intent draft) needs only a title and a category;
 * "Publish" (intent publish) checks everything a shopper will see. Edits send the `version`
 * the form was loaded with.
 */
export const productInputSchema = z
  .strictObject({
    intent: z.enum(["draft", "publish"], { error: "Choose Save draft or Publish" }),
    version: z.int({ error: "Reload the product and try again" }).min(1).optional(),
    title: text("product title", 3, 200),
    /** A sub-category's slug ("headphones" in Electronics › Headphones). */
    category: z.string({ error: "Choose a category" }).regex(/^[a-z0-9-]{1,80}$/, { error: "Choose a category" }),
    description: z
      .string({ error: "Enter a description" })
      .trim()
      .max(5000, { error: "Use 5,000 characters or fewer" })
      .refine((v) => !CONTROL_CHARS.test(v), { error: "Remove special characters" })
      .default(""),
    variantLabel: text("variant label", 1, 30).default("Color"),
    variants: z.array(variantInputSchema).max(MAX_VARIANTS, { error: `Use at most ${MAX_VARIANTS} variants` }).default([]),
    photos: z.array(photoInputSchema).max(MAX_PHOTOS, { error: `Add at most ${MAX_PHOTOS} photos` }).default([]),
    specs: z.array(specSchema).max(MAX_SPECS, { error: `Use at most ${MAX_SPECS} specifications` }).default([]),
    /** "Deal ends": the countdown; afterwards the variants sell at their compare-at price again. */
    dealEndsAt: z.iso
      .datetime({ offset: true, error: "Choose when the deal ends" })
      .transform((v) => new Date(v))
      .nullable()
      .default(null),
    /** "Package weight", for every variant. */
    weightGrams: z.int({ error: "Enter the weight in grams" }).min(1, { error: "Enter the weight in grams" }).max(MAX_WEIGHT_GRAMS, { error: "Use at most 50 kg" }).nullable().default(null),
    /** The "Active" toggle: off hides a published product from shoppers. */
    active: z.boolean({ error: "Choose on or off" }).default(true),
    expressAvailable: z.boolean({ error: "Choose on or off" }).default(true),
    lowStockAlert: z.boolean({ error: "Choose on or off" }).default(true)
  })
  .superRefine((p, ctx) => {
    noDuplicates(ctx, p.variants.map((v) => v.name.toLowerCase()), (i) => ["variants", i, "name"], "Give each variant a different name");
    noDuplicates(ctx, p.variants.map((v) => v.sku ?? undefined), (i) => ["variants", i, "sku"], "Give each variant a different SKU");
    noDuplicates(ctx, p.variants.map((v) => v.id), (i) => ["variants", i, "id"], "This variant is listed twice");
    noDuplicates(ctx, p.photos.map((ph) => ph.id ?? ph.publicId), (i) => ["photos", i], "This photo is listed twice");
    noDuplicates(ctx, p.specs.map((s) => s.label.toLowerCase()), (i) => ["specs", i, "label"], "Use each label once");
    if (p.dealEndsAt && !p.variants.some((v) => v.compareAtCentavos !== null)) {
      ctx.addIssue({ code: "custom", path: ["dealEndsAt"], message: "Add a compare-at price to run a deal" });
    }
    if (p.intent !== "publish") return;
    if (p.description.length < MIN_DESCRIPTION) ctx.addIssue({ code: "custom", path: ["description"], message: `Describe the product in at least ${MIN_DESCRIPTION} characters` });
    if (p.photos.length === 0) ctx.addIssue({ code: "custom", path: ["photos"], message: "Add at least one photo" });
    if (p.variants.length === 0) ctx.addIssue({ code: "custom", path: ["variants"], message: "Add at least one variant with a price and stock" });
  });

/** Products list tabs: they split the rows (All = Active + Drafts + Out of stock + hidden ones). */
export const SELLER_TABS = ["all", "active", "drafts", "out_of_stock"] as const;

export const sellerProductListSchema = z.object({
  tab: z.enum(SELLER_TABS, { error: "Unknown tab" }).default("all"),
  /** "Search by name or SKU". */
  q: z
    .string()
    .trim()
    .max(100, { error: "Search for at most 100 characters" })
    .optional()
    .transform((v) => v || undefined),
  /** Category slugs (?category=a&category=b, like search); a top-level one includes its sub-categories. */
  category: z.array(z.string().regex(/^[a-z0-9-]{1,80}$/, { error: "Unknown category" })).max(10, { error: "Choose at most 10 categories" }).default([]),
  page: z.coerce.number().int().min(1).max(MAX_PAGE, { error: `Only the first ${MAX_PAGE} pages are available` }).default(1)
});

export const productIdSchema = z.object({ id: z.uuid({ error: "Product not found" }) });

export type ProductInput = z.infer<typeof productInputSchema>;
export type SellerProductListQuery = z.infer<typeof sellerProductListSchema>;
