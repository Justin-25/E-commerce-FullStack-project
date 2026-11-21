import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { cached } from "../../lib/cache.js";
import type { KeyValueStore } from "../../lib/kv.js";
import type { Logger } from "../../lib/logger.js";
import type { CatalogService, CategoryNode, ProductCard } from "../catalog/catalog.service.js";
import { buildSearch, TOP_RATED_PRIOR } from "../catalog/search.js";
import { storePositivePercent } from "../reviews/ratings.js";

export const HOME_CACHE_KEY = "home:v1";
/** Home is the busiest page: one cached answer for everyone, rebuilt at most once a minute. */
const HOME_CACHE_SECONDS = 60;
const ROW_SIZE = 8;
const TOP_STORES = 6;

export interface TopStore {
  slug: string;
  name: string;
  logoUrl: string | null;
  /** "Electronics · ★ 4.9": the top-level category most of its products are in. */
  mainCategory: { slug: string; name: string } | null;
  rating: { avg: number; count: number };
  positivePercent: number | null;
  followerCount: number;
}

export interface HomePage {
  /** "Shop by category": the top-level categories with product counts. */
  categories: { slug: string; name: string; productCount: number }[];
  /** "Today's deals": deals with a running countdown, ending soonest first. `endsAt` = the soonest ("Ends in 08h 42m"). */
  todaysDeals: { endsAt: string | null; items: ProductCard[] };
  /** "Best sellers": most sold overall ("#1 Best seller" = the first). */
  bestSellers: ProductCard[];
  /** "Top-rated stores": by weighted rating, like "Top rated" products. */
  topStores: TopStore[];
}

/**
 * The Home page's data sections. The hero, trust strip, AI band and "Start selling" card
 * are fixed text in the frontend. Everything here is the same for every visitor, so it's
 * cached; prices may be up to a minute old here, while checkout always re-reads them.
 */
export class HomeService {
  constructor(private readonly deps: { prisma: PrismaClient; kv: KeyValueStore; catalog: CatalogService; logger?: Logger; now?: () => Date }) {}

  home(): Promise<HomePage> {
    return cached(this.deps.kv, HOME_CACHE_KEY, HOME_CACHE_SECONDS, () => this.load(), this.deps.logger);
  }

  private async load(): Promise<HomePage> {
    const { catalog } = this.deps;
    const tree = await catalog.categories();
    const [deals, bestSellers, topStores] = await Promise.all([
      catalog.list({ countdown: true }, "ending_soon", ROW_SIZE),
      catalog.list({}, "best_selling", ROW_SIZE),
      this.topStores(tree)
    ]);
    return {
      categories: tree.map(({ slug, name, productCount }) => ({ slug, name, productCount })),
      todaysDeals: { endsAt: deals[0]?.saleEndsAt ?? null, items: deals },
      bestSellers,
      topStores
    };
  }

  private async topStores(tree: CategoryNode[]): Promise<TopStore[]> {
    const { prisma } = this.deps;
    const now = this.deps.now?.() ?? new Date();
    // Approved stores with reviews and at least one product on sale, by weighted rating.
    const stores = await prisma.$queryRaw<{ id: string; slug: string; name: string; logoUrl: string | null; ratingAvg: number; ratingCount: number; followerCount: number }[]>(Prisma.sql`
      SELECT s.id, s.slug, s.name, s."logoUrl", s."ratingAvg"::float AS "ratingAvg", s."ratingCount", s."followerCount"
      FROM stores s
      WHERE s.status = 'APPROVED' AND s."ratingCount" > 0
        AND EXISTS (SELECT 1 FROM products p WHERE p."storeId" = s.id AND p.status = 'ACTIVE'
                    AND EXISTS (SELECT 1 FROM product_variants v WHERE v."productId" = p.id AND v."isActive"))
      ORDER BY (s."ratingAvg" * s."ratingCount" + ${TOP_RATED_PRIOR.stars * TOP_RATED_PRIOR.reviews}) / (s."ratingCount" + ${TOP_RATED_PRIOR.reviews}) DESC,
               s."ratingCount" DESC, s.name ASC
      LIMIT ${TOP_STORES}`);

    // Which top-level category each category belongs to.
    const rootOf = new Map<string, CategoryNode>();
    const mark = (node: CategoryNode, root: CategoryNode) => {
      rootOf.set(node.id, root);
      node.children.forEach((c) => mark(c, root));
    };
    tree.forEach((root) => mark(root, root));

    return Promise.all(
      stores.map(async (s) => {
        const [counts, positivePercent] = await Promise.all([
          prisma.$queryRaw<{ id: string; n: number }[]>(buildSearch({ storeSlugs: [s.slug], freeDelivery: false }).categoryFacet),
          storePositivePercent(prisma, s.id, now)
        ]);
        const perRoot = new Map<CategoryNode, number>();
        for (const c of counts) {
          const root = rootOf.get(c.id);
          if (root) perRoot.set(root, (perRoot.get(root) ?? 0) + c.n);
        }
        const main = [...perRoot.entries()].sort((a, b) => b[1] - a[1] || a[0].name.localeCompare(b[0].name))[0]?.[0];
        return {
          slug: s.slug,
          name: s.name,
          logoUrl: s.logoUrl,
          mainCategory: main ? { slug: main.slug, name: main.name } : null,
          rating: { avg: Number(s.ratingAvg), count: s.ratingCount },
          positivePercent,
          followerCount: s.followerCount
        };
      })
    );
  }
}
