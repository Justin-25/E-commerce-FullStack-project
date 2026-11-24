import { z } from "zod";
import { MAX_PAGE } from "../catalog/catalog.schemas.js";
import { SELLER_CANCEL_REASONS } from "../orders/cancelReasons.js";

/** "Select courier": the couriers sellers in the Philippines ship with. */
export const COURIERS = ["J&T Express", "LBC", "Ninja Van", "Flash Express", "2GO Express", "GoGo Xpress"] as const;
export type Courier = (typeof COURIERS)[number];

/** Seller Center → Orders tabs (Returns comes with returns, later). */
export const SELLER_ORDER_TABS = ["to_ship", "shipped", "delivered", "all"] as const;
export type SellerOrderTab = (typeof SELLER_ORDER_TABS)[number];
export const SELLER_ORDERS_PAGE_SIZE = 20;
/** Export CSV: at most this many orders per file (newest first). */
export const EXPORT_MAX_ROWS = 5000;
export const MAX_PACKAGE_GRAMS = 100_000;

const search = z
  .string()
  .trim()
  .max(100, { error: "Search for at most 100 characters" })
  .optional()
  .transform((v) => v || undefined);

export const sellerOrderListSchema = z.object({
  tab: z.enum(SELLER_ORDER_TABS, { error: "Unknown tab" }).default("to_ship"),
  /** "VD-21458", "21458" or words from a product name. */
  q: search,
  page: z.coerce.number().int().min(1).max(MAX_PAGE, { error: `Only the first ${MAX_PAGE} pages are available` }).default(1)
});

export const sellerOrderExportSchema = z.object({
  tab: z.enum(SELLER_ORDER_TABS, { error: "Unknown tab" }).default("all"),
  q: search
});

export const sellerOrderIdSchema = z.object({ id: z.uuid({ error: "Order not found" }) });

/**
 * "Mark as shipped" (and fixing a typo later, until it's delivered). The tracking number is kept
 * as letters and digits only, so "7720 1934-5512" and "772019345512" are the same number.
 */
export const shipmentSchema = z.strictObject({
  courier: z.enum(COURIERS, { error: "Choose a courier" }),
  trackingNumber: z
    .string({ error: "Enter the tracking number" })
    .max(60, { error: "Enter the tracking number from the courier's receipt" })
    .transform((v) => v.replace(/[\s-]/g, "").toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{6,30}$/, { error: "Enter the tracking number from the courier's receipt: 6–30 letters and digits" })),
  packageWeightGrams: z
    .int({ error: "Enter the weight in grams" })
    .min(1, { error: "Enter the weight in grams" })
    .max(MAX_PACKAGE_GRAMS, { error: "A package can weigh up to 100 kg" })
    .nullable()
    .default(null)
});

/** "Cancel order" (the Modal's reasons). */
export const sellerCancelSchema = z.strictObject({
  reason: z.enum(SELLER_CANCEL_REASONS, { error: "Choose a reason" })
});

export type SellerOrderListQuery = z.infer<typeof sellerOrderListSchema>;
export type SellerOrderExportQuery = z.infer<typeof sellerOrderExportSchema>;
export type ShipmentInput = z.infer<typeof shipmentSchema>;
export type SellerCancelInput = z.infer<typeof sellerCancelSchema>;
