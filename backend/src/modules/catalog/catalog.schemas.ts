import { z } from "zod";

// Allow-lists: every filter and sort is checked here, so nothing unexpected reaches the database.

const slug = z.string().regex(/^[a-z0-9-]{1,80}$/, { error: "Unknown value" });
const slugList = (max: number) => z.array(slug).max(max, { error: `Choose at most ${max}` }).default([]);
const centavos = z.coerce.number().int().min(0).max(100_000_000);

export const SORTS = ["featured", "best_selling", "newest", "price_asc", "price_desc", "top_rated"] as const;
export const PAGE_SIZES = [12, 24, 48] as const;
/** Deep pages are refused: nobody browses page 51, but bots would make the database work for it. */
export const MAX_PAGE = 50;

export const searchQuerySchema = z
  .object({
    q: z.string().trim().max(100, { error: "Use 100 characters or fewer" }).optional(),
    category: slugList(10),
    store: slugList(20),
    minPrice: centavos.optional(),
    maxPrice: centavos.optional(),
    rating: z.coerce.number().int().min(1).max(4).optional(), // "4★ & up"
    freeDelivery: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
    sort: z.enum(SORTS).default("featured"),
    page: z.coerce.number().int().min(1).max(MAX_PAGE, { error: `Only the first ${MAX_PAGE} pages are available` }).default(1),
    pageSize: z.coerce
      .number()
      .refine((n): n is (typeof PAGE_SIZES)[number] => (PAGE_SIZES as readonly number[]).includes(n), { error: "Use 12, 24 or 48" })
      .default(24)
  })
  .refine((v) => v.minPrice === undefined || v.maxPrice === undefined || v.minPrice <= v.maxPrice, {
    error: "The minimum price can't be above the maximum",
    path: ["minPrice"]
  });

export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const productIdSchema = z.object({ id: z.uuid({ error: "Product not found" }) });
