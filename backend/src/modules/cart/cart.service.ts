import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { DELIVERY } from "../../lib/delivery.js";
import { AppError } from "../../lib/errors.js";
import { variantPricing } from "../catalog/pricing.js";
import { stockStatus, type StockStatus } from "../catalog/stock.js";
import { CART_MAX_LINES, CART_MAX_QUANTITY, type CartItemInput } from "./cart.schemas.js";

/** Why a line can't be bought as it is. Checkout needs every line without one. */
export type LineIssue = "unavailable" | "out_of_stock" | "not_enough_stock";

export interface CartLine {
  variantId: string;
  productId: string;
  slug: string;
  title: string;
  variantName: string;
  image: { url: string; alt: string | null } | null;
  quantity: number;
  /** Today's price, after deal rules (what checkout will charge). */
  unitPriceCentavos: number;
  compareAtCentavos: number | null;
  saleEndsAt: string | null;
  lineTotalCentavos: number;
  stock: StockStatus;
  /** The most the quantity box allows: what's left, up to 99. */
  maxQuantity: number;
  /** "Price changed since you added it: ₱2,999 → ₱2,499". */
  priceChange: { fromCentavos: number; toCentavos: number } | null;
  issue: LineIssue | null;
}

export interface CartGroup {
  /** One package per store, each with its own delivery fee. */
  store: { slug: string; name: string };
  items: CartLine[];
  subtotalCentavos: number;
  /** Standard delivery for this store's package (Express is chosen at checkout). */
  deliveryCentavos: number;
  /** "Add ₱X more from this store for free delivery". */
  freeDelivery: { thresholdCentavos: number; qualifies: boolean; remainingCentavos: number };
}

export interface CartView {
  groups: CartGroup[];
  summary: {
    itemCount: number;
    subtotalCentavos: number;
    /** "You saved ₱3,300": crossed-out prices minus today's prices. */
    savingsCentavos: number;
    deliveryCentavos: number;
    totalCentavos: number;
    /** Lines that need attention (removed product, sold out, not enough left). */
    issueCount: number;
    canCheckout: boolean;
  };
}

export interface MergeResult {
  added: number;
  /** Fewer than asked, because of stock or the 99 limit. */
  adjusted: { variantId: string; quantity: number }[];
  skipped: { variantId: string; reason: "unavailable" | "sold_out" | "cart_full" }[];
}

interface StoredLine {
  variantId: string;
  quantity: number;
  priceAtAddCentavos: number | null;
  addedAt: Date;
}

/** A variant that can be bought: active, its product active and its store approved. */
const forSale = (id: string) => ({ id, isActive: true, product: { status: "ACTIVE", store: { status: "APPROVED" } } }) satisfies Prisma.ProductVariantWhereInput;

const unavailable = () => new AppError(404, "NOT_FOUND", "This item isn't available.");
const onlyLeft = (left: number, inCart: number) =>
  new AppError(409, "CONFLICT", inCart > 0 ? `Only ${left} left, and ${inCart} ${inCart === 1 ? "is" : "are"} already in your cart.` : `Only ${left} left.`, { details: { left, inCart } });

/**
 * The cart. Stock isn't held while items sit in a cart (that happens when the order is
 * placed); the cart just tells the truth about today's prices and stock. Changes to one
 * shopper's cart run one at a time (the cart row is locked), so two tabs can't overfill it.
 */
export class CartService {
  constructor(private readonly deps: { prisma: PrismaClient; now?: () => Date }) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  async get(userId: string): Promise<CartView> {
    const lines = await this.deps.prisma.cartItem.findMany({ where: { cart: { userId } }, select: { variantId: true, quantity: true, priceAtAddCentavos: true, addedAt: true } });
    return this.build(lines);
  }

  /** A guest's browser cart, shown with the same rules (nothing is saved). */
  preview(items: CartItemInput[]): Promise<CartView> {
    const start = this.now().getTime();
    const merged = mergeDuplicates(items);
    return this.build(merged.map((i, n) => ({ ...i, quantity: Math.min(i.quantity, CART_MAX_QUANTITY), priceAtAddCentavos: null, addedAt: new Date(start - n) })));
  }

