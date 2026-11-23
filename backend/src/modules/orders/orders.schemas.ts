import { z } from "zod";
import { MAX_PAGE } from "../catalog/catalog.schemas.js";

export const PAYMENT_METHODS = ["GCASH", "MAYA", "CARD", "COD"] as const;
export type PaymentMethodChoice = (typeof PAYMENT_METHODS)[number];

/** Cash on delivery: at most ₱5,000 per order (as designed)... */
export const COD_MAX_TOTAL_CENTAVOS = 500_000;
/** ...and at most 2 not-yet-delivered COD orders per shopper, so fake orders can't tie up sellers' stock. */
export const COD_MAX_OPEN_ORDERS = 2;
/** Online payments must finish within this, or the order is cancelled and its stock returned. */
export const PAYMENT_WINDOW_MINUTES = 15;

const storeSlug = z.string().regex(/^[a-z0-9-]{1,80}$/, { error: "Unknown store" });
/** Per store: Standard (free from ₱999, else ₱49) or Express (₱129). Stores left out get Standard. */
const deliveryChoices = z
  .record(storeSlug, z.enum(["STANDARD", "EXPRESS"], { error: "Choose Standard or Express" }))
  .refine((v) => Object.keys(v).length <= 50, { error: "Too many stores" })
  .default({});

/** The checkout page as the shopper changes choices (nothing is saved or reserved). */
export const summarySchema = z.strictObject({
  addressId: z.uuid({ error: "Choose an address" }).optional(),
  delivery: deliveryChoices,
  paymentMethod: z.enum(PAYMENT_METHODS, { error: "Choose a payment method" }).optional()
});

/** "Place order". expectedTotalCentavos = the total the shopper saw; if it changed, nothing is ordered. */
export const placeOrderSchema = z.strictObject({
  addressId: z.uuid({ error: "Choose an address" }),
  delivery: deliveryChoices,
  paymentMethod: z.enum(PAYMENT_METHODS, { error: "Choose a payment method" }),
  expectedTotalCentavos: z.int({ error: "Missing the total you saw" }).min(0)
});

/** The browser makes one key per checkout and sends it with every "Place order" attempt. */
export const idempotencyKeySchema = z
  .string({ error: "Missing the Idempotency-Key header" })
  .regex(/^[A-Za-z0-9_-]{8,64}$/, { error: "The Idempotency-Key header must be 8–64 letters, digits, - or _" });

export const retryPaymentSchema = z.strictObject({ paymentMethod: z.enum(PAYMENT_METHODS, { error: "Choose a payment method" }) });
export const orderIdSchema = z.object({ id: z.uuid({ error: "Order not found" }) });
export const packageIdSchema = z.object({ id: z.uuid({ error: "Order not found" }), packageId: z.uuid({ error: "Package not found" }) });

/** "Your orders" tabs: an order is in a tab when at least one of its packages is. */
export const ORDER_TABS = ["all", "to_ship", "on_the_way", "delivered"] as const;
export const ORDERS_PAGE_SIZE = 10;

export const orderListSchema = z.object({
  tab: z.enum(ORDER_TABS, { error: "Unknown tab" }).default("all"),
  /** "Search by order number or product": "VD-21458", "21458" or words from a product name. */
  q: z
    .string()
    .trim()
    .max(100, { error: "Search for at most 100 characters" })
    .optional()
    .transform((v) => v || undefined),
  page: z.coerce.number().int().min(1).max(MAX_PAGE, { error: `Only the first ${MAX_PAGE} pages are available` }).default(1)
});

export type SummaryInput = z.infer<typeof summarySchema>;
export type PlaceOrderInput = z.infer<typeof placeOrderSchema>;
export type OrderListQuery = z.infer<typeof orderListSchema>;
