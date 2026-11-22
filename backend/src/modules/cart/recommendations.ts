import type { PrismaClient } from "../../generated/prisma/client.js";
import type { CatalogService, ProductCard } from "../catalog/catalog.service.js";
import type { SearchFilters, ListSort } from "../catalog/search.js";

/** The cart's "Recommended for you" row, as designed: 5 cards. */
export const RECOMMENDED_COUNT = 5;
/** Enough signal from the wishlist and followed stores; more adds nothing but query time. */
const SIGNAL_LIMIT = 50;

export interface Recommendations {
  /**
   * What the picks are based on, for the subtitle:
   * "cart" = "Based on your cart"; "you" = your wishlist or followed stores; "popular" = best sellers or top rated.
   */
  basedOn: "cart" | "you" | "popular";
  items: ProductCard[];
  /** "See all": a search for the cart's main category (null when the cart is empty: link to best sellers instead). */
  seeAll: { categorySlug: string; categoryName: string } | null;
}

/**
 * "Recommended for you" on the cart page. Simple, explainable rules, in this order, until
 * there are 5 cards:
 *   1. best sellers from the categories of the cart's products ("Based on your cart");
 *   2. signed in: the categories of the wishlist, then the stores the shopper follows;
 *   3. top-up: best sellers (signed in) or top rated (guests).
 * Never what's already in the cart, never sold out, and only products anyone could buy
 * (the same visibility rules as search).
 */
export class RecommendationService {
  constructor(private readonly deps: { prisma: PrismaClient; catalog: CatalogService }) {}

  /** A signed-in shopper: their account cart, wishlist and followed stores. */
  async forUser(userId: string): Promise<Recommendations> {
    const { prisma } = this.deps;
    const [cartLines, wishlist, follows] = await Promise.all([
      prisma.cartItem.findMany({ where: { cart: { userId } }, select: { variant: { select: { productId: true } } }, orderBy: { addedAt: "desc" } }),
      prisma.wishlistItem.findMany({ where: { userId }, select: { product: { select: { categoryId: true } } }, orderBy: { createdAt: "desc" }, take: SIGNAL_LIMIT }),
      prisma.storeFollow.findMany({ where: { userId }, select: { store: { select: { slug: true } } }, orderBy: { createdAt: "desc" }, take: SIGNAL_LIMIT })
    ]);
    return this.build(
      cartLines.map((l) => l.variant.productId),
      { categoryIds: unique(wishlist.map((w) => w.product.categoryId)), storeSlugs: follows.map((f) => f.store.slug) },
      "best_selling"
    );
  }

  /** A guest: the items in their browser cart (variant ids), topped up with top-rated products. */
  async forGuest(variantIds: string[]): Promise<Recommendations> {
    const variants = variantIds.length ? await this.deps.prisma.productVariant.findMany({ where: { id: { in: variantIds } }, select: { productId: true } }) : [];
    return this.build(
      variants.map((v) => v.productId),
      null,
      "top_rated"
    );
  }

  private async build(cartProductIds: string[], personal: { categoryIds: string[]; storeSlugs: string[] } | null, topUp: ListSort): Promise<Recommendations> {
    const { prisma, catalog } = this.deps;
    const inCart = unique(cartProductIds);
    const cartProducts = inCart.length
      ? await prisma.product.findMany({ where: { id: { in: inCart } }, select: { categoryId: true, category: { select: { slug: true, name: true } } } })
      : [];

    const picked: ProductCard[] = [];
    /** Adds up to the missing number of cards from this rule; returns how many it added. */
    const add = async (filters: Partial<SearchFilters>, sort: ListSort) => {
      const missing = RECOMMENDED_COUNT - picked.length;
      if (missing <= 0) return 0;
      const cards = await catalog.list({ ...filters, inStock: true, excludeProductIds: [...inCart, ...picked.map((c) => c.id)] }, sort, missing);
      picked.push(...cards);
      return cards.length;
    };

    let basedOn: Recommendations["basedOn"] = "popular";
    const cartCategories = unique(cartProducts.map((p) => p.categoryId));
    if (cartCategories.length && (await add({ categoryIds: cartCategories }, "best_selling")) > 0) basedOn = "cart";
    if (personal) {
      const fromWishlist = personal.categoryIds.length ? await add({ categoryIds: personal.categoryIds }, "best_selling") : 0;
      const fromFollows = personal.storeSlugs.length ? await add({ storeSlugs: personal.storeSlugs }, "best_selling") : 0;
      if (basedOn === "popular" && fromWishlist + fromFollows > 0) basedOn = "you";
    }
    await add({}, topUp);

    return { basedOn, items: picked, seeAll: mainCategory(cartProducts.map((p) => p.category)) };
  }
}

/** The category most of the cart's products are in (ties: alphabetical, so the answer is stable). */
function mainCategory(categories: { slug: string; name: string }[]): Recommendations["seeAll"] {
  const counts = new Map<string, { slug: string; name: string; n: number }>();
  for (const c of categories) counts.set(c.slug, { ...c, n: (counts.get(c.slug)?.n ?? 0) + 1 });
  const top = [...counts.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))[0];
  return top ? { categorySlug: top.slug, categoryName: top.name } : null;
}

const unique = <T>(values: T[]) => [...new Set(values)];
