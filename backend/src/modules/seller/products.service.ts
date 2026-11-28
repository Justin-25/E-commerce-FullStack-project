import { randomInt } from "node:crypto";
import { Prisma, type PrismaClient, type ProductStatus } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import type { KeyValueStore } from "../../lib/kv.js";
import { likeLiteral } from "../../lib/like.js";
import type { Logger } from "../../lib/logger.js";
import type { MediaStorage, StoredMedia, UploadTicket } from "../../lib/media.js";
import { isUniqueViolation } from "../../lib/prismaErrors.js";
import { readSpecs } from "../catalog/catalog.service.js";
import { variantPricing } from "../catalog/pricing.js";
import { MAX_DEAL_DAYS, SELLER_LOW_STOCK, SELLER_PAGE_SIZE, type ProductInput, type SellerProductListQuery } from "./products.schemas.js";
import { sellerStore, type SellerStore } from "./access.js";
import { slugify } from "./seller.schemas.js";
import { SellerUploads } from "./uploads.js";

type Tx = Prisma.TransactionClient;
export type SellerProductStatus = "draft" | "active" | "inactive" | "removed";

/** What the seller sees: "Inactive" = published, then hidden with the Active toggle; "Removed" = taken down by Vendora. */
const STATUS_NAME: Record<ProductStatus, SellerProductStatus> = { DRAFT: "draft", ACTIVE: "active", ARCHIVED: "inactive", REMOVED: "removed" };
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SellerProductRow {
  productId: string;
  /** null: a draft with no variants yet (it still gets a row). */
  variantId: string | null;
  title: string;
  variantName: string | null;
  sku: string | null;
  image: { url: string; alt: string | null } | null;
  /** Today's price (a deal that ended counts at its compare-at price, as shoppers see it). */
  priceCentavos: number | null;
  compareAtCentavos: number | null;
  stock: number | null;
  /** "9 left": set when 1–9 are left. */
  stockLeft: number | null;
  /** Units in paid orders over the last 30 days. */
  sold30d: number;
  status: SellerProductStatus | "out_of_stock";
}

