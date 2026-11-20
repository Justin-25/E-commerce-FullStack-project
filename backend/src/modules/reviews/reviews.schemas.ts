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
