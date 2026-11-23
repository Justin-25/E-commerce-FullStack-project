import type { PrismaClient } from "../../generated/prisma/client.js";
import { cached } from "../../lib/cache.js";
import { DELIVERY } from "../../lib/delivery.js";
import { AppError } from "../../lib/errors.js";
import type { KeyValueStore } from "../../lib/kv.js";
import type { Logger } from "../../lib/logger.js";
import { storePositivePercent } from "../reviews/ratings.js";
import type { SearchQuery } from "./catalog.schemas.js";
import { variantPricing } from "./pricing.js";
import { LOW_STOCK, stockStatus } from "./stock.js";
import { buildSearch, VISIBLE_COUNTS_BY_CATEGORY, type ListSort, type MatchMode, type SearchFilters, type SearchRow } from "./search.js";
import { visibleProduct } from "./visibility.js";

export const CATEGORY_CACHE_KEY = "catalog:categories:v1";
const CATEGORY_CACHE_SECONDS = 5 * 60;
/** "Bestseller" badge. */
const BESTSELLER_SOLD = 1_000;
/** "New" badge. */
const NEW_DAYS = 30;

export interface CategoryNode {
  id: string;
  slug: string;
  name: string;
  /** Visible products in this category AND its sub-categories. */
  productCount: number;
  children: CategoryNode[];
}

export interface ProductCard {
  id: string;
  slug: string;
  title: string;
  store: { name: string; slug: string };
  image: { url: string; alt: string | null } | null;
  /** The cheapest active variant ("from ₱…"), after deal rules. */
  priceCentavos: number;
  compareAtCentavos: number | null;
  savingsPercent: number;
  saleEndsAt: string | null;
  ratingAvg: number;
  ratingCount: number;
  soldCount: number;
  inStock: boolean;
  /** "Only 3 left": units left across the variants on sale, only when 1–5; null otherwise (exact stock stays private). */
  stockLeft: number | null;
  freeDelivery: boolean;
  badges: { deal: boolean; bestseller: boolean; new: boolean };
}

const notFound = () => new AppError(404, "NOT_FOUND", "This product isn't available.");

/** What shoppers browse: categories, search with filters, product pages. Public, no sign-in needed. */
export class CatalogService {
  constructor(private readonly deps: { prisma: PrismaClient; kv: KeyValueStore; logger?: Logger; now?: () => Date }) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  /** The category tree with product counts (cached for 5 minutes; categories rarely change). */
  categories(): Promise<CategoryNode[]> {
    return cached(this.deps.kv, CATEGORY_CACHE_KEY, CATEGORY_CACHE_SECONDS, () => this.loadCategories(), this.deps.logger);
  }

