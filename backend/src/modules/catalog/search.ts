import { Prisma } from "../../generated/prisma/client.js";
import { DELIVERY } from "../../lib/delivery.js";
import { EFFECTIVE_COMPARE_AT_SQL, EFFECTIVE_PRICE_SQL } from "./pricing.js";
import type { SearchQuery } from "./catalog.schemas.js";

/**
 * Builds the product-search SQL. Everything a visitor types goes in as a query
 * PARAMETER (Prisma.sql), never as SQL text, so it can't inject anything. The
 * only raw SQL pieces are the fixed sort orders below (an allow-list).
 */

/**
 * Typo tolerance (used only when the words themselves match nothing): measured on
 * the demo titles, typos like "hedphones", "sunglases", "speker" score 0.50–0.80
 * against the right title and at most 0.31 against wrong ones.
 */
export const WORD_SIMILARITY = 0.45;

/**
 * "words": full-text search (precise: stemming, "exact phrases", -excluded words).
 * "similar": trigram similarity on the title, the typo fallback when "words" finds nothing.
 */
export type MatchMode = "words" | "similar";

/**
 * Every visible product, with its cheapest active variant ("from ₱…"). A
 * product is visible if it's ACTIVE, its store is APPROVED and at least one
 * variant is on sale (the inner LATERAL join drops products with none).
 */
const FROM = Prisma.sql`
  FROM products p
  JOIN stores s ON s.id = p."storeId" AND s.status = 'APPROVED'
  JOIN LATERAL (
    SELECT ${EFFECTIVE_PRICE_SQL} AS price,
           ${EFFECTIVE_COMPARE_AT_SQL} AS compare_at,
           CASE WHEN v."saleEndsAt" IS NOT NULL AND v."saleEndsAt" <= now() THEN NULL ELSE v."saleEndsAt" END AS sale_ends_at
    FROM product_variants v
    WHERE v."productId" = p.id AND v."isActive"
    ORDER BY 1 ASC, v."sortOrder" ASC
    LIMIT 1
  ) cheapest ON true`;

/**
 * "Top rated" ranks by a WEIGHTED rating: every product starts with 5 imaginary 4★ reviews,
 * so three 5★ reviews can't outrank a 4.8 from hundreds (a Bayesian average, the usual fix).
 * The "4★ & up" filter still uses the plain average shown on the card.
 */
export const TOP_RATED_PRIOR = { stars: 4, reviews: 5 } as const;

/** The public sorts, plus "ending_soon" used inside the API (Home's "Today's deals"). */
export type ListSort = SearchQuery["sort"] | "ending_soon";

const SORT_SQL: Record<ListSort, (hasText: boolean) => Prisma.Sql> = {
  featured: (hasText) =>
    hasText ? Prisma.raw(`rank DESC, p."soldCount" DESC`) : Prisma.raw(`p."soldCount" DESC, p."ratingAvg" DESC, p."publishedAt" DESC NULLS LAST`),
  best_selling: () => Prisma.raw(`p."soldCount" DESC`),
  newest: () => Prisma.raw(`p."publishedAt" DESC NULLS LAST`),
  price_asc: () => Prisma.raw(`cheapest.price ASC`),
  price_desc: () => Prisma.raw(`cheapest.price DESC`),
  top_rated: () =>
    Prisma.raw(
      `(p."ratingAvg" * p."ratingCount" + ${TOP_RATED_PRIOR.stars * TOP_RATED_PRIOR.reviews}) / (p."ratingCount" + ${TOP_RATED_PRIOR.reviews}) DESC, p."ratingCount" DESC`
    ),
  ending_soon: () => Prisma.raw(`cheapest.sale_ends_at ASC NULLS LAST, p."soldCount" DESC`)
};

/** The filters that facets are counted without (disjunctive faceting). */
type FilterKey = "category" | "store" | "price" | "rating" | "delivery" | "deal";

export interface SearchFilters {
  text?: string | undefined;
  /** Already expanded to include sub-categories. undefined = no category filter. */
  categoryIds?: string[] | undefined;
  storeSlugs: string[];
  minPrice?: number | undefined;
  maxPrice?: number | undefined;
  rating?: number | undefined;
  freeDelivery: boolean;
  /** Only products on a deal (a crossed-out price that hasn't ended), like the cards' "Deal" badge. */
  deal?: boolean | undefined;
  /** Only deals with a running countdown ("Ends in 08h 42m"). */
  countdown?: boolean | undefined;
  /** Only these products (Recently viewed, the wishlist); invisible ones are still left out. */
  productIds?: string[] | undefined;
  /** Never these products ("Recommended for you" leaves out what's already in the cart). */
  excludeProductIds?: string[] | undefined;
  /** Only products with at least one unit on sale (recommendations shouldn't suggest sold-out items). */
  inStock?: boolean | undefined;
}

