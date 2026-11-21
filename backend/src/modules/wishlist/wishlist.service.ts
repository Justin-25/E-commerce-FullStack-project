import type { PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import type { CatalogService, ProductCard } from "../catalog/catalog.service.js";

/** A generous cap that stops one account from filling the table. */
export const WISHLIST_LIMIT = 200;

export interface PriceDrop {
  /** The price when the shopper saved it ("was ₱8,999"). */
  wasCentavos: number;
  nowCentavos: number;
  savingsCentavos: number;
  savingsPercent: number;
}

export interface WishlistItem {
  productId: string;
  slug: string;
  title: string;
  store: { name: string; slug: string };
  image: { url: string; alt: string | null } | null;
  savedAt: string;
  savedPriceCentavos: number;
  /** false: "No longer available" (archived, or its store isn't approved). It stays until the shopper removes it. */
  available: boolean;
  /** Everything a product card shows; null when no longer available. */
  card: ProductCard | null;
  /** Today's price is below the price when saved. Never for unavailable products. */
  priceDrop: PriceDrop | null;
}

const productNotFound = () => new AppError(404, "NOT_FOUND", "This product isn't available.");

/**
 * The wishlist ("hearts"). A saved row remembers the price at that moment, so a price
 * drop is simply today's price (same rules as everywhere: cheapest variant, deals that
 * ended don't count) below the saved one. Emails about drops come in milestone 6.
 */
export class WishlistService {
  constructor(private readonly deps: { prisma: PrismaClient; catalog: CatalogService; limit?: number }) {}

  private get limit() {
    return this.deps.limit ?? WISHLIST_LIMIT;
  }

  /** Which products are saved (to fill the hearts on cards), newest first. */
  async ids(userId: string): Promise<string[]> {
    const rows = await this.deps.prisma.wishlistItem.findMany({ where: { userId }, select: { productId: true }, orderBy: [{ createdAt: "desc" }, { productId: "asc" }] });
    return rows.map((r) => r.productId);
  }

  /** The wishlist page: newest first, with price drops and the "Price drop on 2 saved items" banner. */
  async list(userId: string) {
    const rows = await this.deps.prisma.wishlistItem.findMany({
      where: { userId },
      orderBy: [{ createdAt: "desc" }, { productId: "asc" }],
      include: {
        product: {
          select: { id: true, slug: true, title: true, store: { select: { name: true, slug: true } }, images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true, alt: true } } }
        }
      }
    });
    // Visible products come back as cards (same price rules as search); the rest are unavailable.
    const cards = new Map((await this.deps.catalog.cardsByIds(rows.map((r) => r.productId))).map((c) => [c.id, c]));

    const items: WishlistItem[] = rows.map((r) => {
      const card = cards.get(r.productId) ?? null;
      const saved = r.priceAtSaveCentavos;
      const priceDrop =
        card && card.priceCentavos < saved
          ? { wasCentavos: saved, nowCentavos: card.priceCentavos, savingsCentavos: saved - card.priceCentavos, savingsPercent: Math.round(((saved - card.priceCentavos) / saved) * 100) }
          : null;
      return {
        productId: r.productId,
        slug: r.product.slug,
        title: r.product.title,
        store: r.product.store,
        image: r.product.images[0] ?? null,
        savedAt: r.createdAt.toISOString(),
        savedPriceCentavos: saved,
        available: card !== null,
        card,
        priceDrop
      };
    });

    const drops = items.filter((i) => i.priceDrop !== null);
    return {
      items,
      count: items.length,
      priceDrops: {
        count: drops.length,
        /** "Deals end in 08h 42m": the soonest countdown among the dropped items, if any. */
        dealsEndAt: drops.map((i) => i.card?.saleEndsAt).filter((d): d is string => typeof d === "string").sort()[0] ?? null
      }
    };
  }

  /**
   * Save (the heart). Only products shoppers can see. Saving again changes nothing, and
   * keeps the FIRST saved price, so a later drop is still measured from it.
   */
  async save(userId: string, productId: string) {
    const { prisma, catalog } = this.deps;
    const [card] = await catalog.cardsByIds([productId]);
    if (!card) throw productNotFound();

    const key = { userId_productId: { userId, productId } };
    if (!(await prisma.wishlistItem.findUnique({ where: key }))) {
      if ((await prisma.wishlistItem.count({ where: { userId } })) >= this.limit) {
        throw new AppError(409, "CONFLICT", `Your wishlist is full (${this.limit} items). Remove something to save this one.`);
      }
      await prisma.wishlistItem.createMany({ data: [{ userId, productId, priceAtSaveCentavos: card.priceCentavos }], skipDuplicates: true });
    }
    const [item, count] = await Promise.all([prisma.wishlistItem.findUniqueOrThrow({ where: key }), prisma.wishlistItem.count({ where: { userId } })]);
    return { productId, saved: true, savedPriceCentavos: item.priceAtSaveCentavos, count };
  }

  /** Remove. Works for any saved product, including ones no longer available. Removing twice is fine. */
  async remove(userId: string, productId: string) {
    const { prisma } = this.deps;
    await prisma.wishlistItem.deleteMany({ where: { userId, productId } });
    return { productId, saved: false, count: await prisma.wishlistItem.count({ where: { userId } }) };
  }
}
