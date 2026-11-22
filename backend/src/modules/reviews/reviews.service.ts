import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import { isUniqueViolation } from "../../lib/prismaErrors.js";
import { visibleProduct } from "../catalog/visibility.js";
import { recomputeRatings } from "./ratings.js";
import { REVIEWS_PAGE_SIZE, type EditReviewInput, type ReviewQuery, type WriteReviewInput } from "./reviews.schemas.js";

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

/** A review as its author sees it (on the order page and after writing or editing it). */
export interface MyReview {
  id: string;
  orderItemId: string;
  productId: string;
  rating: number;
  title: string | null;
  body: string | null;
  /** HIDDEN = taken off the product page by moderation (milestone 7); its author still sees it. */
  status: "PUBLISHED" | "HIDDEN";
  createdAt: string;
  updatedAt: string;
}

const mine = (r: { id: string; orderItemId: string; productId: string; rating: number; title: string | null; body: string | null; status: "PUBLISHED" | "HIDDEN"; createdAt: Date; updatedAt: Date }): MyReview => ({
  id: r.id,
  orderItemId: r.orderItemId,
  productId: r.productId,
  rating: r.rating,
  title: r.title,
  body: r.body,
  status: r.status,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString()
});
const reviewNotFound = () => new AppError(404, "NOT_FOUND", "This review doesn't exist.");
const alreadyReviewed = () => new AppError(409, "CONFLICT", "You've already reviewed this item. You can edit your review instead.", { details: { reason: "already_reviewed" } });

/**
 * Review changes for one store run one at a time. Ratings are recomputed from the reviews
 * inside the same transaction; without this lock, two reviews written at the same moment
 * could each recompute from a count that's missing the other one (proven on PostgreSQL).
 * Locking the store covers both the product's and the store's rating.
 */
async function lockStoreOf(tx: Prisma.TransactionClient, productId: string) {
  await tx.$queryRaw`SELECT s.id FROM stores s JOIN products p ON p."storeId" = s.id WHERE p.id = ${productId}::uuid FOR UPDATE OF s`;
}

/**
 * Reviews: reading a product's and a store's Reviews tab (public), and writing, editing and
 * deleting your own (signed in). A review needs an item you bought and received: one review
 * per order item, enforced by a unique index.
 */
export class ReviewService {
  constructor(private readonly deps: { prisma: PrismaClient }) {}

  /** "Write a review": only for an item in one of your orders, once its package is delivered. */
  async write(userId: string, input: WriteReviewInput): Promise<MyReview> {
    try {
      return await this.deps.prisma.$transaction(async (tx) => {
        const item = await tx.orderItem.findFirst({
          where: { id: input.orderItemId, sellerOrder: { order: { userId } } },
          select: { id: true, productId: true, sellerOrder: { select: { deliveredAt: true } }, review: { select: { id: true } } }
        });
        if (!item) throw new AppError(404, "NOT_FOUND", "This item isn't in your orders.");
        if (!item.sellerOrder.deliveredAt) throw new AppError(409, "CONFLICT", "You can review this item once it's delivered.", { details: { reason: "not_delivered" } });
        if (item.review) throw alreadyReviewed();
        await lockStoreOf(tx, item.productId);
        const review = await tx.review.create({
          data: { productId: item.productId, userId, orderItemId: item.id, rating: input.rating, title: input.title ?? null, body: input.body ?? null }
        });
        await recomputeRatings(tx, { productIds: [item.productId] });
        return mine(review);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw alreadyReviewed(); // the same item reviewed twice at the same moment
      throw err;
    }
  }

  /** Edit your review (any time): only the stars, title and text sent change. */
  async edit(userId: string, reviewId: string, input: EditReviewInput): Promise<MyReview> {
    return this.deps.prisma.$transaction(async (tx) => {
      const existing = await tx.review.findFirst({ where: { id: reviewId, userId }, select: { productId: true } });
      if (!existing) throw reviewNotFound();
      await lockStoreOf(tx, existing.productId);
      // updateMany + count: deleted in another tab meanwhile → 404, not a crash.
      const { count } = await tx.review.updateMany({
        where: { id: reviewId, userId },
        data: {
          ...(input.rating !== undefined ? { rating: input.rating } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.body !== undefined ? { body: input.body } : {})
        }
      });
      if (count === 0) throw reviewNotFound();
      await recomputeRatings(tx, { productIds: [existing.productId] });
      return mine(await tx.review.findUniqueOrThrow({ where: { id: reviewId } }));
    });
  }

  /** Delete your review (any time); the item can be reviewed again later. */
  async remove(userId: string, reviewId: string): Promise<void> {
    await this.deps.prisma.$transaction(async (tx) => {
      const existing = await tx.review.findFirst({ where: { id: reviewId, userId }, select: { productId: true } });
      if (!existing) throw reviewNotFound();
      await lockStoreOf(tx, existing.productId);
      const { count } = await tx.review.deleteMany({ where: { id: reviewId, userId } });
      if (count === 0) throw reviewNotFound(); // deleted in another tab meanwhile
      await recomputeRatings(tx, { productIds: [existing.productId] });
    });
  }

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