export interface SellerProductView {
  id: string;
  slug: string;
  status: SellerProductStatus;
  /** Send it back with an edit: if the product changed since, the edit is refused (reload instead). */
  version: number;
  title: string;
  category: { slug: string; name: string; parent: { slug: string; name: string } | null };
  description: string;
  variantLabel: string;
  variants: { id: string; name: string; sku: string; priceCentavos: number; compareAtCentavos: number | null; stock: number }[];
  dealEndsAt: string | null;
  photos: { id: string; url: string; alt: string | null }[];
  specs: { label: string; value: string }[];
  weightGrams: number | null;
  /** The store's "Ships from" (set in store details; the same for every product). */
  shipsFrom: string | null;
  active: boolean;
  expressAvailable: boolean;
  lowStockAlert: boolean;
  /** Shoppers can see it: active, something on sale, and the store approved. */
  visibleToShoppers: boolean;
  /** Vendora removed it (7d): when and why. It can't be changed; Moderation may restore it. */
  removal: { at: string | null; reason: string | null } | null;
  /** Only products that never sold can be deleted (orders keep pointing at them). */
  canDelete: boolean;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const forbidden = (reason: string, message: string) => new AppError(403, "FORBIDDEN", message, { details: { reason } });
const conflict = (reason: string, message: string, field?: { path: string; message: string }) =>
  new AppError(409, "CONFLICT", message, { details: { reason }, ...(field ? { fields: [field] } : {}) });
const badField = (path: string, message: string) => new AppError(400, "VALIDATION_ERROR", "Some fields are invalid", { fields: [{ path, message }] });
const notFound = () => new AppError(404, "NOT_FOUND", "This product doesn't exist.");
const removedByVendora = () => forbidden("removed_by_vendora", "Vendora removed this product, so it can't be changed. Contact Vendora support if you think this is a mistake.");

/**
 * Seller Center products (milestone 6b): the products list, Add / Edit product, delete, photo
 * uploads. Shoppers see a product once it's published, active and its store is approved
 * (catalog/visibility.ts), so a seller can prepare products while the store is under review.
 */
export class SellerProductService {
  private readonly uploads: SellerUploads;

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      kv: KeyValueStore;
      /** null = uploads off (no CLOUDINARY_URL). */
      media: MediaStorage | null;
      logger?: Logger;
      now?: () => Date;
    }
  ) {
    this.uploads = new SellerUploads({ kv: deps.kv, media: deps.media, ...(deps.logger ? { logger: deps.logger } : {}) });
  }

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  // --- reading ------------------------------------------------------------------

  /** The products list: one row per variant, tabs All / Active / Drafts / Out of stock, newest products first. */
  async list(userId: string, query: SellerProductListQuery) {
    const { prisma } = this.deps;
    const store = await this.seller(userId, { write: false });
    const now = this.now();
    const categoryIds = query.category.length
      ? (await prisma.category.findMany({ where: { OR: [{ slug: { in: query.category } }, { parent: { slug: { in: query.category } } }] }, select: { id: true } })).map((c) => c.id)
      : null;

    // Every row of the store. A product without variants (an early draft) still gets one row.
    const rows = Prisma.sql`
      SELECT p.id AS "productId", p.title, p.status::text AS status, p."createdAt", p."categoryId",
             v.id AS "variantId", v.name AS "variantName", v.sku, v."priceCentavos", v."compareAtCentavos", v."saleEndsAt", v.stock, v."sortOrder",
             CASE WHEN p.status = 'DRAFT' THEN 'drafts'
                  WHEN p.status = 'ACTIVE' AND coalesce(v.stock, 0) > 0 THEN 'active'
                  WHEN p.status = 'ACTIVE' THEN 'out_of_stock'
                  ELSE 'hidden' END AS tab
      FROM products p
      LEFT JOIN product_variants v ON v."productId" = p.id AND v."isActive"
      WHERE p."storeId" = ${store.id}::uuid`;
    const filters: Prisma.Sql[] = [];
    if (query.tab !== "all") filters.push(Prisma.sql`r.tab = ${query.tab}`);
    if (query.q) {
      const like = `%${likeLiteral(query.q)}%`;
      filters.push(Prisma.sql`(r.title ILIKE ${like} OR r.sku ILIKE ${like})`);
    }
    if (categoryIds) filters.push(Prisma.sql`r."categoryId" = ANY(${categoryIds}::uuid[])`);
    const where = filters.length ? Prisma.sql`WHERE ${Prisma.join(filters, " AND ")}` : Prisma.empty;
    const offset = (query.page - 1) * SELLER_PAGE_SIZE;

    type Row = {
      productId: string;
      title: string;
      status: ProductStatus;
      variantId: string | null;
      variantName: string | null;
      sku: string | null;
      priceCentavos: number | null;
      compareAtCentavos: number | null;
      saleEndsAt: Date | null;
      stock: number | null;
    };
    const [tabCounts, [total], page] = await Promise.all([
      prisma.$queryRaw<{ tab: string; n: number }[]>`SELECT r.tab, count(*)::int AS n FROM (${rows}) r GROUP BY r.tab`,
      prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM (${rows}) r ${where}`,
      prisma.$queryRaw<Row[]>`SELECT * FROM (${rows}) r ${where} ORDER BY r."createdAt" DESC, r."productId" DESC, r."sortOrder" NULLS FIRST, r."variantId" LIMIT ${SELLER_PAGE_SIZE} OFFSET ${offset}`
    ]);

    const productIds = [...new Set(page.map((r) => r.productId))];
    const variantIds = page.flatMap((r) => (r.variantId ? [r.variantId] : []));
    const [images, sold] = await Promise.all([
      prisma.productImage.findMany({ where: { productId: { in: productIds } }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }], select: { productId: true, url: true, alt: true } }),
      this.soldSince(variantIds, new Date(now.getTime() - 30 * DAY_MS))
    ]);
    const cover = new Map<string, { url: string; alt: string | null }>();
    for (const i of images) if (!cover.has(i.productId)) cover.set(i.productId, { url: i.url, alt: i.alt });

    const items: SellerProductRow[] = page.map((r) => {
      const pricing = r.variantId && r.priceCentavos !== null ? variantPricing({ priceCentavos: r.priceCentavos, compareAtCentavos: r.compareAtCentavos, saleEndsAt: r.saleEndsAt }, now) : null;
      const soldOut = r.status === "ACTIVE" && (r.stock ?? 0) === 0;
      return {
        productId: r.productId,
        variantId: r.variantId,
        title: r.title,
        variantName: r.variantName,
        sku: r.sku,
        image: cover.get(r.productId) ?? null,
        priceCentavos: pricing?.priceCentavos ?? null,
        compareAtCentavos: pricing?.compareAtCentavos ?? null,
        stock: r.stock,
        stockLeft: r.stock !== null && r.stock > 0 && r.stock < SELLER_LOW_STOCK ? r.stock : null,
        sold30d: r.variantId ? (sold.get(r.variantId) ?? 0) : 0,
        status: soldOut ? "out_of_stock" : STATUS_NAME[r.status]
      };
    });

    const count = (tab: string) => tabCounts.find((t) => t.tab === tab)?.n ?? 0;
    const totalItems = total?.n ?? 0;
    return {
      items,
      counts: { all: tabCounts.reduce((s, t) => s + t.n, 0), active: count("active"), drafts: count("drafts"), out_of_stock: count("out_of_stock") },
      page: query.page,
      pageSize: SELLER_PAGE_SIZE,
      totalItems,
      totalPages: Math.ceil(totalItems / SELLER_PAGE_SIZE)
    };
  }

  /** The Edit product form. */
  async view(userId: string, productId: string): Promise<SellerProductView> {
    return this.load(await this.seller(userId, { write: false }), productId);
  }

  // --- add, edit, delete ----------------------------------------------------------

  async create(userId: string, input: ProductInput): Promise<SellerProductView> {
    const { prisma } = this.deps;
    const store = await this.seller(userId, { write: true });
    const categoryId = await this.leafCategory(input.category);
    this.checkDeal(input.dealEndsAt);
    input.variants.forEach((v, i) => {
      if (v.id) throw badField(`variants.${i}.id`, "This variant isn't part of the product. Reload and try again.");
    });
    input.photos.forEach((p, i) => {
      if (p.id) throw badField(`photos.${i}.id`, "This photo isn't part of the product. Reload and try again.");
    });
    const uploaded = await this.checkNewPhotos(userId, input);
    const now = this.now();

    const id = await this.writing(() =>
      prisma.$transaction(async (tx) => {
        await lockStore(tx, store.id); // one change at a time per store: web addresses and SKUs stay unique
        await this.checkFree(tx, store.id, input, uploaded);
        const status = statusFor(input);
        const product = await tx.product.create({
          data: {
            storeId: store.id,
            categoryId,
            title: input.title,
            slug: await uniqueSlug(tx, store.id, input.title),
            description: input.description,
            specs: input.specs,
            variantLabel: input.variantLabel,
            expressAvailable: input.expressAvailable,
            lowStockAlert: input.lowStockAlert,
            status,
            publishedAt: status === "ACTIVE" ? now : null
          }
        });
        for (const [i, v] of input.variants.entries()) {
          await tx.productVariant.create({ data: { ...variantData(input, i), productId: product.id, storeId: store.id, sku: v.sku ?? newSku(input.title), stock: v.stock } });
        }
        for (const [i, p] of input.photos.entries()) await tx.productImage.create({ data: photoData(product.id, i, p, uploaded) });
        await knownLowStock(tx, product.id, now);
        return product.id;
      })
    );
    return this.load(store, id);
  }

  /**
   * Saves the Edit product form. Refused if the product changed since the form was loaded
   * (another tab or person). Stock is applied as a difference to what the form showed;
   * variants that sold are hidden rather than deleted, so past orders keep their link.
   */
  async update(userId: string, productId: string, input: ProductInput): Promise<SellerProductView> {
    const { prisma } = this.deps;
    const store = await this.seller(userId, { write: true });
    if (input.version === undefined) throw badField("version", "Reload the product and try again.");
    const current = await prisma.product.findFirst({ where: { id: productId, storeId: store.id }, select: { status: true } });
    if (!current) throw notFound();
    if (current.status === "REMOVED") throw removedByVendora();
    if (input.intent === "draft" && current.status !== "DRAFT") {
      throw conflict("already_published", "A published product can't go back to being a draft. Turn off Active to hide it from shoppers.");
    }
    const categoryId = await this.leafCategory(input.category);
    this.checkDeal(input.dealEndsAt);
    const uploaded = await this.checkNewPhotos(userId, input);
    const now = this.now();

    const removedPhotos = await this.writing(() =>
      prisma.$transaction(async (tx) => {
        // Locks in one fixed order everywhere (store, then variants by id, then the product), so a
        // seller edit and a checkout touching the same rows wait for each other instead of deadlocking.
        await lockStore(tx, store.id);
        const variants = await tx.$queryRaw<{ id: string; stock: number; isActive: boolean }[]>`
          SELECT id, stock, "isActive" FROM product_variants WHERE "productId" = ${productId}::uuid ORDER BY id FOR UPDATE`;
        const [row] = await tx.$queryRaw<{ version: number; status: ProductStatus; title: string; publishedAt: Date | null }[]>`
          SELECT version, status, title, "publishedAt" FROM products WHERE id = ${productId}::uuid FOR UPDATE`;
        if (!row) throw notFound();
        if (row.version !== input.version) {
          throw conflict("stale", "This product was changed in another tab or by someone else. Reload to see the latest version, then make your changes again.");
        }
        if (row.status === "REMOVED") throw removedByVendora();

        // Variants: which rows the form still has.
        const active = new Map(variants.filter((v) => v.isActive).map((v) => [v.id, v.stock]));
        input.variants.forEach((v, i) => {
          if (v.id && !active.has(v.id)) throw badField(`variants.${i}.id`, "This variant was removed meanwhile. Reload and try again.");
        });
        const kept = new Set(input.variants.flatMap((v) => (v.id ? [v.id] : [])));
        const removed = [...active.keys()].filter((id) => !kept.has(id));
        if (removed.length) {
          const sold = new Set((await tx.orderItem.findMany({ where: { variantId: { in: removed } }, select: { variantId: true }, distinct: ["variantId"] })).map((o) => o.variantId));
          await tx.productVariant.updateMany({ where: { id: { in: removed.filter((id) => sold.has(id)) } }, data: { isActive: false } });
          await tx.productVariant.deleteMany({ where: { id: { in: removed.filter((id) => !sold.has(id)) } } }); // their cart lines go too
        }
        await this.checkFree(tx, store.id, input, uploaded);

        for (const [i, v] of input.variants.entries()) {
          const data = variantData(input, i);
          if (!v.id) {
            await tx.productVariant.create({ data: { ...data, productId, storeId: store.id, sku: v.sku ?? newSku(input.title), stock: v.stock } });
            continue;
          }
          // The change the seller made ("9 → 42" = +33) is added to what's there NOW, so sales meanwhile still count.
          const stockNow = active.get(v.id) ?? 0;
          const next = stockNow + (v.stock - (v.stockWas ?? v.stock));
          if (next < 0) {
            throw conflict("stock_changed", "Stock changed while you were editing.", {
              path: `variants.${i}.stock`,
              message: `Only ${stockNow} left now (some sold while you were editing). Check the stock and save again.`
            });
          }
          await tx.productVariant.update({ where: { id: v.id }, data: { ...data, stock: next, ...(v.sku ? { sku: v.sku } : {}) } });
        }

        // Photos: keep, reorder, add; the ones left out are deleted (their files after the commit).
        const images = await tx.productImage.findMany({ where: { productId }, select: { id: true, url: true, publicId: true } });
        const imageIds = new Set(images.map((img) => img.id));
        input.photos.forEach((p, i) => {
          if (p.id && !imageIds.has(p.id)) throw badField(`photos.${i}.id`, "This photo was removed meanwhile. Reload and try again.");
        });
        const keptPhotos = new Set(input.photos.flatMap((p) => (p.id ? [p.id] : [])));
        const gone = images.filter((img) => !keptPhotos.has(img.id));
        await tx.productImage.deleteMany({ where: { id: { in: gone.map((g) => g.id) } } });
        for (const [i, p] of input.photos.entries()) {
          if (p.id) await tx.productImage.update({ where: { id: p.id }, data: { sortOrder: i, alt: p.alt } });
          else await tx.productImage.create({ data: photoData(productId, i, p, uploaded) });
        }

        const status = statusFor(input);
        await tx.product.update({
          where: { id: productId },
          data: {
            title: input.title,
            ...(row.title !== input.title ? { slug: await uniqueSlug(tx, store.id, input.title, productId) } : {}),
            categoryId,
            description: input.description,
            specs: input.specs,
            variantLabel: input.variantLabel,
            expressAvailable: input.expressAvailable,
            lowStockAlert: input.lowStockAlert,
            status,
            version: { increment: 1 },
            ...(status === "ACTIVE" && !row.publishedAt ? { publishedAt: now } : {})
          }
        });
        await knownLowStock(tx, productId, now);
        return gone.flatMap((g) => (g.publicId ? [{ publicId: g.publicId, url: g.url }] : []));
      })
    );
    await this.discardPhotos(removedPhotos);
    return this.load(store, productId);
  }

  /** Only a product that never sold can be deleted (orders point at it); others are hidden with the Active toggle. */
  async remove(userId: string, productId: string): Promise<{ id: string; deleted: true }> {
    const { prisma } = this.deps;
    const store = await this.seller(userId, { write: true });
    const files = await prisma.$transaction(async (tx) => {
      await lockStore(tx, store.id);
      // Lock the variants first, like checkout, so an order can't slip in between the check and the delete.
      await tx.$queryRaw`SELECT id FROM product_variants WHERE "productId" = ${productId}::uuid ORDER BY id FOR UPDATE`;
      const [p] = await tx.$queryRaw<{ status: ProductStatus }[]>`SELECT status FROM products WHERE id = ${productId}::uuid AND "storeId" = ${store.id}::uuid FOR UPDATE`;
      if (!p) throw notFound();
      if (p.status === "REMOVED") throw removedByVendora();
      if (await tx.orderItem.findFirst({ where: { productId }, select: { id: true } })) {
        throw conflict("has_orders", "This product has orders, so it can't be deleted. Turn off Active to hide it from shoppers.");
      }
      const images = await tx.productImage.findMany({ where: { productId, publicId: { not: null } }, select: { publicId: true, url: true } });
      await tx.product.delete({ where: { id: productId } }); // variants, photos, wishlist saves and cart lines go with it
      return images.flatMap((i) => (i.publicId ? [{ publicId: i.publicId, url: i.url }] : []));
    });
    await this.discardPhotos(files);
    return { id: productId, deleted: true };
  }

  /** Permission to upload one product photo (a seller's own folder; 120 an hour). */
  async uploadTicket(userId: string): Promise<UploadTicket> {
    await this.seller(userId, { write: true });
    return this.uploads.ticket(userId, "product_photo");
  }

  // --- rules --------------------------------------------------------------------

  /** Seller Center's door (access.ts): a submitted store, two-step verification on; suspended stores can't change anything. */
  private seller(userId: string, { write }: { write: boolean }): Promise<SellerStore> {
    return sellerStore(this.deps.prisma, userId, { write });
  }

  /** Products go in a sub-category ("Electronics › Headphones"), never a top-level one. */
  private async leafCategory(slug: string): Promise<string> {
    const category = await this.deps.prisma.category.findUnique({ where: { slug }, select: { id: true, _count: { select: { children: true } } } });
    if (!category) throw badField("category", "Choose a category");
    if (category._count.children > 0) throw badField("category", "Choose a more specific category, like Electronics › Headphones");
    return category.id;
  }

  private checkDeal(dealEndsAt: Date | null) {
    if (!dealEndsAt) return;
    const now = this.now().getTime();
    if (dealEndsAt.getTime() <= now) throw badField("dealEndsAt", "Choose a time in the future");
    if (dealEndsAt.getTime() > now + MAX_DEAL_DAYS * DAY_MS) throw badField("dealEndsAt", `A deal can run for up to ${MAX_DEAL_DAYS} days`);
  }

  /** Each NEW photo is checked with the storage service (one at a time: its API has an hourly limit). */
  private async checkNewPhotos(userId: string, input: ProductInput): Promise<Map<string, StoredMedia>> {
    const found = new Map<string, StoredMedia>();
    for (const [i, p] of input.photos.entries()) {
      if (p.publicId) found.set(p.publicId, await this.uploads.check(userId, "product_photo", p.publicId, `photos.${i}.publicId`));
    }
    return found;
  }

  /**
   * Clear messages for SKUs and photos already in use, checked inside the transaction (the
   * unique indexes are the final word; `writing` maps a race that still slips through).
   */
  private async checkFree(tx: Tx, storeId: string, input: ProductInput, uploaded: Map<string, StoredMedia>) {
    const skus = input.variants.flatMap((v, i) => (v.sku ? [{ sku: v.sku, i, id: v.id }] : []));
    if (skus.length) {
      const taken = await tx.productVariant.findMany({ where: { storeId, sku: { in: skus.map((s) => s.sku) } }, select: { id: true, sku: true } });
      for (const t of taken) {
        const mine = skus.find((s) => s.sku === t.sku);
        if (mine && mine.id !== t.id) throw badField(`variants.${mine.i}.sku`, "This SKU is already used in your store");
      }
    }
    if (uploaded.size) {
      const used = await tx.productImage.findFirst({ where: { publicId: { in: [...uploaded.keys()] } }, select: { publicId: true } });
      if (used) throw badField(`photos.${input.photos.findIndex((p) => p.publicId === used.publicId)}.publicId`, "This photo is already used. Upload it again.");
    }
  }

  /** A unique index that still refused the write (two saves at the same moment). */
  private async writing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict("already_used", "A SKU or photo in this product was just used elsewhere. Check them and save again.");
      throw err;
    }
  }

  /** Deletes removed photos from storage, except ones past orders still show (the order keeps the cover photo's link). */
  private async discardPhotos(files: { publicId: string; url: string }[]) {
    if (!files.length) return;
    const inOrders = new Set(
      (await this.deps.prisma.orderItem.findMany({ where: { imageUrl: { in: files.map((f) => f.url) } }, select: { imageUrl: true }, distinct: ["imageUrl"] })).map((o) => o.imageUrl)
    );
    for (const f of files) if (!inOrders.has(f.url)) await this.uploads.discard(f.publicId, "public");
  }

  /** Units of each variant in paid orders since `since` ("Sold (30d)"). */
  private async soldSince(variantIds: string[], since: Date): Promise<Map<string, number>> {
    if (!variantIds.length) return new Map();
    const rows = await this.deps.prisma.$queryRaw<{ variantId: string; n: number }[]>`
      SELECT oi."variantId", sum(oi.quantity)::int AS n
      FROM order_items oi
      JOIN seller_orders so ON so.id = oi."sellerOrderId" AND so.status IN ('PREPARING', 'SHIPPED', 'DELIVERED')
      JOIN orders o ON o.id = so."orderId" AND o."placedAt" >= ${since}
      WHERE oi."variantId" = ANY(${variantIds}::uuid[])
      GROUP BY oi."variantId"`;
    return new Map(rows.map((r) => [r.variantId, r.n]));
  }

  private async load(store: SellerStore, productId: string): Promise<SellerProductView> {
    const { prisma } = this.deps;
    const [p, sold] = await Promise.all([
      prisma.product.findFirst({
        where: { id: productId, storeId: store.id },
        include: {
          category: { include: { parent: true } },
          images: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] },
          variants: { where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }] }
        }
      }),
      prisma.orderItem.findFirst({ where: { productId }, select: { id: true } })
    ]);
    if (!p) throw notFound();
    const now = this.now();
    // A deal that already ended shows as what shoppers pay now: the regular price, nothing crossed out.
    const priced = p.variants.map((v) => ({ v, pricing: variantPricing(v, now) }));
    return {
      id: p.id,
      slug: p.slug,
      status: STATUS_NAME[p.status],
      version: p.version,
      title: p.title,
      category: { slug: p.category.slug, name: p.category.name, parent: p.category.parent ? { slug: p.category.parent.slug, name: p.category.parent.name } : null },
      description: p.description,
      variantLabel: p.variantLabel,
      variants: priced.map(({ v, pricing }) => ({ id: v.id, name: v.name, sku: v.sku, priceCentavos: pricing.priceCentavos, compareAtCentavos: pricing.compareAtCentavos, stock: v.stock })),
      dealEndsAt: priced.flatMap(({ pricing }) => (pricing.saleEndsAt ? [pricing.saleEndsAt.toISOString()] : [])).sort()[0] ?? null,
      photos: p.images.map((i) => ({ id: i.id, url: i.url, alt: i.alt })),
      specs: readSpecs(p.specs),
      weightGrams: p.variants[0]?.weightGrams ?? null,
      shipsFrom: store.shipsFrom,
      active: p.status !== "ARCHIVED",
      expressAvailable: p.expressAvailable,
      lowStockAlert: p.lowStockAlert,
      visibleToShoppers: p.status === "ACTIVE" && store.status === "APPROVED" && p.variants.length > 0,
      removal: p.status === "REMOVED" ? { at: p.removedAt?.toISOString() ?? null, reason: p.removedReason } : null,
      canDelete: sold === null && p.status !== "REMOVED",
      publishedAt: p.publishedAt?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString()
    };
  }
}

/** Save draft keeps it a draft; Publish makes it Active, or Inactive when the toggle is off. */
const statusFor = (input: ProductInput): ProductStatus => (input.intent === "draft" ? "DRAFT" : input.active ? "ACTIVE" : "ARCHIVED");

/** The fields every variant row gets from the form (the deal end and weight are set once for the product). */
function variantData(input: ProductInput, i: number) {
  const v = input.variants[i];
  if (!v) throw new Error(`no variant ${i}`);
  return {
    name: v.name,
    priceCentavos: v.priceCentavos,
    compareAtCentavos: v.compareAtCentavos,
    saleEndsAt: v.compareAtCentavos !== null ? input.dealEndsAt : null,
    weightGrams: input.weightGrams,
    sortOrder: i
  };
}

function photoData(productId: string, sortOrder: number, photo: ProductInput["photos"][number], uploaded: Map<string, StoredMedia>) {
  const media = photo.publicId ? uploaded.get(photo.publicId) : undefined;
  if (!media?.url) throw new Error("a new photo wasn't checked");
  return { productId, url: media.url, publicId: media.publicId, alt: photo.alt, sortOrder };
}

async function lockStore(tx: Tx, storeId: string) {
  await tx.$queryRaw`SELECT 1 FROM stores WHERE id = ${storeId}::uuid FOR UPDATE`;
}

/**
 * The seller just saved this product and saw its stock in the form, so a variant that's below
 * 10 isn't news: no low-stock email about it (until it's restocked and drops again).
 */
async function knownLowStock(tx: Tx, productId: string, now: Date) {
  await tx.productVariant.updateMany({ where: { productId, stock: { lt: SELLER_LOW_STOCK }, lowStockAlertedAt: null }, data: { lowStockAlertedAt: now } });
}

/** "AuraSound Pro Wireless Headphones" → "aurasound-pro-wireless-headphones", then "-2", "-3"… if the store already has it. */
async function uniqueSlug(tx: Tx, storeId: string, title: string, exceptId?: string): Promise<string> {
  const base = slugify(title, 80) || "product";
  const taken = new Set(
    (await tx.product.findMany({ where: { storeId, slug: { startsWith: base }, ...(exceptId ? { NOT: { id: exceptId } } : {}) }, select: { slug: true } })).map((p) => p.slug)
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** A made-up SKU when the seller leaves it empty: "AURA-SOUN-7KQ2XD" (letters from the title + 6 random characters). */
const SKU_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
function newSku(title: string): string {
  const words = slugify(title, 80).split("-").filter(Boolean).slice(0, 2).map((w) => w.slice(0, 4).toUpperCase());
  const random = Array.from({ length: 6 }, () => SKU_ALPHABET[randomInt(SKU_ALPHABET.length)]).join("");
  return [...(words.length ? words : ["VD"]), random].join("-");
}
