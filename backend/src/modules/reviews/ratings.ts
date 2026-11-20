import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** "98% positive": the share of 4★ and 5★ reviews... */
export const POSITIVE_MIN_STARS = 4;
/** ...in the last 12 months, so a store's old reviews don't hide how it's doing now. */
export const POSITIVE_WINDOW_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Star ratings are STORED on products and stores (search filters and sorts by them), but
 * they're never typed in: they're always recomputed from the published reviews. Run this
 * whenever reviews change: the demo seed now, writing a review (milestone 5), hiding one
 * or removing a product (milestone 7).
 *
 * A store's rating counts the reviews of all its products except ones removed by
 * moderation, so a product the seller stops selling doesn't erase its history.
 */
export async function recomputeRatings(db: Db, scope: { productIds: string[] } | "all"): Promise<void> {
  const products = scope === "all" ? Prisma.sql`TRUE` : Prisma.sql`p.id = ANY(${scope.productIds}::uuid[])`;
  const stores = scope === "all" ? Prisma.sql`TRUE` : Prisma.sql`s.id IN (SELECT "storeId" FROM products WHERE id = ANY(${scope.productIds}::uuid[]))`;

  await db.$executeRaw`
    UPDATE products p SET
      "ratingCount" = (SELECT count(*) FROM reviews r WHERE r."productId" = p.id AND r.status = 'PUBLISHED'),
      "ratingAvg" = coalesce((SELECT round(avg(r.rating), 2) FROM reviews r WHERE r."productId" = p.id AND r.status = 'PUBLISHED'), 0)
    WHERE ${products}`;

  await db.$executeRaw`
    UPDATE stores s SET
      "ratingCount" = (SELECT count(*) FROM reviews r JOIN products p ON p.id = r."productId"
                       WHERE p."storeId" = s.id AND r.status = 'PUBLISHED' AND p.status <> 'REMOVED'),
      "ratingAvg" = coalesce((SELECT round(avg(r.rating), 2) FROM reviews r JOIN products p ON p.id = r."productId"
                              WHERE p."storeId" = s.id AND r.status = 'PUBLISHED' AND p.status <> 'REMOVED'), 0)
    WHERE ${stores}`;
}

/**
 * "98% positive" for a store, or null when it has no reviews in the last 12 months.
 * Rounded DOWN, so "100% positive" only appears when every review really is positive.
 */
export async function storePositivePercent(db: Db, storeId: string, now: Date): Promise<number | null> {
  const since = new Date(now.getTime() - POSITIVE_WINDOW_DAYS * DAY_MS);
  const [row] = await db.$queryRaw<{ positive: number; total: number }[]>`
    SELECT count(*) FILTER (WHERE r.rating >= ${POSITIVE_MIN_STARS})::int AS positive, count(*)::int AS total
    FROM reviews r JOIN products p ON p.id = r."productId"
    WHERE p."storeId" = ${storeId}::uuid AND r.status = 'PUBLISHED' AND p.status <> 'REMOVED' AND r."createdAt" >= ${since}`;
  return row && row.total > 0 ? Math.floor((row.positive * 100) / row.total) : null;
}
