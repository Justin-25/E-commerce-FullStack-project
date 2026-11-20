import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import { visibleProduct } from "../catalog/visibility.js";
import { REVIEWS_PAGE_SIZE, type ReviewQuery } from "./reviews.schemas.js";

export interface RatingSummary {
  avg: number;
  count: number;
  /** 5★ down to 1★, for the "5 star ███ 72%" bars. */
  stars: { stars: number; count: number; percent: number }[];
}

export interface ReviewItem {
  id: string;
  rating: number;
  title: string | null;
  body: string | null;
  /** "Maria S.": first name and initial only, never the full name, email or id. */
  author: string;
  /** "Color: Sand": the variant that was bought. */
  variantName: string;
  /** Always true: the database only accepts a review linked to a purchased item. */
  verifiedPurchase: true;
  createdAt: string;
  /** Store reviews only: which product, and whether its page can still be opened. */
  product?: { id: string; title: string; available: boolean };
}

const ORDER: Record<ReviewQuery["sort"], Prisma.ReviewOrderByWithRelationInput[]> = {
  newest: [{ createdAt: "desc" }, { id: "desc" }],
  highest: [{ rating: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  lowest: [{ rating: "asc" }, { createdAt: "desc" }, { id: "desc" }]
};

/** Reading reviews: a product's Reviews tab and a store's Reviews tab. Public. */
export class ReviewService {
  constructor(private readonly deps: { prisma: PrismaClient }) {}

  /** A product's reviews. 404 when the product page itself would be. */
  async forProduct(productId: string, query: ReviewQuery) {
    const product = await this.deps.prisma.product.findFirst({ where: visibleProduct(productId), select: { id: true } });
    if (!product) throw new AppError(404, "NOT_FOUND", "This product isn't available.");
    return this.list({ productId, status: "PUBLISHED" }, query, false);
  }

  /** Every review of a store's products, except products removed by moderation (same rule as the store's rating). */
  async forStore(slug: string, query: ReviewQuery) {
    const store = await this.deps.prisma.store.findFirst({ where: { slug, status: "APPROVED" }, select: { id: true } });
    if (!store) throw new AppError(404, "NOT_FOUND", "This store isn't available.");
    return this.list({ status: "PUBLISHED", product: { storeId: store.id, status: { not: "REMOVED" } } }, query, true);
  }

  private async list(where: Prisma.ReviewWhereInput, query: ReviewQuery, withProduct: boolean) {
    const { prisma } = this.deps;
    const [groups, rows] = await Promise.all([
      prisma.review.groupBy({ by: ["rating"], where, _count: { _all: true } }),
      prisma.review.findMany({
        where: query.rating ? { ...where, rating: query.rating } : where,
        orderBy: ORDER[query.sort],
        skip: (query.page - 1) * REVIEWS_PAGE_SIZE,
        take: REVIEWS_PAGE_SIZE,
        select: {
          id: true,
          rating: true,
          title: true,
          body: true,
          createdAt: true,
          user: { select: { name: true } },
          orderItem: { select: { variantName: true } },
          product: { select: { id: true, title: true, status: true, variants: { where: { isActive: true }, select: { id: true }, take: 1 } } }
        }
      })
    ]);

    const summary = summarize(groups.map((g) => ({ rating: g.rating, count: g._count._all })));
    const totalItems = query.rating ? (summary.stars.find((s) => s.stars === query.rating)?.count ?? 0) : summary.count;
    const items: ReviewItem[] = rows.map((r) => ({
      id: r.id,
      rating: r.rating,
      title: r.title,
      body: r.body,
      author: shortName(r.user.name),
      variantName: r.orderItem.variantName,
      verifiedPurchase: true,
      createdAt: r.createdAt.toISOString(),
      ...(withProduct ? { product: { id: r.product.id, title: r.product.title, available: r.product.status === "ACTIVE" && r.product.variants.length > 0 } } : {})
    }));

    return {
      summary,
      items,
      page: query.page,
      pageSize: REVIEWS_PAGE_SIZE,
      totalItems,
      totalPages: Math.min(Math.ceil(totalItems / REVIEWS_PAGE_SIZE), 50)
    };
  }
}

/**
 * The average, rounded to 2 decimals with whole-number maths (half up), so it always
 * matches the stored rating that PostgreSQL's round(avg, 2) produced.
 */
export function summarize(counts: { rating: number; count: number }[]): RatingSummary {
  const byStars = new Map(counts.map((c) => [c.rating, c.count]));
  const count = counts.reduce((sum, c) => sum + c.count, 0);
  const total = counts.reduce((sum, c) => sum + c.rating * c.count, 0);
  const hundredths = count ? Math.floor((total * 200 + count) / (2 * count)) : 0;
  return {
    avg: hundredths / 100,
    count,
    stars: [5, 4, 3, 2, 1].map((stars) => {
      const n = byStars.get(stars) ?? 0;
      return { stars, count: n, percent: count ? Math.round((n * 100) / count) : 0 };
    })
  };
}

/** "Maria Santos" → "Maria S.", "Nicole Dela Cruz" → "Nicole D.", "Cher" → "Cher". */
export function shortName(fullName: string): string {
  const [first, second] = fullName.trim().split(/\s+/);
  if (!first) return "Vendora shopper";
  return second ? `${first} ${second.charAt(0).toUpperCase()}.` : first;
}
