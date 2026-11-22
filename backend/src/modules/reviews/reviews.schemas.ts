import { z } from "zod";
import { MAX_PAGE } from "../catalog/catalog.schemas.js";

export const REVIEW_SORTS = ["newest", "highest", "lowest"] as const;
export const REVIEWS_PAGE_SIZE = 10;

export const reviewQuerySchema = z.object({
  /** Clicking a bar in the "5 star 72%" breakdown shows only those reviews. */
  rating: z.coerce.number().int().min(1).max(5).optional(),
  sort: z.enum(REVIEW_SORTS).default("newest"),
  page: z.coerce.number().int().min(1).max(MAX_PAGE, { error: `Only the first ${MAX_PAGE} pages are available` }).default(1)
});

export type ReviewQuery = z.infer<typeof reviewQuerySchema>;

// --- writing a review (milestone 5c) ---

export const REVIEW_TITLE_MAX = 120;
export const REVIEW_BODY_MAX = 2000;
/** Control characters (except tab and line breaks in the text): PostgreSQL refuses NUL, and none of them belong in a review. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const stars = z
  .int({ error: "Choose 1 to 5 stars" })
  .min(1, { error: "Choose 1 to 5 stars" })
  .max(5, { error: "Choose 1 to 5 stars" });

/** Optional text: trimmed; empty means none (a star rating alone is a valid review). */
const reviewText = (max: number, what: string) =>
  z
    .string({ error: `${what} must be text` })
    .trim()
    .max(max, { error: `${what} can be up to ${max} characters` })
    .refine((v) => !CONTROL_CHARS.test(v), { error: `${what} contains characters that aren't allowed` })
    .transform((v) => v || null)
    .nullable()
    .optional();

/** "Write a review" for one item the shopper bought. */
export const writeReviewSchema = z.strictObject({
  orderItemId: z.uuid({ error: "Choose an item you bought" }),
  rating: stars,
  title: reviewText(REVIEW_TITLE_MAX, "The title"),
  body: reviewText(REVIEW_BODY_MAX, "The review")
});

/** Editing: only the fields sent change (an allow-list: nothing else can be changed). */
export const editReviewSchema = z
  .strictObject({ rating: stars.optional(), title: reviewText(REVIEW_TITLE_MAX, "The title"), body: reviewText(REVIEW_BODY_MAX, "The review") })
  .refine((v) => v.rating !== undefined || v.title !== undefined || v.body !== undefined, { error: "Change the stars, the title or the text" });

export const reviewIdSchema = z.object({ id: z.uuid({ error: "Review not found" }) });

export type WriteReviewInput = z.infer<typeof writeReviewSchema>;
export type EditReviewInput = z.infer<typeof editReviewSchema>;
