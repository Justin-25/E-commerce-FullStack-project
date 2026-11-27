import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { DELIVERY } from "../../lib/delivery.js";
import { AppError } from "../../lib/errors.js";
import { buildSearch } from "../catalog/search.js";
import { storePositivePercent } from "../reviews/ratings.js";

/** "Ships within 24 hours" looks at the last 90 days of orders... */
const SHIPPING_WINDOW_DAYS = 90;
/** ...and only once there are enough of them to mean something. */
const SHIPPING_MIN_ORDERS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const storeNotFound = () => new AppError(404, "NOT_FOUND", "This store isn't available.");

export interface FollowState {
  following: boolean;
  followerCount: number;
}

/** The store page and following stores. */
export class StoreService {
  constructor(private readonly deps: { prisma: PrismaClient; now?: () => Date }) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * The store page header, About and category chips. Its product grid is the normal
   * search with `store=<slug>` (and `deal=true` for the "Deals" chip), so filters,
   * sorting and pages behave exactly like everywhere else.
   */
  /** An old address of a store Support renamed (7c-2): the store's current address, if it's live. */
  async movedTo(slug: string): Promise<string | null> {
    const old = await this.deps.prisma.storeSlugRedirect.findUnique({ where: { slug }, select: { store: { select: { slug: true, status: true } } } });
    return old && old.store.status === "APPROVED" && old.store.slug !== slug ? old.store.slug : null;
  }

  async page(slug: string) {
    const { prisma } = this.deps;
    const store = await prisma.store.findFirst({ where: { slug, status: "APPROVED" } });
    if (!store) throw storeNotFound();

    const now = this.now();
    const all = buildSearch({ storeSlugs: [slug], freeDelivery: false });
    const deals = buildSearch({ storeSlugs: [slug], freeDelivery: false, deal: true });
    const shippedSince = new Date(now.getTime() - SHIPPING_WINDOW_DAYS * DAY_MS);
    const [[products], categoryCounts, [dealProducts], positivePercent, [shipping]] = await Promise.all([
      prisma.$queryRaw<{ total: number }[]>(all.count),
      prisma.$queryRaw<{ id: string; n: number }[]>(all.categoryFacet),
      prisma.$queryRaw<{ total: number }[]>(deals.count),
      storePositivePercent(prisma, store.id, now),
      // 90% of orders shipped within this many hours of being placed.
      prisma.$queryRaw<{ hours: number | null; n: number }[]>(Prisma.sql`
        SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM so."shippedAt" - o."placedAt")::float8) / 3600 AS hours,
               count(*)::int AS n
        FROM seller_orders so JOIN orders o ON o.id = so."orderId"
        WHERE so."storeId" = ${store.id}::uuid AND so."shippedAt" IS NOT NULL AND o."placedAt" IS NOT NULL AND so."shippedAt" >= ${shippedSince}`)
    ]);

    const names = await prisma.category.findMany({ where: { id: { in: categoryCounts.map((c) => c.id) } }, select: { id: true, slug: true, name: true } });
    const count = new Map(categoryCounts.map((c) => [c.id, c.n]));
    const categories = names
      .map((c) => ({ slug: c.slug, name: c.name, count: count.get(c.id) ?? 0 }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    return {
      id: store.id,
      slug: store.slug,
      name: store.name,
      description: store.description,
      logoUrl: store.logoUrl,
      bannerUrl: store.bannerUrl,
      shipsFrom: store.shipsFrom,
      verified: true, // every store passes document review before it can sell
      sellingSince: (store.approvedAt ?? store.createdAt).getFullYear(),
      rating: { avg: Number(store.ratingAvg), count: store.ratingCount },
      /** Share of 4★–5★ reviews in the last 12 months; null without recent reviews. */
      positivePercent,
      followerCount: store.followerCount,
      productCount: products?.total ?? 0,
      dealCount: dealProducts?.total ?? 0,
      /** The chips above the products ("Headphones 7"), biggest first. */
      categories,
      /** null until the store has shipped enough orders recently. */
      shipsWithinHours: shipping && shipping.n >= SHIPPING_MIN_ORDERS && shipping.hours !== null ? Math.ceil(shipping.hours) : null,
      returns: { days: DELIVERY.returnDays }
    };
  }

  /** Whether this shopper follows the store (asked separately, so the store page stays the same for everyone and cacheable). */
  async followState(userId: string, slug: string): Promise<FollowState> {
    const store = await this.deps.prisma.store.findFirst({ where: { slug, status: "APPROVED" }, select: { id: true, followerCount: true } });
    if (!store) throw storeNotFound();
    const follow = await this.deps.prisma.storeFollow.findUnique({ where: { userId_storeId: { userId, storeId: store.id } } });
    return { following: follow !== null, followerCount: store.followerCount };
  }

  /**
   * Follow. Doing it twice (double click, two tabs) changes nothing: the follow row is
   * inserted only if missing, and the counter moves only when a row was really added,
   * in the same transaction.
   */
  async follow(userId: string, slug: string): Promise<FollowState> {
    return this.deps.prisma.$transaction(async (tx) => {
      const store = await tx.store.findFirst({ where: { slug, status: "APPROVED" }, select: { id: true, ownerId: true, followerCount: true } });
      if (!store) throw storeNotFound();
      if (store.ownerId === userId) throw new AppError(409, "CONFLICT", "You can't follow your own store.");
      const { count } = await tx.storeFollow.createMany({ data: [{ userId, storeId: store.id }], skipDuplicates: true });
      if (count === 0) return { following: true, followerCount: store.followerCount };
      const updated = await tx.store.update({ where: { id: store.id }, data: { followerCount: { increment: 1 } }, select: { followerCount: true } });
      return { following: true, followerCount: updated.followerCount };
    });
  }

  /** Unfollow. Works for any store you follow, even one that's no longer approved, so nobody gets stuck following it. */
  async unfollow(userId: string, slug: string): Promise<FollowState> {
    return this.deps.prisma.$transaction(async (tx) => {
      const store = await tx.store.findUnique({ where: { slug }, select: { id: true } });
      if (!store) throw storeNotFound();
      const { count } = await tx.storeFollow.deleteMany({ where: { userId, storeId: store.id } });
      if (count > 0) await tx.store.updateMany({ where: { id: store.id, followerCount: { gt: 0 } }, data: { followerCount: { decrement: 1 } } });
      const { followerCount } = await tx.store.findUniqueOrThrow({ where: { id: store.id }, select: { followerCount: true } });
      return { following: false, followerCount };
    });
  }
}
