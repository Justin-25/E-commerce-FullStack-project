import { z } from "zod";

/** Distinct items in one cart. */
export const CART_MAX_LINES = 50;
/** Of one item (also a CHECK rule in the database). */
export const CART_MAX_QUANTITY = 99;

const quantity = z.coerce
  .number({ error: "Enter a quantity" })
  .int({ error: "Enter a whole number" })
  .min(1, { error: "Enter at least 1" })
  .max(CART_MAX_QUANTITY, { error: `You can buy up to ${CART_MAX_QUANTITY} of one item` });

export const variantIdSchema = z.object({ variantId: z.uuid({ error: "This item isn't available" }) });

/** "Add to cart" (adds to what's already there). */
export const addItemSchema = z.strictObject({ variantId: z.uuid({ error: "This item isn't available" }), quantity: quantity.default(1) });

/** The quantity box on a cart line (sets it). */
export const setQuantitySchema = z.strictObject({ quantity });

/** A guest's browser cart, merged at sign-in. */
export const mergeSchema = z.strictObject({
  items: z.array(z.strictObject({ variantId: z.uuid({ error: "Unknown item" }), quantity })).max(CART_MAX_LINES, { error: `At most ${CART_MAX_LINES} items` })
});

/** Guest cart page: `?items=<variantId>:<qty>,<variantId>:<qty>` (what the browser saved). */
export const previewSchema = z.object({
  items: z
    .string({ error: "List the cart items" })
    .transform((v) => v.split(",").map((part) => part.trim()).filter(Boolean))
    .pipe(z.array(z.string()).min(1, { error: "List at least one item" }).max(CART_MAX_LINES, { error: `At most ${CART_MAX_LINES} items` }))
    // "id:qty" pairs; the quantity is checked (and turned into a number) by the next step.
    .transform((parts) => parts.map((part): { variantId: string; quantity: unknown } => ({ variantId: part.split(":")[0] ?? "", quantity: part.split(":")[1] ?? "1" })))
    .pipe(z.array(z.object({ variantId: z.uuid({ error: "Unknown item" }), quantity })))
});

/** "Recommended for you": a guest sends the same `items` list as the preview; a signed-in cart is read from the account. */
export const recommendationsQuerySchema = z.object({ items: previewSchema.shape.items.optional() });

export type CartItemInput = { variantId: string; quantity: number };