export function buildSearch(f: SearchFilters, mode: MatchMode = "words") {
  const text = f.text?.trim() || undefined;
  const tsQuery = Prisma.sql`websearch_to_tsquery('english', ${text ?? ""})`;
  let rank = Prisma.sql`0`;
  const base: Prisma.Sql[] = [Prisma.sql`p.status = 'ACTIVE'`];
  if (f.productIds) base.push(Prisma.sql`p.id = ANY(${f.productIds}::uuid[])`);
  if (f.excludeProductIds?.length) base.push(Prisma.sql`NOT (p.id = ANY(${f.excludeProductIds}::uuid[]))`);
  if (f.inStock) base.push(Prisma.sql`EXISTS (SELECT 1 FROM product_variants vs WHERE vs."productId" = p.id AND vs."isActive" AND vs.stock > 0)`);
  if (f.countdown) base.push(Prisma.sql`cheapest.sale_ends_at IS NOT NULL`);
  if (text && mode === "words") {
    base.push(Prisma.sql`p."searchVector" @@ ${tsQuery}`);
    rank = Prisma.sql`ts_rank(p."searchVector", ${tsQuery})`;
  } else if (text) {
    base.push(Prisma.sql`word_similarity(${text}, p.title) >= ${WORD_SIMILARITY}`);
    rank = Prisma.sql`word_similarity(${text}, p.title)`;
  }

  const filters: Record<FilterKey, Prisma.Sql | null> = {
    category: f.categoryIds ? Prisma.sql`p."categoryId" = ANY(${f.categoryIds}::uuid[])` : null,
    store: f.storeSlugs.length ? Prisma.sql`s.slug = ANY(${f.storeSlugs}::text[])` : null,
    price:
      f.minPrice !== undefined || f.maxPrice !== undefined
        ? Prisma.sql`cheapest.price BETWEEN ${f.minPrice ?? 0} AND ${f.maxPrice ?? 2_147_483_647}`
        : null,
    rating: f.rating !== undefined ? Prisma.sql`p."ratingAvg" >= ${f.rating}` : null,
    delivery: f.freeDelivery ? Prisma.sql`cheapest.price >= ${DELIVERY.freeThresholdCentavos}` : null,
    deal: f.deal ? Prisma.sql`cheapest.compare_at IS NOT NULL` : null
  };

  /** WHERE with every filter, or every filter except one (for that filter's own facet counts). */
  const where = (except?: FilterKey) => {
    const parts = [...base, ...(Object.entries(filters) as [FilterKey, Prisma.Sql | null][]).filter(([k, sql]) => sql && k !== except).map(([, sql]) => sql as Prisma.Sql)];
    return Prisma.sql`WHERE ${Prisma.join(parts, " AND ")}`;
  };

  return {
    count: Prisma.sql`SELECT count(*)::int AS total, count(DISTINCT p."storeId")::int AS sellers ${FROM} ${where()}`,

    page: (sort: ListSort, limit: number, offset: number) => Prisma.sql`
      SELECT p.id, p.slug, p.title, p."ratingAvg"::float AS "ratingAvg", p."ratingCount", p."soldCount", p."publishedAt",
             s.name AS "storeName", s.slug AS "storeSlug",
             cheapest.price, cheapest.compare_at AS "compareAt", cheapest.sale_ends_at AS "saleEndsAt",
             (SELECT coalesce(sum(v2.stock), 0)::int FROM product_variants v2 WHERE v2."productId" = p.id AND v2."isActive") AS "stockOnSale",
             ${rank} AS rank
      ${FROM} ${where()}
      ORDER BY ${SORT_SQL[sort](Boolean(text))}, p.id ASC
      LIMIT ${limit} OFFSET ${offset}`,

    categoryFacet: Prisma.sql`SELECT p."categoryId" AS id, count(*)::int AS n ${FROM} ${where("category")} GROUP BY p."categoryId"`,

    storeFacet: Prisma.sql`
      SELECT s.slug, s.name, count(*)::int AS n ${FROM} ${where("store")}
      GROUP BY s.slug, s.name ORDER BY n DESC, s.name ASC LIMIT 10`,

    storeFacetTotal: Prisma.sql`SELECT count(DISTINCT p."storeId")::int AS n ${FROM} ${where("store")}`,

    priceFacet: Prisma.sql`SELECT min(cheapest.price)::int AS min, max(cheapest.price)::int AS max ${FROM} ${where("price")}`
  };
}

export interface SearchRow {
  id: string;
  slug: string;
  title: string;
  ratingAvg: number;
  ratingCount: number;
  soldCount: number;
  publishedAt: Date | null;
  storeName: string;
  storeSlug: string;
  price: number;
  compareAt: number | null;
  saleEndsAt: Date | null;
  /** Units left across the variants on sale (only shown when low: "Only 3 left"). */
  stockOnSale: number;
}

/** Visible-product counts per category, for the category list (same visibility rules as search). */
export const VISIBLE_COUNTS_BY_CATEGORY = Prisma.sql`SELECT p."categoryId" AS id, count(*)::int AS n ${FROM} WHERE p.status = 'ACTIVE' GROUP BY p."categoryId"`;