  /** "Add to cart": adds to the quantity already there. */
  async add(userId: string, variantId: string, quantity: number): Promise<CartView> {
    await this.mutate(userId, async (tx, cartId) => {
      const variant = await tx.productVariant.findFirst({ where: forSale(variantId) });
      if (!variant) throw unavailable();
      if (variant.stock <= 0) throw new AppError(409, "CONFLICT", "This item is sold out.");
      const existing = await tx.cartItem.findUnique({ where: { cartId_variantId: { cartId, variantId } } });
      if (!existing && (await tx.cartItem.count({ where: { cartId } })) >= CART_MAX_LINES) {
        throw new AppError(409, "CONFLICT", `Your cart is full (${CART_MAX_LINES} different items). Check out or remove something first.`);
      }
      const inCart = existing?.quantity ?? 0;
      const next = inCart + quantity;
      if (next > CART_MAX_QUANTITY) throw new AppError(409, "CONFLICT", `You can buy up to ${CART_MAX_QUANTITY} of one item.`, { details: { inCart } });
      if (next > variant.stock) throw onlyLeft(variant.stock, inCart);
      const price = variantPricing(variant, this.now()).priceCentavos;
      await tx.cartItem.upsert({
        where: { cartId_variantId: { cartId, variantId } },
        create: { cartId, variantId, quantity: next, priceAtAddCentavos: price },
        update: { quantity: next, priceAtAddCentavos: price }
      });
    });
    return this.get(userId);
  }

  /** The quantity box. Also clears a "price changed" note: the shopper has now seen today's price. */
  async setQuantity(userId: string, variantId: string, quantity: number): Promise<CartView> {
    await this.mutate(userId, async (tx, cartId) => {
      if (!(await tx.cartItem.findUnique({ where: { cartId_variantId: { cartId, variantId } } }))) throw new AppError(404, "NOT_FOUND", "This item isn't in your cart.");
      const variant = await tx.productVariant.findFirst({ where: forSale(variantId) });
      if (!variant) throw new AppError(409, "CONFLICT", "This item is no longer available. Remove it from your cart.");
      if (quantity > variant.stock) throw onlyLeft(variant.stock, 0);
      const price = variantPricing(variant, this.now()).priceCentavos;
      await tx.cartItem.update({ where: { cartId_variantId: { cartId, variantId } }, data: { quantity, priceAtAddCentavos: price } });
    });
    return this.get(userId);
  }

  /** Remove a line (removing twice is fine). */
  async remove(userId: string, variantId: string): Promise<CartView> {
    await this.deps.prisma.cartItem.deleteMany({ where: { variantId, cart: { userId } } });
    return this.get(userId);
  }

  /**
   * Sign-in: the guest's browser cart joins the account cart. Quantities add up, capped by
   * stock and 99; items that can't be bought are skipped and reported, never an error, so
   * signing in always works.
   */
  async merge(userId: string, items: CartItemInput[]): Promise<{ cart: CartView; merge: MergeResult }> {
    const result: MergeResult = { added: 0, adjusted: [], skipped: [] };
    await this.mutate(userId, async (tx, cartId) => {
      let lines = await tx.cartItem.count({ where: { cartId } });
      for (const item of mergeDuplicates(items)) {
        const variant = await tx.productVariant.findFirst({ where: forSale(item.variantId) });
        if (!variant) {
          result.skipped.push({ variantId: item.variantId, reason: "unavailable" });
          continue;
        }
        if (variant.stock <= 0) {
          result.skipped.push({ variantId: item.variantId, reason: "sold_out" });
          continue;
        }
        const key = { cartId_variantId: { cartId, variantId: item.variantId } };
        const existing = await tx.cartItem.findUnique({ where: key });
        if (!existing && lines >= CART_MAX_LINES) {
          result.skipped.push({ variantId: item.variantId, reason: "cart_full" });
          continue;
        }
        const wanted = (existing?.quantity ?? 0) + item.quantity;
        const target = Math.min(wanted, variant.stock, CART_MAX_QUANTITY);
        if (target < wanted) result.adjusted.push({ variantId: item.variantId, quantity: target });
        if (existing && target <= existing.quantity) continue;
        const price = variantPricing(variant, this.now()).priceCentavos;
        await tx.cartItem.upsert({ where: key, create: { cartId, variantId: item.variantId, quantity: target, priceAtAddCentavos: price }, update: { quantity: target } });
        if (!existing) lines++;
        result.added++;
      }
    });
    return { cart: await this.get(userId), merge: result };
  }