  private async loadCategories(): Promise<CategoryNode[]> {
    const { prisma } = this.deps;
    const [rows, counts] = await Promise.all([
      prisma.category.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
      prisma.$queryRaw<{ id: string; n: number }[]>(VISIBLE_COUNTS_BY_CATEGORY)
    ]);
    const own = new Map(counts.map((c) => [c.id, c.n]));
    const nodes = new Map<string, CategoryNode & { parentId: string | null }>(
      rows.map((c) => [c.id, { id: c.id, slug: c.slug, name: c.name, parentId: c.parentId, productCount: own.get(c.id) ?? 0, children: [] }])
    );
    const roots: CategoryNode[] = [];
    for (const node of nodes.values()) {
      const parent = node.parentId ? nodes.get(node.parentId) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    const rollUp = (n: CategoryNode): number => (n.productCount += n.children.reduce((sum, c) => sum + rollUp(c), 0));
    roots.forEach(rollUp);
    const strip = ({ id, slug, name, productCount, children }: CategoryNode): CategoryNode => ({ id, slug, name, productCount, children: children.map(strip) });
    return roots.map(strip);
  }

  /** Search with the design's filters, sort and page numbers, plus facet counts for the filter panel. */
  async search(query: SearchQuery) {
    const { prisma } = this.deps;
    const tree = await this.categories();
    const flat = flatten(tree);
    const categoryIds = query.category.length
      ? [...new Set(query.category.flatMap((slug) => descendants(flat.find((c) => c.slug === slug))))]
      : undefined;

    const filters = {
      text: query.q,
      categoryIds,
      storeSlugs: query.store,
      minPrice: query.minPrice,
      maxPrice: query.maxPrice,
      rating: query.rating,
      freeDelivery: query.freeDelivery,
      deal: query.deal
    };
    // Precise word search first. Only if that finds nothing, fall back to similar spellings
    // (typos), so fuzzy matches never pollute good results or undo "-excluded" words.
    let matchMode: MatchMode = "words";
    let sql = buildSearch(filters, matchMode);
    let [count] = await prisma.$queryRaw<{ total: number; sellers: number }[]>(sql.count);
    if (query.q?.trim() && (count?.total ?? 0) === 0) {
      matchMode = "similar";
      sql = buildSearch(filters, matchMode);
      [count] = await prisma.$queryRaw<{ total: number; sellers: number }[]>(sql.count);
    }

    const offset = (query.page - 1) * query.pageSize;
    const [rows, categoryCounts, stores, [storeTotal], [price]] = await Promise.all([
      prisma.$queryRaw<SearchRow[]>(sql.page(query.sort, query.pageSize, offset)),
      prisma.$queryRaw<{ id: string; n: number }[]>(sql.categoryFacet),
      prisma.$queryRaw<{ slug: string; name: string; n: number }[]>(sql.storeFacet),
      prisma.$queryRaw<{ n: number }[]>(sql.storeFacetTotal),
      prisma.$queryRaw<{ min: number | null; max: number | null }[]>(sql.priceFacet)
    ]);

    const totalItems = count?.total ?? 0;
    return {
      query: query.q ?? null,
      /** "similar": no exact matches, so these are similar spellings (show "Showing results for similar words"). */
      matchMode,
      items: await this.toCards(rows),
      page: query.page,
      pageSize: query.pageSize,
      totalItems,
      totalPages: Math.min(Math.ceil(totalItems / query.pageSize), 50),
      sellerCount: count?.sellers ?? 0,
      facets: {
        categories: categoryFacet(tree, new Map(categoryCounts.map((c) => [c.id, c.n]))),
        stores: { items: stores.map((s) => ({ slug: s.slug, name: s.name, count: s.n })), total: storeTotal?.n ?? 0 },
        price: { minCentavos: price?.min ?? null, maxCentavos: price?.max ?? null }
      }
    };
  }

  /** The product page. 404 unless visible (active product, approved store, something on sale). */
  async product(id: string) {
    const p = await this.deps.prisma.product.findFirst({
      where: visibleProduct(id),
      include: {
        store: true,
        category: { include: { parent: true } },
        images: { orderBy: { sortOrder: "asc" } },
        variants: { where: { isActive: true }, orderBy: { sortOrder: "asc" } }
      }
    });
    if (!p || p.variants.length === 0) throw notFound();

    const now = this.now();
    const positivePercent = await storePositivePercent(this.deps.prisma, p.store.id, now);
    const variants = p.variants.map((v) => {
      const pricing = variantPricing(v, now);
      return {
        id: v.id,
        sku: v.sku,
        name: v.name,
        ...pricing,
        saleEndsAt: pricing.saleEndsAt?.toISOString() ?? null,
        stock: stockStatus(v.stock)
      };
    });
    const cheapest = variants.reduce((a, b) => (b.priceCentavos < a.priceCentavos ? b : a));
    const dealEnds = variants.map((v) => v.saleEndsAt).filter((d): d is string => d !== null).sort()[0] ?? null;

    return {
      id: p.id,
      slug: p.slug,
      title: p.title,
      description: p.description,
      specs: readSpecs(p.specs),
      category: { slug: p.category.slug, name: p.category.name },
      breadcrumbs: [...(p.category.parent ? [{ slug: p.category.parent.slug, name: p.category.parent.name }] : []), { slug: p.category.slug, name: p.category.name }],
      store: {
        id: p.store.id,
        slug: p.store.slug,
        name: p.store.name,
        logoUrl: p.store.logoUrl,
        ratingAvg: Number(p.store.ratingAvg),
        ratingCount: p.store.ratingCount,
        positivePercent,
        followerCount: p.store.followerCount,
        shipsFrom: p.store.shipsFrom,
        verified: true, // every store passes document review before it can sell
        sellingSince: (p.store.approvedAt ?? p.store.createdAt).getFullYear()
      },
      images: p.images.map((i) => ({ url: i.url, alt: i.alt ?? p.title })),
      /** What the variants differ by ("Color: Midnight Black", "Size: XL"); with one variant there's nothing to pick. */
      variantLabel: p.variantLabel,
      variants,
      price: {
        fromCentavos: cheapest.priceCentavos,
        toCentavos: Math.max(...variants.map((v) => v.priceCentavos)),
        compareAtCentavos: cheapest.compareAtCentavos,
        savingsPercent: Math.max(...variants.map((v) => v.savingsPercent)),
        dealEndsAt: dealEnds
      },
      rating: { avg: Number(p.ratingAvg), count: p.ratingCount },
      soldCount: p.soldCount,
      inStock: variants.some((v) => v.stock.status !== "out_of_stock"),
      delivery: {
        freeThresholdCentavos: DELIVERY.freeThresholdCentavos,
        qualifiesForFreeDelivery: cheapest.priceCentavos >= DELIVERY.freeThresholdCentavos,
        standardFeeCentavos: DELIVERY.standardFeeCentavos,
        expressFeeCentavos: DELIVERY.expressFeeCentavos,
        /** The seller's "Offer Express delivery" for this product. */
        expressAvailable: p.expressAvailable,
        standardDays: DELIVERY.standardDays,
        expressDays: DELIVERY.expressDays
      },
      returns: { days: DELIVERY.returnDays }
    };
  }

  /** "Related products": best sellers from the same category, without this product. */
  async related(id: string): Promise<ProductCard[]> {
    const product = await this.deps.prisma.product.findFirst({ where: visibleProduct(id), include: { category: true } });
    if (!product) throw notFound();
    const result = await this.search({
      category: [product.category.slug],
      store: [],
      freeDelivery: false,
      deal: false,
      sort: "best_selling",
      page: 1,
      pageSize: 12
    });
    return result.items.filter((c) => c.id !== id).slice(0, 8);
  }

  /** Product cards for a list on another page (Home rows, deals), with the same visibility and price rules as search. */
  async list(filters: Partial<SearchFilters>, sort: ListSort, limit: number): Promise<ProductCard[]> {
    const sql = buildSearch({ storeSlugs: [], freeDelivery: false, ...filters });
    return this.toCards(await this.deps.prisma.$queryRaw<SearchRow[]>(sql.page(sort, limit, 0)));
  }

  /**
   * "Recently viewed": cards for these ids, in the order given (the browser keeps the list).
   * Products that aren't visible any more are simply left out.
   */
  async cardsByIds(ids: string[]): Promise<ProductCard[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const cards = await this.list({ productIds: unique }, "featured", unique.length);
    const byId = new Map(cards.map((c) => [c.id, c]));
    return unique.flatMap((id) => byId.get(id) ?? []);
  }

  private async toCards(rows: SearchRow[]): Promise<ProductCard[]> {
    if (rows.length === 0) return [];
    const images = await this.deps.prisma.productImage.findMany({
      where: { productId: { in: rows.map((r) => r.id) } },
      orderBy: { sortOrder: "asc" }
    });
    const cover = new Map<string, { url: string; alt: string | null }>();
    for (const img of images) if (!cover.has(img.productId)) cover.set(img.productId, { url: img.url, alt: img.alt });
    const newSince = this.now().getTime() - NEW_DAYS * 24 * 60 * 60 * 1000;

    return rows.map((r) => {
      const savingsPercent = r.compareAt ? Math.round(((r.compareAt - r.price) / r.compareAt) * 100) : 0;
      return {
        id: r.id,
        slug: r.slug,
        title: r.title,
        store: { name: r.storeName, slug: r.storeSlug },
        image: cover.get(r.id) ?? null,
        priceCentavos: r.price,
        compareAtCentavos: r.compareAt,
        savingsPercent,
        saleEndsAt: r.saleEndsAt ? new Date(r.saleEndsAt).toISOString() : null,
        ratingAvg: Number(r.ratingAvg),
        ratingCount: r.ratingCount,
        soldCount: r.soldCount,
        inStock: r.stockOnSale > 0,
        stockLeft: r.stockOnSale > 0 && r.stockOnSale <= LOW_STOCK ? r.stockOnSale : null,
        freeDelivery: r.price >= DELIVERY.freeThresholdCentavos,
        badges: { deal: r.compareAt !== null, bestseller: r.soldCount >= BESTSELLER_SOLD, new: r.publishedAt !== null && new Date(r.publishedAt).getTime() >= newSince }
      };
    });
  }
}

// --- category helpers -------------------------------------------------------

function flatten(nodes: CategoryNode[]): CategoryNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

/** A category and everything below it ("Electronics" includes "Headphones"). Unknown slug → nothing. */
function descendants(node: CategoryNode | undefined): string[] {
  return node ? [node.id, ...node.children.flatMap((c) => descendants(c))] : [];
}

export interface CategoryFacet {
  slug: string;
  name: string;
  count: number;
  children: CategoryFacet[];
}

/** The filter panel's "Category" list: only categories with results, counts including sub-categories. */
function categoryFacet(tree: CategoryNode[], counts: Map<string, number>): CategoryFacet[] {
  const walk = (n: CategoryNode): CategoryFacet | null => {
    const children = n.children.map(walk).filter((c): c is CategoryFacet => c !== null);
    const count = (counts.get(n.id) ?? 0) + children.reduce((sum, c) => sum + c.count, 0);
    return count > 0 ? { slug: n.slug, name: n.name, count, children } : null;
  };
  return tree.map(walk).filter((c): c is CategoryFacet => c !== null);
}

/** Specs are stored as JSON; only well-formed { label, value } pairs leave the API. */
export function readSpecs(value: unknown): { label: string; value: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((s: unknown) =>
    s && typeof s === "object" && typeof (s as { label?: unknown }).label === "string" && typeof (s as { value?: unknown }).value === "string"
      ? [{ label: (s as { label: string }).label, value: (s as { value: string }).value }]
      : []
  );
}
