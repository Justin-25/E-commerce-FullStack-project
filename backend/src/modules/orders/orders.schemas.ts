import { z } from "zod";

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

export type SummaryInput = z.infer<typeof summarySchema>;
export type PlaceOrderInput = z.infer<typeof placeOrderSchema>;