  /** Runs a change with this shopper's cart row locked (created on first use). */
  private async mutate(userId: string, change: (tx: Prisma.TransactionClient, cartId: string) => Promise<void>) {
    const { prisma } = this.deps;
    await prisma.cart.createMany({ data: [{ userId }], skipDuplicates: true });
    await prisma.$transaction(async (tx) => {
      const [cart] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM carts WHERE "userId" = ${userId}::uuid FOR UPDATE`;
      if (!cart) throw new Error("cart row missing after create");
      await change(tx, cart.id);
      await tx.cart.update({ where: { id: cart.id }, data: { updatedAt: new Date() } });
    });
  }

  /** Today's prices and stock for the lines, grouped into one package per store. */
  private async build(stored: StoredLine[]): Promise<CartView> {
    const now = this.now();
    const variants = await this.deps.prisma.productVariant.findMany({
      where: { id: { in: stored.map((l) => l.variantId) } },
      include: {
        product: {
          select: { id: true, slug: true, title: true, status: true, store: { select: { slug: true, name: true, status: true } }, images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true, alt: true } } }
        }
      }
    });
    const byId = new Map(variants.map((v) => [v.id, v]));
    const groups = new Map<string, CartGroup>();

    for (const line of [...stored].sort((a, b) => b.addedAt.getTime() - a.addedAt.getTime())) {
      const v = byId.get(line.variantId);
      if (!v) continue; // the variant was deleted (its cart lines go with it)
      const { product } = v;
      const pricing = variantPricing(v, now);
      const visible = v.isActive && product.status === "ACTIVE" && product.store.status === "APPROVED";
      const issue: LineIssue | null = !visible ? "unavailable" : v.stock <= 0 ? "out_of_stock" : line.quantity > v.stock ? "not_enough_stock" : null;
      const priceChange =
        visible && line.priceAtAddCentavos !== null && line.priceAtAddCentavos !== pricing.priceCentavos ? { fromCentavos: line.priceAtAddCentavos, toCentavos: pricing.priceCentavos } : null;

      const group = groups.get(product.store.slug) ?? newGroup(product.store);
      groups.set(product.store.slug, group);
      group.items.push({
        variantId: v.id,
        productId: product.id,
        slug: product.slug,
        title: product.title,
        variantName: v.name,
        image: product.images[0] ?? null,
        quantity: line.quantity,
        unitPriceCentavos: pricing.priceCentavos,
        compareAtCentavos: pricing.compareAtCentavos,
        saleEndsAt: pricing.saleEndsAt?.toISOString() ?? null,
        lineTotalCentavos: pricing.priceCentavos * line.quantity,
        stock: stockStatus(visible ? v.stock : 0),
        maxQuantity: visible ? Math.max(0, Math.min(v.stock, CART_MAX_QUANTITY)) : 0,
        priceChange,
        issue
      });
    }

    let itemCount = 0;
    let savings = 0;
    let issueCount = 0;
    for (const group of groups.values()) {
      for (const item of group.items) {
        if (item.issue) {
          issueCount++;
          continue;
        }
        itemCount += item.quantity;
        group.subtotalCentavos += item.lineTotalCentavos;
        if (item.compareAtCentavos !== null) savings += (item.compareAtCentavos - item.unitPriceCentavos) * item.quantity;
      }
      const qualifies = group.subtotalCentavos >= DELIVERY.freeThresholdCentavos;
      group.deliveryCentavos = group.subtotalCentavos === 0 || qualifies ? 0 : DELIVERY.standardFeeCentavos;
      group.freeDelivery = { thresholdCentavos: DELIVERY.freeThresholdCentavos, qualifies, remainingCentavos: Math.max(0, DELIVERY.freeThresholdCentavos - group.subtotalCentavos) };
    }

    const list = [...groups.values()];
    const subtotal = list.reduce((sum, g) => sum + g.subtotalCentavos, 0);
    const delivery = list.reduce((sum, g) => sum + g.deliveryCentavos, 0);
    return {
      groups: list,
      summary: {
        itemCount,
        subtotalCentavos: subtotal,
        savingsCentavos: savings,
        deliveryCentavos: delivery,
        totalCentavos: subtotal + delivery,
        issueCount,
        canCheckout: itemCount > 0 && issueCount === 0
      }
    };
  }
}

function newGroup(store: { slug: string; name: string }): CartGroup {
  return {
    store: { slug: store.slug, name: store.name },
    items: [],
    subtotalCentavos: 0,
    deliveryCentavos: 0,
    freeDelivery: { thresholdCentavos: DELIVERY.freeThresholdCentavos, qualifies: false, remainingCentavos: DELIVERY.freeThresholdCentavos }
  };
}

/** The same item listed twice counts once, with the quantities added. */
function mergeDuplicates(items: CartItemInput[]): CartItemInput[] {
  const out = new Map<string, number>();
  for (const i of items) out.set(i.variantId, (out.get(i.variantId) ?? 0) + i.quantity);
  return [...out].map(([variantId, quantity]) => ({ variantId, quantity }));
}
