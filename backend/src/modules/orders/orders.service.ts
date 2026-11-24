import type { DeliveryOption, Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { BackgroundMailer } from "../../lib/backgroundMailer.js";
import { DELIVERY } from "../../lib/delivery.js";
import type { EmailSender } from "../../lib/email.js";
import { AppError } from "../../lib/errors.js";
import { platformFeeCentavos } from "../../lib/fees.js";
import type { KeyValueStore } from "../../lib/kv.js";
import { likeLiteral } from "../../lib/like.js";
import type { Logger } from "../../lib/logger.js";
import type { CheckoutState, OnlineMethod, PaidPayment, PaymentGateway, WebhookEvent } from "../../lib/paymongo.js";
import { readSession } from "../../lib/paymongo.js";
import { isUniqueViolation } from "../../lib/prismaErrors.js";
import type { CartService, CartView } from "../cart/cart.service.js";
import { newOrderEmail } from "../seller/seller.emails.js";
import { buyerCancelMessage } from "./cancelReasons.js";
import type { CancellationService } from "./cancellation.js";
import { AUTO_CONFIRM_DAYS, autoConfirmAt, buyerCancelUntil, shipByFor } from "./deadlines.js";
import { orderConfirmedEmail } from "./orders.emails.js";
import { recordRefund, type RefundService } from "./refunds.js";
import {
  COD_MAX_OPEN_ORDERS,
  COD_MAX_TOTAL_CENTAVOS,
  ORDERS_PAGE_SIZE,
  PAYMENT_METHODS,
  PAYMENT_WINDOW_MINUTES,
  type OrderListQuery,
  type PaymentMethodChoice,
  type PlaceOrderInput,
  type SummaryInput
} from "./orders.schemas.js";

const MINUTE = 60 * 1000;
/** PayMongo refuses to expire a session while a payment is processing: wait this much longer... */
const BUSY_EXTENSION_MS = 5 * MINUTE;
/** ...but never keep stock held longer than this; a payment after that is handled as a late payment. */
const MAX_HOLD_MS = 45 * MINUTE;
/** The waiting page polls; ask PayMongo at most this often per order. */
const SYNC_EVERY_SECONDS = 5;

const ONLINE: readonly OnlineMethod[] = ["GCASH", "MAYA", "CARD"];
const isOnline = (m: PaymentMethodChoice): m is OnlineMethod => (ONLINE as readonly string[]).includes(m);
const orderNumber = (n: number) => `VD-${n}`;
const notFound = () => new AppError(404, "NOT_FOUND", "This order doesn't exist.");
const paymentsUnavailable = () =>
  new AppError(503, "SERVICE_UNAVAILABLE", "Online payment is unavailable right now. Try again in a few minutes, or choose cash on delivery.");

export interface PackageQuote {
  store: { slug: string; name: string };
  items: CartView["groups"][number]["items"];
  subtotalCentavos: number;
  delivery: {
    option: DeliveryOption;
    feeCentavos: number;
    days: { min: number; max: number };
    /** Express is offered only when every item in the package allows it (a seller setting per product). */
    options: { option: DeliveryOption; feeCentavos: number; days: { min: number; max: number }; available: boolean }[];
  };
}

export interface OrderView {
  id: string;
  /** "VD-21458" */
  number: string;
  status: "PENDING_PAYMENT" | "PLACED" | "COMPLETED" | "CANCELLED";
  createdAt: string;
  placedAt: string | null;
  cancelledAt: string | null;
  /** "Cancel order" on the tracking page: paid less than an hour ago and something hasn't shipped yet. */
  canCancel: boolean;
  /** Until when the buyer can cancel (an hour after paying); null when they can't. */
  cancelUntil: string | null;
  payment: {
    method: PaymentMethodChoice;
    status: string;
    /** Online and still unpaid: PayMongo's page ("Continue to payment"). */
    checkoutUrl: string | null;
    /** Online and still unpaid: when the 15-minute window closes. */
    expiresAt: string | null;
    paidAt: string | null;
  };
  packages: {
    id: string;
    /** The seller card on the tracking page. */
    store: { slug: string; name: string; logoUrl: string | null; rating: { avg: number; count: number } };
    status: string;
    deliveryOption: DeliveryOption;
    deliveryDays: { min: number; max: number };
    subtotalCentavos: number;
    deliveryCentavos: number;
    /** Set by the seller when shipping (milestone 6): "LBC", "8841 2201". */
    courier: string | null;
    trackingNumber: string | null;
    shipBy: string | null;
    shippedAt: string | null;
    deliveredAt: string | null;
    cancelledAt: string | null;
    /** "Order received": shown while the package is shipped. */
    canConfirmReceived: boolean;
    /** While shipped: "We'll confirm it automatically on Nov 30". */
    autoConfirmAt: string | null;
    /** Who confirmed the delivery (null before milestone 6c and until delivered). */
    deliveryConfirmedBy: "buyer" | "auto" | null;
    /** A paid package that was cancelled: by whom and why ("Cancelled by the seller · out of stock"). */
    cancellation: { by: "seller" | "buyer" | "system"; reason: string; message: string } | null;
    /** The money for a cancelled package: processing (PayMongo hasn't taken it yet), sent, or delayed (being refunded by hand). */
    refund: { amountCentavos: number; status: "processing" | "sent" | "delayed"; sentAt: string | null } | null;
    /** "Arrives Nov 24 – Nov 27": the delivery promise counted from the paid date, while it's on its way. */
    estimatedDelivery: DeliveryEstimate | null;
    /** The tracking stepper: Ordered → Preparing → Shipped → Delivered, with when each was reached. */
    steps: { step: TrackingStep; at: string | null }[];
    /** The timeline, newest first. */
    events: TrackingEvent[];
    items: {
      /** The order item: what a review is written for. */
      id: string;
      productId: string;
      variantId: string;
      title: string;
      variantName: string;
      imageUrl: string | null;
      unitPriceCentavos: number;
      quantity: number;
      lineTotalCentavos: number;
      review: { id: string; rating: number; title: string | null; body: string | null; status: string; createdAt: string; updatedAt: string } | null;
      /** "Write a review": delivered and not reviewed yet. */
      canReview: boolean;
    }[];
  }[];
  itemCount: number;
  totals: { subtotalCentavos: number; deliveryCentavos: number; discountCentavos: number; totalCentavos: number };
  address: unknown;
}

export type TrackingStep = "ORDERED" | "PREPARING" | "SHIPPED" | "DELIVERED";
export interface DeliveryEstimate {
  earliest: string;
  latest: string;
}
export interface TrackingEvent {
  type: "placed" | "shipped" | "update" | "delivered" | "cancelled" | "refund";
  message: string;
  location: string | null;
  at: string;
}

/** One card on "Your orders". */
export interface OrderSummary {
  id: string;
  number: string;
  status: OrderView["status"];
  createdAt: string;
  placedAt: string | null;
  cancelledAt: string | null;
  paymentMethod: PaymentMethodChoice;
  totalCentavos: number;
  itemCount: number;
  packages: {
    id: string;
    store: { slug: string; name: string };
    status: string;
    itemCount: number;
    /** The first items ("AuraSound Pro Wireless Headphones + 1 more") and their thumbnails. */
    items: { title: string; variantName: string; imageUrl: string | null; quantity: number }[];
    moreItems: number;
    estimatedDelivery: DeliveryEstimate | null;
    courier: string | null;
    trackingNumber: string | null;
    shippedAt: string | null;
    deliveredAt: string | null;
    /** "Order received": shown while the package is shipped. */
    canConfirmReceived: boolean;
    /** Items delivered and not reviewed yet ("Write a review" shows when > 0). */
    reviewableItems: number;
  }[];
}

export interface NextAction {
  /** Send the shopper to PayMongo's page. */
  type: "redirect";
  url: string;
}

type Tx = Prisma.TransactionClient;
type Line = { variantId: string; quantity: number };

const daysFor = (option: DeliveryOption) => (option === "EXPRESS" ? DELIVERY.expressDays : DELIVERY.standardDays);
const DAY_MS = 24 * 60 * MINUTE;
/** How many first items an order card shows per package. */
const CARD_ITEMS = 3;
const METHOD_NAME: Record<PaymentMethodChoice, string> = { GCASH: "GCash", MAYA: "Maya", CARD: "card", COD: "cash on delivery" };

/** The same "2–5 days" promise as checkout, as dates counted from when the order was paid; only while it's on its way. */
function estimateDelivery(placedAt: Date | null, option: DeliveryOption, status: string): DeliveryEstimate | null {
  if (!placedAt || (status !== "PREPARING" && status !== "SHIPPED")) return null;
  const days = daysFor(option);
  return { earliest: new Date(placedAt.getTime() + days.min * DAY_MS).toISOString(), latest: new Date(placedAt.getTime() + days.max * DAY_MS).toISOString() };
}

/** "Your orders" tabs: an order shows in a tab when at least one of its packages is in that state. */
const TAB_WHERE: Record<OrderListQuery["tab"], Prisma.OrderWhereInput> = {
  all: {},
  to_ship: { sellerOrders: { some: { status: "PREPARING" } } },
  on_the_way: { sellerOrders: { some: { status: "SHIPPED" } } },
  delivered: { sellerOrders: { some: { status: "DELIVERED" } } }
};

/** "VD-21458", "#VD-21458" or "21458" finds that order; any text also matches the names of the products bought. */
function searchOrders(q: string): Prisma.OrderWhereInput {
  const number = /^#?\s*(?:vd\s*-?\s*)?(\d{1,9})$/i.exec(q)?.[1];
  const byProduct: Prisma.OrderWhereInput = { sellerOrders: { some: { items: { some: { productTitle: { contains: likeLiteral(q), mode: "insensitive" } } } } } };
  return number ? { OR: [{ orderNumber: Number(number) }, byProduct] } : byProduct;
}

/**
 * Delivery per store for the cart as it is, with the shopper's Standard/Express choices.
 * Express asked for a package that can't go Express (an item's seller doesn't offer it) is
 * quoted as Standard and listed in `expressRefused`: the checkout page just shows Standard,
 * while "Place order" refuses, so nobody pays for a delivery they didn't pick.
 */
export function quote(cart: CartView, choices: Record<string, "STANDARD" | "EXPRESS">) {
  const expressRefused: { slug: string; name: string }[] = [];
  const packages: PackageQuote[] = cart.groups
    .filter((g) => g.subtotalCentavos > 0)
    .map((g) => {
      const standard = g.freeDelivery.qualifies ? 0 : DELIVERY.standardFeeCentavos;
      const wanted: DeliveryOption = choices[g.store.slug] ?? "STANDARD";
      if (wanted === "EXPRESS" && !g.expressAvailable) expressRefused.push(g.store);
      const option: DeliveryOption = wanted === "EXPRESS" && !g.expressAvailable ? "STANDARD" : wanted;
      const options = [
        { option: "STANDARD" as const, feeCentavos: standard, days: DELIVERY.standardDays, available: true },
        { option: "EXPRESS" as const, feeCentavos: DELIVERY.expressFeeCentavos, days: DELIVERY.expressDays, available: g.expressAvailable }
      ];
      const chosen = options.find((o) => o.option === option) ?? options[0];
      return {
        store: g.store,
        items: g.items.filter((i) => !i.issue),
        subtotalCentavos: g.subtotalCentavos,
        delivery: { option, feeCentavos: chosen?.feeCentavos ?? standard, days: chosen?.days ?? DELIVERY.standardDays, options }
      };
    });
  const subtotal = packages.reduce((s, p) => s + p.subtotalCentavos, 0);
  const delivery = packages.reduce((s, p) => s + p.delivery.feeCentavos, 0);
  return {
    packages,
    totals: { subtotalCentavos: subtotal, deliveryCentavos: delivery, discountCentavos: 0, totalCentavos: subtotal + delivery, savingsCentavos: cart.summary.savingsCentavos },
    expressRefused
  };
}

/**
 * Checkout, orders and payments.
 *
 * Placing an order takes the stock (all of it or none, rows locked in a fixed order so two
 * checkouts can't deadlock) and copies prices, items and the address into the order. Online
 * payment then happens on PayMongo's page. Whichever arrives first, the shopper coming back
 * or PayMongo's webhook, runs the same `settle` step, which is idempotent: a payment is
 * counted once, however many times it's reported.
 */
export class OrderService {
  private readonly mailer: BackgroundMailer;

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      cart: CartService;
      /** null = online payments off (no PayMongo key); cash on delivery still works. */
      gateway: PaymentGateway | null;
      email: EmailSender;
      kv: KeyValueStore;
      appUrl: string;
      /** Sends refunds (and retries them); the order code only records them. */
      refunds: RefundService;
      /** The buyer's "Cancel order" on a paid order (within the hour). */
      cancellation: CancellationService;
      logger?: Logger;
      now?: () => Date;
    }
  ) {
    this.mailer = new BackgroundMailer(deps.email, deps.logger);
  }

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  async drain(): Promise<void> {
    await this.mailer.drain();
  }

  // --- checkout page ----------------------------------------------------------------

  /** The checkout page: packages with delivery choices, the address, payment methods and totals. Saves nothing. */
  async summary(userId: string, input: SummaryInput) {
    const { prisma } = this.deps;
    const [cart, addresses, openCod] = await Promise.all([
      this.deps.cart.get(userId),
      prisma.address.findMany({ where: { userId }, orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }] }),
      this.openCodOrders(prisma, userId)
    ]);
    const address = input.addressId ? addresses.find((a) => a.id === input.addressId) : addresses[0];
    if (input.addressId && !address) throw new AppError(404, "NOT_FOUND", "This address doesn't exist.");
    const q = quote(cart, input.delivery);

    const blockers: string[] = [];
    if (cart.summary.itemCount === 0 && cart.summary.issueCount === 0) blockers.push("cart_empty");
    if (cart.summary.issueCount > 0) blockers.push("cart_issues");
    if (!address) blockers.push("no_address");

    return {
      packages: q.packages,
      address: address ?? null,
      paymentMethods: this.methods(q.totals.totalCentavos, openCod),
      totals: q.totals,
      canPlaceOrder: blockers.length === 0,
      blockers
    };
  }

  private methods(total: number, openCod: number) {
    return PAYMENT_METHODS.map((method) => {
      if (method === "COD") {
        if (total > COD_MAX_TOTAL_CENTAVOS) return { method, available: false, reason: "Not available for orders over ₱5,000" };
        if (openCod >= COD_MAX_OPEN_ORDERS) return { method, available: false, reason: `You already have ${COD_MAX_OPEN_ORDERS} cash-on-delivery orders on the way` };
        return { method, available: true, reason: null };
      }
      return this.deps.gateway ? { method, available: true, reason: null } : { method, available: false, reason: "Online payment is unavailable right now" };
    });
  }

  /** Cash-on-delivery orders placed and not yet delivered. */
  private openCodOrders(db: PrismaClient | Tx, userId: string) {
    return db.order.count({ where: { userId, status: "PLACED", payments: { some: { method: "COD", status: "PENDING" } } } });
  }

  private codRefusal(total: number, openCod: number): AppError | null {
    if (total > COD_MAX_TOTAL_CENTAVOS) return new AppError(409, "CONFLICT", "Cash on delivery is only available for orders up to ₱5,000.", { details: { reason: "cod_over_limit" } });
    if (openCod >= COD_MAX_OPEN_ORDERS) {
      return new AppError(409, "CONFLICT", `You already have ${COD_MAX_OPEN_ORDERS} cash-on-delivery orders on the way. Please pay online for this one.`, { details: { reason: "cod_too_many" } });
    }
    return null;
  }

  // --- place order ------------------------------------------------------------------

  /**
   * "Place order". The same Idempotency-Key always returns the same order (double clicks,
   * retries after a timeout), enforced by a unique index, not just a lookup.
   */
  async place(userId: string, idempotencyKey: string, input: PlaceOrderInput): Promise<{ order: OrderView; nextAction: NextAction | null; replayed: boolean }> {
    const { prisma } = this.deps;
    const existing = await prisma.order.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } }, select: { id: true } });
    if (existing) return { ...(await this.resume(existing.id)), replayed: true };

    const [cart, address, user] = await Promise.all([
      this.deps.cart.get(userId),
      prisma.address.findFirst({ where: { id: input.addressId, userId } }),
      prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true, email: true } })
    ]);
    if (!address) throw new AppError(404, "NOT_FOUND", "This address doesn't exist.");
    if (!cart.summary.canCheckout) {
      const empty = cart.summary.itemCount === 0 && cart.summary.issueCount === 0;
      throw new AppError(409, "CONFLICT", empty ? "Your cart is empty." : "Some items in your cart need attention first.", { details: { reason: empty ? "cart_empty" : "cart_issues" } });
    }
    const q = quote(cart, input.delivery);
    const [refused] = q.expressRefused;
    if (refused) {
      throw new AppError(409, "CONFLICT", `Express delivery isn't available for the items from ${refused.name}. Choose Standard delivery.`, {
        details: { reason: "express_unavailable", store: refused.slug },
        fields: [{ path: `delivery.${refused.slug}`, message: "Express delivery isn't available for these items" }]
      });
    }
    if (q.totals.totalCentavos !== input.expectedTotalCentavos) {
      throw new AppError(409, "CONFLICT", "Prices or delivery changed since you looked. Please check your order again.", {
        details: { reason: "total_changed", totalCentavos: q.totals.totalCentavos }
      });
    }
    const method = input.paymentMethod;
    if (isOnline(method) && !this.deps.gateway) throw paymentsUnavailable();

    const now = this.now();
    let orderId: string;
    try {
      orderId = await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${userId}::uuid FOR UPDATE`; // one checkout at a time per shopper
          if (method === "COD") {
            const refusal = this.codRefusal(q.totals.totalCentavos, await this.openCodOrders(tx, userId));
            if (refusal) throw refusal;
          }
          const lines = q.packages.flatMap((p) => p.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })));
          const short = await takeStock(tx, lines);
          if (short) throw new AppError(409, "CONFLICT", `Only ${short.left} left of ${short.title}. Please update your cart.`, { details: { reason: "out_of_stock", variantId: short.variantId, left: short.left } });

          const stores = await tx.store.findMany({ where: { slug: { in: q.packages.map((p) => p.store.slug) } }, select: { id: true, slug: true, approvedAt: true } });
          const storeBy = new Map(stores.map((s) => [s.slug, s]));
          const order = await tx.order.create({
            data: {
              userId,
              idempotencyKey,
              status: method === "COD" ? "PLACED" : "PENDING_PAYMENT",
              paymentMethod: method,
              subtotalCentavos: q.totals.subtotalCentavos,
              deliveryCentavos: q.totals.deliveryCentavos,
              discountCentavos: 0,
              totalCentavos: q.totals.totalCentavos,
              shippingAddress: {
                fullName: address.fullName,
                phone: address.phone,
                region: address.region,
                province: address.province,
                city: address.city,
                barangay: address.barangay,
                street: address.street,
                postalCode: address.postalCode,
                label: address.label
              },
              ...(method === "COD" ? { placedAt: now } : { expiresAt: new Date(now.getTime() + PAYMENT_WINDOW_MINUTES * MINUTE) })
            }
          });
          for (const p of q.packages) {
            const store = storeBy.get(p.store.slug);
            if (!store) throw new Error(`store ${p.store.slug} vanished during checkout`);
            await tx.sellerOrder.create({
              data: {
                orderId: order.id,
                storeId: store.id,
                status: method === "COD" ? "PREPARING" : "AWAITING_PAYMENT",
                deliveryOption: p.delivery.option,
                subtotalCentavos: p.subtotalCentavos,
                deliveryCentavos: p.delivery.feeCentavos,
                platformFeeCentavos: platformFeeCentavos(p.subtotalCentavos, store.approvedAt, now),
                ...(method === "COD" ? { shipBy: shipByFor(now) } : {}),
                items: {
                  create: p.items.map((i) => ({
                    variantId: i.variantId,
                    productId: i.productId,
                    productTitle: i.title,
                    variantName: i.variantName,
                    imageUrl: i.image?.url ?? null,
                    unitPriceCentavos: i.unitPriceCentavos,
                    quantity: i.quantity
                  }))
                }
              }
            });
          }
          if (method === "COD") {
            await tx.payment.create({ data: { orderId: order.id, provider: "COD", method: "COD", amountCentavos: q.totals.totalCentavos, status: "PENDING" } });
            await this.afterConfirmed(tx, order.id, userId);
          }
          return order.id;
        },
        { timeout: 30_000, maxWait: 10_000 }
      );
    } catch (err) {
      // Two "Place order" requests with the same key at the same moment: the unique index
      // lets one through; the other returns that order.
      if (isUniqueViolation(err)) {
        const winner = await prisma.order.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } }, select: { id: true } });
        if (winner) return { ...(await this.resume(winner.id)), replayed: true };
      }
      throw err;
    }

    if (method === "COD") {
      const order = await this.view(orderId);
      await this.announce(order, user.email);
      return { order, nextAction: null, replayed: false };
    }
    try {
      const url = await this.startOnlinePayment(orderId, method);
      return { order: await this.view(orderId), nextAction: { type: "redirect", url }, replayed: false };
    } catch (err) {
      // PayMongo couldn't be reached: nothing was charged, so undo the order and free the stock.
      await this.cancelUnpaid(orderId, "Couldn't start the online payment");
      if (err instanceof AppError) throw err;
      this.deps.logger?.error({ err, orderId }, "starting the PayMongo checkout failed");
      throw paymentsUnavailable();
    }
  }

  /** The result of an order placed earlier with the same key (or to continue paying). */
  private async resume(orderId: string): Promise<{ order: OrderView; nextAction: NextAction | null }> {
    const order = await this.view(orderId);
    const url = order.status === "PENDING_PAYMENT" ? order.payment.checkoutUrl : null;
    return { order, nextAction: url ? { type: "redirect", url } : null };
  }

  /** A new PayMongo checkout session (one Payment row per attempt). */
  private async startOnlinePayment(orderId: string, method: OnlineMethod): Promise<string> {
    const { prisma, gateway } = this.deps;
    if (!gateway) throw paymentsUnavailable();
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { user: { select: { name: true, email: true } }, sellerOrders: { include: { store: { select: { name: true } }, items: true }, orderBy: { createdAt: "asc" } } }
    });
    const lineItems = order.sellerOrders.flatMap((so) => [
      ...so.items.map((i) => ({ name: `${i.productTitle} · ${i.variantName}`, amountCentavos: i.unitPriceCentavos, quantity: i.quantity })),
      ...(so.deliveryCentavos > 0 ? [{ name: `${so.deliveryOption === "EXPRESS" ? "Express" : "Standard"} delivery · ${so.store.name}`, amountCentavos: so.deliveryCentavos, quantity: 1 }] : [])
    ]);
    const charged = lineItems.reduce((s, l) => s + l.amountCentavos * l.quantity, 0);
    if (charged !== order.totalCentavos) throw new Error(`order ${orderId}: PayMongo items add up to ${charged}, order total is ${order.totalCentavos}`);

    const payment = await prisma.payment.create({ data: { orderId, provider: "PAYMONGO", method, amountCentavos: order.totalCentavos, status: "PENDING" } });
    try {
      const back = `${this.deps.appUrl}/checkout/payment?order=${orderId}`;
      const session = await gateway.createCheckout({
        referenceNumber: orderNumber(order.orderNumber),
        orderId,
        method,
        lineItems,
        successUrl: back,
        cancelUrl: `${back}&cancelled=1`,
        billing: { name: order.user.name, email: order.user.email, phone: (order.shippingAddress as { phone?: string }).phone }
      });
      await prisma.payment.update({ where: { id: payment.id }, data: { providerRef: session.id, checkoutUrl: session.checkoutUrl, status: "AWAITING_ACTION" } });
      return session.checkoutUrl;
    } catch (err) {
      await prisma.payment.update({ where: { id: payment.id }, data: { status: "FAILED", failureReason: "Couldn't start the PayMongo checkout" } });
      throw err;
    }
  }

  // --- orders ---------------------------------------------------------------------

  /** "Your orders": newest first, by tab, optionally searched by order number or product name. */
  async list(userId: string, query: OrderListQuery) {
    const { prisma } = this.deps;
    const where: Prisma.OrderWhereInput = { AND: [{ userId }, TAB_WHERE[query.tab], query.q ? searchOrders(query.q) : {}] };
    const count = (tab: OrderListQuery["tab"]) => prisma.order.count({ where: { AND: [{ userId }, TAB_WHERE[tab]] } });
    const [rows, totalItems, all, toShip, onTheWay, delivered] = await Promise.all([
      prisma.order.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * ORDERS_PAGE_SIZE,
        take: ORDERS_PAGE_SIZE,
        include: {
          sellerOrders: {
            include: {
              store: { select: { slug: true, name: true } },
              items: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { productTitle: true, variantName: true, imageUrl: true, quantity: true, review: { select: { id: true } } } }
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }]
          }
        }
      }),
      prisma.order.count({ where }),
      count("all"),
      count("to_ship"),
      count("on_the_way"),
      count("delivered")
    ]);

    const items: OrderSummary[] = rows.map((o) => ({
      id: o.id,
      number: orderNumber(o.orderNumber),
      status: o.status,
      createdAt: o.createdAt.toISOString(),
      placedAt: o.placedAt?.toISOString() ?? null,
      cancelledAt: o.cancelledAt?.toISOString() ?? null,
      paymentMethod: o.paymentMethod,
      totalCentavos: o.totalCentavos,
      itemCount: o.sellerOrders.reduce((s, so) => s + so.items.reduce((n, i) => n + i.quantity, 0), 0),
      packages: o.sellerOrders.map((so) => ({
        id: so.id,
        store: so.store,
        status: so.status,
        itemCount: so.items.reduce((n, i) => n + i.quantity, 0),
        items: so.items.slice(0, CARD_ITEMS).map((i) => ({ title: i.productTitle, variantName: i.variantName, imageUrl: i.imageUrl, quantity: i.quantity })),
        moreItems: Math.max(0, so.items.length - CARD_ITEMS),
        estimatedDelivery: estimateDelivery(o.placedAt, so.deliveryOption, so.status),
        courier: so.courier,
        trackingNumber: so.trackingNumber,
        shippedAt: so.shippedAt?.toISOString() ?? null,
        deliveredAt: so.deliveredAt?.toISOString() ?? null,
        canConfirmReceived: so.status === "SHIPPED",
        reviewableItems: so.deliveredAt ? so.items.filter((i) => !i.review).length : 0
      }))
    }));
    return {
      items,
      counts: { all, toShip, onTheWay, delivered },
      page: query.page,
      pageSize: ORDERS_PAGE_SIZE,
      totalItems,
      totalPages: Math.ceil(totalItems / ORDERS_PAGE_SIZE)
    };
  }

  /**
   * "Buy again": the order's items go back into the cart, with the same quantities, as far
   * as stock allows. Items that can't be bought any more are skipped and reported (like
   * the sign-in merge), never an error.
   */
  async buyAgain(userId: string, orderId: string) {
    const order = await this.deps.prisma.order.findFirst({
      where: { id: orderId, userId },
      select: { status: true, sellerOrders: { select: { items: { select: { variantId: true, quantity: true }, orderBy: { createdAt: "asc" } } }, orderBy: { createdAt: "asc" } } }
    });
    if (!order) throw notFound();
    // Its items are still held for it (and still in the cart): pay or cancel it first.
    if (order.status === "PENDING_PAYMENT") throw new AppError(409, "CONFLICT", "This order is still waiting for payment.", { details: { reason: "not_paid" } });
    return this.deps.cart.merge(
      userId,
      order.sellerOrders.flatMap((so) => so.items)
    );
  }

  /**
   * One of my orders (the waiting, failed and confirmation pages). While it waits for an
   * online payment, this also asks PayMongo (at most every 5 seconds): that's how a payment
   * is confirmed when the shopper comes back, even without the webhook.
   */
  async get(userId: string, orderId: string): Promise<OrderView> {
    const order = await this.deps.prisma.order.findFirst({ where: { id: orderId, userId }, select: { id: true, status: true, expiresAt: true } });
    if (!order) throw notFound();
    if (order.status === "PENDING_PAYMENT") {
      if (order.expiresAt && order.expiresAt <= this.now()) await this.closeUnpaid(order.id).catch((err) => this.deps.logger?.error({ err, orderId }, "closing an expired order failed"));
      else if (await this.syncDue(order.id)) await this.sync(order.id).catch((err) => this.deps.logger?.warn({ err, orderId }, "checking the payment with PayMongo failed"));
    }
    return this.view(orderId);
  }

  /** "Try again" (same or another method) while the 15 minutes last. */
  async retryPayment(userId: string, orderId: string, method: PaymentMethodChoice): Promise<{ order: OrderView; nextAction: NextAction | null }> {
    const { prisma } = this.deps;
    const order = await prisma.order.findFirst({ where: { id: orderId, userId }, select: { id: true, status: true, expiresAt: true, totalCentavos: true } });
    if (!order) throw notFound();
    if (order.status !== "PENDING_PAYMENT" || !order.expiresAt || order.expiresAt <= this.now()) {
      if (order.status === "PENDING_PAYMENT") await this.closeUnpaid(order.id);
      const now = await this.view(orderId);
      if (now.status === "PLACED") return { order: now, nextAction: null };
      throw new AppError(409, "CONFLICT", "This order can no longer be paid. Its items are back in stock; place a new order from your cart.", { details: { reason: "order_closed" } });
    }
    if (isOnline(method) && !this.deps.gateway) throw paymentsUnavailable();

    // Stop the current attempt first, so it can't also be paid.
    const stopped = await this.stopAttempts(orderId);
    if (stopped === "paid") return { order: await this.view(orderId), nextAction: null };
    if (stopped === "busy") throw new AppError(409, "CONFLICT", "A payment for this order is still being processed. Please wait a moment.", { details: { reason: "payment_in_progress" } });

    if (method === "COD") {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
        const refusal = this.codRefusal(order.totalCentavos, await this.openCodOrders(tx, userId));
        if (refusal) throw refusal;
        await tx.$queryRaw`SELECT 1 FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
        const fresh = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
        if (fresh.status !== "PENDING_PAYMENT") throw new AppError(409, "CONFLICT", "This order changed. Please refresh.", { details: { reason: "order_closed" } });
        await tx.order.update({ where: { id: orderId }, data: { paymentMethod: "COD" } });
        await tx.payment.create({ data: { orderId, provider: "COD", method: "COD", amountCentavos: order.totalCentavos, status: "PENDING" } });
        await this.confirmOrder(tx, orderId, this.now());
        await this.afterConfirmed(tx, orderId, userId);
      });
      const view = await this.view(orderId);
      await this.announce(view, user.email);
      return { order: view, nextAction: null };
    }

    await prisma.order.update({ where: { id: orderId }, data: { paymentMethod: method } });
    const url = await this.startOnlinePayment(orderId, method);
    return { order: await this.view(orderId), nextAction: { type: "redirect", url } };
  }

  /**
   * "Cancel order". Unpaid ("Back to cart"): the stock is returned. Paid less than an hour ago:
   * every package not shipped yet is cancelled and refunded (milestone 6c).
   */
  async cancel(userId: string, orderId: string): Promise<OrderView> {
    const order = await this.deps.prisma.order.findFirst({ where: { id: orderId, userId }, select: { status: true } });
    if (!order) throw notFound();
    if (order.status === "PLACED") {
      await this.deps.cancellation.cancelByBuyer(userId, orderId);
      return this.view(orderId);
    }
    if (order.status !== "PENDING_PAYMENT") throw new AppError(409, "CONFLICT", "This order can't be cancelled.", { details: { reason: "not_pending" } });
    const stopped = await this.stopAttempts(orderId);
    if (stopped === "busy") throw new AppError(409, "CONFLICT", "A payment for this order is still being processed. Please wait a moment.", { details: { reason: "payment_in_progress" } });
    if (stopped !== "paid") await this.cancelUnpaid(orderId, "Cancelled by the shopper");
    return this.view(orderId);
  }

  // --- confirming payments ----------------------------------------------------------

  /** Confirm-on-return: ask PayMongo about the order's open attempts. */
  private async sync(orderId: string): Promise<void> {
    const { prisma, gateway } = this.deps;
    if (!gateway) return;
    const attempts = await prisma.payment.findMany({ where: { orderId, provider: "PAYMONGO", status: "AWAITING_ACTION", providerRef: { not: null } }, select: { providerRef: true } });
    for (const a of attempts) {
      const state = await gateway.getCheckout(a.providerRef as string);
      if (state.paid) await this.settle(state.id, state.paid);
    }
  }

  private async syncDue(orderId: string): Promise<boolean> {
    try {
      return await this.deps.kv.setIfAbsent(`orders:sync:${orderId}`, "1", SYNC_EVERY_SECONDS);
    } catch {
      return true; // Redis down: still check (correctness over saving a call)
    }
  }

  /**
   * PayMongo says this checkout session was paid. Idempotent and safe in any order:
   * - first report for a waiting order → the order is placed;
   * - the order was already cancelled (paid after the window) → take the stock again if it's
   *   all there, otherwise refund in full;
   * - the order was already paid another way → refund this second payment;
   * - the same payment reported again → nothing happens.
   */
  async settle(sessionId: string, paid: PaidPayment): Promise<void> {
    const { prisma } = this.deps;
    const outcome = await prisma.$transaction(
      async (tx): Promise<{ kind: "none" } | { kind: "placed"; orderId: string; userId: string } | { kind: "refund"; refundId: string }> => {
        const attempt = await tx.payment.findUnique({ where: { providerRef: sessionId }, select: { id: true, orderId: true } });
        if (!attempt) {
          this.deps.logger?.warn({ sessionId }, "PayMongo reported a payment for an unknown checkout session");
          return { kind: "none" };
        }
        await tx.$queryRaw`SELECT 1 FROM orders WHERE id = ${attempt.orderId}::uuid FOR UPDATE`;
        const payment = await tx.payment.findUniqueOrThrow({ where: { id: attempt.id } });
        if (payment.status === "PAID" || payment.status === "REFUNDED") return { kind: "none" }; // already handled
        if (paid.amountCentavos !== payment.amountCentavos) {
          this.deps.logger?.error({ sessionId, orderId: payment.orderId, paid: paid.amountCentavos, expected: payment.amountCentavos }, "PayMongo amount doesn't match the order: needs a person to check");
          await tx.payment.update({ where: { id: payment.id }, data: { failureReason: `Amount mismatch: paid ${paid.amountCentavos}, expected ${payment.amountCentavos}` } });
          return { kind: "none" };
        }
        await tx.payment.update({ where: { id: payment.id }, data: { status: "PAID", providerPaymentId: paid.paymentId, paidAt: paid.paidAt, failureReason: null } });

        const order = await tx.order.findUniqueOrThrow({ where: { id: payment.orderId }, include: { sellerOrders: { include: { items: true } } } });
        const base = { orderId: order.id, userId: order.userId };
        if (order.status === "PENDING_PAYMENT") {
          await this.confirmOrder(tx, order.id, paid.paidAt);
          await this.afterConfirmed(tx, order.id, order.userId);
          return { kind: "placed", ...base };
        }
        const refund = (reason: "DUPLICATE_PAYMENT" | "LATE_PAYMENT_SOLD_OUT") =>
          recordRefund(tx, { paymentId: payment.id, amountCentavos: paid.amountCentavos, reason }, this.now()).then((refundId) => ({ kind: "refund" as const, refundId }));
        // Cancelled while unpaid (the window closed): take the stock again if it's all there. An order
        // that was paid and later cancelled (placedAt set) is never revived: that payment is a duplicate.
        if (order.status === "CANCELLED" && !order.placedAt) {
          const lines = order.sellerOrders.flatMap((so) => so.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })));
          if (!(await takeStock(tx, lines))) {
            await tx.order.update({ where: { id: order.id }, data: { paymentMethod: payment.method } });
            await this.confirmOrder(tx, order.id, paid.paidAt);
            await this.afterConfirmed(tx, order.id, order.userId);
            return { kind: "placed", ...base };
          }
          return refund("LATE_PAYMENT_SOLD_OUT");
        }
        return refund("DUPLICATE_PAYMENT");
      },
      { timeout: 30_000, maxWait: 10_000 }
    );

    if (outcome.kind === "placed") {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: outcome.userId }, select: { email: true } });
      await this.announce(await this.view(outcome.orderId), user.email);
      // Any other open attempt for this order mustn't be paid too.
      await this.stopAttempts(outcome.orderId).catch((err) => this.deps.logger?.warn({ err, orderId: outcome.orderId }, "stopping the other payment attempts failed"));
    } else if (outcome.kind === "refund") {
      await this.deps.refunds.send(outcome.refundId); // if PayMongo refuses, the job retries it
    }
  }

  /** PayMongo webhook: stored once (by event id), then settled like a shopper coming back. */
  async handleWebhook(event: WebhookEvent, payload: unknown): Promise<"processed" | "duplicate" | "ignored"> {
    const { prisma } = this.deps;
    await prisma.webhookEvent.createMany({ data: [{ provider: "PAYMONGO", providerEventId: event.eventId, type: event.type, payload: payload as Prisma.InputJsonValue }], skipDuplicates: true });
    const stored = await prisma.webhookEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: "PAYMONGO", providerEventId: event.eventId } } });
    if (stored.processedAt) return "duplicate";
    try {
      let result: "processed" | "ignored" = "ignored";
      if (event.type === "checkout_session.payment.paid") {
        const state: CheckoutState = readSession(event.resource);
        if (state.paid) {
          await this.settle(state.id, state.paid);
          result = "processed";
        }
      }
      await prisma.webhookEvent.update({ where: { id: stored.id }, data: { processedAt: this.now(), error: null } });
      return result;
    } catch (err) {
      // Left unprocessed, so PayMongo's retry (or the next one) processes it again.
      await prisma.webhookEvent.update({ where: { id: stored.id }, data: { error: String(err instanceof Error ? err.message : err).slice(0, 500) } }).catch(() => undefined);
      throw err;
    }
  }

  // --- the 15-minute window -----------------------------------------------------------

  /** Background job (every minute): close unpaid orders whose window is over. */
  async expireDue(limit = 50): Promise<number> {
    const due = await this.deps.prisma.order.findMany({ where: { status: "PENDING_PAYMENT", expiresAt: { lte: this.now() } }, select: { id: true }, orderBy: { expiresAt: "asc" }, take: limit });
    let closed = 0;
    for (const { id } of due) {
      try {
        if ((await this.closeUnpaid(id)) === "cancelled") closed++;
      } catch (err) {
        this.deps.logger?.error({ err, orderId: id }, "closing an expired order failed; will retry next minute");
      }
    }
    return closed;
  }

  /**
   * The window is over: stop PayMongo's sessions (a payment that's already through is
   * settled instead), then cancel and return the stock. If PayMongo is mid-payment it
   * refuses to stop, so the window is stretched a little, up to 45 minutes in total.
   */
  private async closeUnpaid(orderId: string): Promise<"cancelled" | "paid" | "extended"> {
    const stopped = await this.stopAttempts(orderId);
    if (stopped === "paid") return "paid";
    if (stopped === "busy") {
      const order = await this.deps.prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { createdAt: true } });
      if (this.now().getTime() - order.createdAt.getTime() < MAX_HOLD_MS) {
        await this.deps.prisma.order.updateMany({ where: { id: orderId, status: "PENDING_PAYMENT" }, data: { expiresAt: new Date(this.now().getTime() + BUSY_EXTENSION_MS) } });
        return "extended";
      }
    }
    await this.cancelUnpaid(orderId, "The 15-minute payment window ended");
    return "cancelled";
  }

  /** Stops every open PayMongo attempt of an order. "paid": one turned out paid (and is now settled). */
  private async stopAttempts(orderId: string): Promise<"stopped" | "paid" | "busy"> {
    const { prisma, gateway } = this.deps;
    const attempts = await prisma.payment.findMany({ where: { orderId, provider: "PAYMONGO", status: { in: ["PENDING", "AWAITING_ACTION"] } }, select: { id: true, providerRef: true } });
    let busy = false;
    for (const a of attempts) {
      if (a.providerRef && gateway) {
        const state = await gateway.getCheckout(a.providerRef);
        if (state.paid) {
          await this.settle(state.id, state.paid);
          return "paid";
        }
        if (state.status === "active" && (await gateway.expireCheckout(a.providerRef)) === "refused") {
          const again = await gateway.getCheckout(a.providerRef); // it may have just been paid
          if (again.paid) {
            await this.settle(again.id, again.paid);
            return "paid";
          }
          busy = true;
          continue;
        }
      }
      await prisma.payment.updateMany({ where: { id: a.id, status: { in: ["PENDING", "AWAITING_ACTION"] } }, data: { status: "EXPIRED", failureReason: "Replaced or expired" } });
    }
    return busy ? "busy" : "stopped";
  }

  /** Cancels a still-unpaid order and returns its stock (all in one transaction). */
  private async cancelUnpaid(orderId: string, reason: string): Promise<void> {
    await this.deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { sellerOrders: { include: { items: true } } } });
      if (order.status !== "PENDING_PAYMENT") return; // paid (or closed) meanwhile
      const now = this.now();
      await tx.order.update({ where: { id: orderId }, data: { status: "CANCELLED", cancelledAt: now, expiresAt: null } });
      await tx.sellerOrder.updateMany({ where: { orderId }, data: { status: "CANCELLED", cancelledAt: now } });
      await tx.payment.updateMany({ where: { orderId, status: { in: ["PENDING", "AWAITING_ACTION"] } }, data: { status: "EXPIRED", failureReason: reason } });
      for (const so of order.sellerOrders) for (const i of so.items) await tx.productVariant.update({ where: { id: i.variantId }, data: { stock: { increment: i.quantity } } });
    });
  }

  /**
   * An order was just confirmed (paid, or placed with cash on delivery): the buyer gets the
   * confirmation, and each store "New order VD-21458: ship by …" for its own package. Runs once
   * per order, after the transaction (`settle` reports "placed" only the first time).
   */
  private async announce(order: OrderView, buyerEmail: string): Promise<void> {
    this.mailer.send(orderConfirmedEmail(buyerEmail, order, this.deps.appUrl));
    const packages = await this.deps.prisma.sellerOrder.findMany({
      where: { orderId: order.id, status: "PREPARING" },
      select: { id: true, subtotalCentavos: true, deliveryOption: true, shipBy: true, store: { select: { name: true, owner: { select: { email: true } } } } }
    });
    for (const p of packages) {
      const view = order.packages.find((v) => v.id === p.id);
      if (!view || !p.shipBy) continue;
      this.mailer.send(
        newOrderEmail(
          p.store.owner.email,
          p.store.name,
          {
            id: p.id,
            number: order.number,
            items: view.items.map((i) => ({ title: i.title, variantName: i.variantName, quantity: i.quantity })),
            subtotalCentavos: p.subtotalCentavos,
            deliveryOption: p.deliveryOption,
            paymentMethod: order.payment.method,
            shipBy: p.shipBy
          },
          this.deps.appUrl
        )
      );
    }
  }

  /** Paid (or cash on delivery): the order is placed and each package goes to its seller. */
  private async confirmOrder(tx: Tx, orderId: string, at: Date) {
    await tx.order.update({ where: { id: orderId }, data: { status: "PLACED", placedAt: at, expiresAt: null, cancelledAt: null } });
    await tx.sellerOrder.updateMany({ where: { orderId }, data: { status: "PREPARING", shipBy: shipByFor(at), cancelledAt: null } });
  }

  /** After an order is confirmed: "sold" counts go up and the bought items leave the cart. */
  private async afterConfirmed(tx: Tx, orderId: string, userId: string) {
    const items = await tx.orderItem.findMany({ where: { sellerOrder: { orderId } }, select: { productId: true, variantId: true, quantity: true } });
    for (const i of items) await tx.product.update({ where: { id: i.productId }, data: { soldCount: { increment: i.quantity } } });
    const cart = await tx.cart.findUnique({ where: { userId }, select: { id: true } });
    if (!cart) return;
    for (const i of items) {
      const line = await tx.cartItem.findUnique({ where: { cartId_variantId: { cartId: cart.id, variantId: i.variantId } } });
      if (!line) continue;
      if (line.quantity <= i.quantity) await tx.cartItem.delete({ where: { cartId_variantId: { cartId: cart.id, variantId: i.variantId } } });
      else await tx.cartItem.update({ where: { cartId_variantId: { cartId: cart.id, variantId: i.variantId } }, data: { quantity: line.quantity - i.quantity } });
    }
  }

  // --- view -------------------------------------------------------------------------

  async view(orderId: string): Promise<OrderView> {
    const o = await this.deps.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        sellerOrders: {
          include: {
            store: { select: { slug: true, name: true, logoUrl: true, ratingAvg: true, ratingCount: true } },
            items: {
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              include: { review: { select: { id: true, rating: true, title: true, body: true, status: true, createdAt: true, updatedAt: true } } }
            },
            events: { orderBy: [{ occurredAt: "asc" }, { id: "asc" }] },
            refund: { select: { amountCentavos: true, status: true, sentAt: true } }
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }]
        },
        payments: { orderBy: { createdAt: "desc" }, take: 1 }
      }
    });
    const latest = o.payments[0];
    const waiting = o.status === "PENDING_PAYMENT";
    const cancelUntil = o.status === "PLACED" && o.placedAt && o.sellerOrders.some((so) => so.status === "PREPARING") ? buyerCancelUntil(o.placedAt) : null;
    const canCancel = cancelUntil !== null && this.now() <= cancelUntil;
    return {
      id: o.id,
      number: orderNumber(o.orderNumber),
      status: o.status,
      createdAt: o.createdAt.toISOString(),
      placedAt: o.placedAt?.toISOString() ?? null,
      cancelledAt: o.cancelledAt?.toISOString() ?? null,
      canCancel,
      cancelUntil: canCancel ? (cancelUntil?.toISOString() ?? null) : null,
      payment: {
        method: o.paymentMethod,
        status: latest?.status ?? "PENDING",
        checkoutUrl: waiting && latest?.status === "AWAITING_ACTION" ? latest.checkoutUrl : null,
        expiresAt: waiting ? (o.expiresAt?.toISOString() ?? null) : null,
        paidAt: latest?.paidAt?.toISOString() ?? null
      },
      packages: o.sellerOrders.map((so) => ({
        id: so.id,
        store: { slug: so.store.slug, name: so.store.name, logoUrl: so.store.logoUrl, rating: { avg: Number(so.store.ratingAvg), count: so.store.ratingCount } },
        status: so.status,
        deliveryOption: so.deliveryOption,
        deliveryDays: daysFor(so.deliveryOption),
        subtotalCentavos: so.subtotalCentavos,
        deliveryCentavos: so.deliveryCentavos,
        courier: so.courier,
        trackingNumber: so.trackingNumber,
        shipBy: so.shipBy?.toISOString() ?? null,
        shippedAt: so.shippedAt?.toISOString() ?? null,
        deliveredAt: so.deliveredAt?.toISOString() ?? null,
        cancelledAt: so.cancelledAt?.toISOString() ?? null,
        canConfirmReceived: so.status === "SHIPPED",
        autoConfirmAt: so.status === "SHIPPED" && so.shippedAt ? autoConfirmAt(so.shippedAt).toISOString() : null,
        deliveryConfirmedBy: so.deliveryConfirmedBy === "BUYER" ? "buyer" : so.deliveryConfirmedBy === "AUTO" ? "auto" : null,
        cancellation:
          so.cancelledBy && so.cancelReason
            ? { by: so.cancelledBy === "SELLER" ? "seller" : so.cancelledBy === "BUYER" ? "buyer" : "system", reason: so.cancelReason, message: buyerCancelMessage(so.cancelledBy, so.cancelReason) }
            : null,
        refund: so.refund
          ? { amountCentavos: so.refund.amountCentavos, status: so.refund.status === "SENT" ? "sent" : so.refund.status === "FAILED" ? "delayed" : "processing", sentAt: so.refund.sentAt?.toISOString() ?? null }
          : null,
        estimatedDelivery: estimateDelivery(o.placedAt, so.deliveryOption, so.status),
        steps: [
          { step: "ORDERED" as const, at: o.createdAt.toISOString() },
          // Preparing starts when the order is paid (or placed with cash on delivery).
          { step: "PREPARING" as const, at: so.status !== "AWAITING_PAYMENT" && o.placedAt ? o.placedAt.toISOString() : null },
          { step: "SHIPPED" as const, at: so.shippedAt?.toISOString() ?? null },
          { step: "DELIVERED" as const, at: so.deliveredAt?.toISOString() ?? null }
        ],
        events: trackingEvents(o, so),
        items: so.items.map((i) => ({
          id: i.id,
          productId: i.productId,
          variantId: i.variantId,
          title: i.productTitle,
          variantName: i.variantName,
          imageUrl: i.imageUrl,
          unitPriceCentavos: i.unitPriceCentavos,
          quantity: i.quantity,
          lineTotalCentavos: i.unitPriceCentavos * i.quantity,
          review: i.review
            ? { id: i.review.id, rating: i.review.rating, title: i.review.title, body: i.review.body, status: i.review.status, createdAt: i.review.createdAt.toISOString(), updatedAt: i.review.updatedAt.toISOString() }
            : null,
          canReview: so.deliveredAt !== null && !i.review
        }))
      })),
      itemCount: o.sellerOrders.reduce((s, so) => s + so.items.reduce((n, i) => n + i.quantity, 0), 0),
      totals: { subtotalCentavos: o.subtotalCentavos, deliveryCentavos: o.deliveryCentavos, discountCentavos: o.discountCentavos, totalCentavos: o.totalCentavos },
      address: o.shippingAddress
    };
  }
}

/**
 * A package's timeline, newest first. The milestones come from the package itself (paid,
 * shipped with courier and tracking number, delivered, cancelled); `shipment_events` hold
 * any extra updates in between ("Arrived at Manila sorting hub"), added in milestone 6.
 */
function trackingEvents(
  order: { createdAt: Date; placedAt: Date | null; paymentMethod: PaymentMethodChoice },
  so: {
    courier: string | null;
    trackingNumber: string | null;
    shippedAt: Date | null;
    deliveredAt: Date | null;
    deliveryConfirmedBy: "BUYER" | "AUTO" | null;
    cancelledAt: Date | null;
    cancelledBy: "SELLER" | "BUYER" | "SYSTEM" | null;
    cancelReason: Parameters<typeof buyerCancelMessage>[1];
    refund: { amountCentavos: number; status: string; sentAt: Date | null } | null;
    events: { message: string; location: string | null; occurredAt: Date }[];
  }
): TrackingEvent[] {
  const events: (Omit<TrackingEvent, "at"> & { at: Date })[] = [];
  if (order.placedAt) {
    const message = order.paymentMethod === "COD" ? "Order placed · pay cash on delivery" : `Order placed and paid with ${METHOD_NAME[order.paymentMethod]}`;
    events.push({ type: "placed", message, location: null, at: order.placedAt });
  } else {
    events.push({ type: "placed", message: "Order placed · waiting for payment", location: null, at: order.createdAt });
  }
  if (so.shippedAt) {
    const via = so.courier ? ` with ${so.courier}${so.trackingNumber ? ` · tracking ${so.trackingNumber}` : ""}` : "";
    events.push({ type: "shipped", message: `Shipped${via}`, location: null, at: so.shippedAt });
  }
  for (const e of so.events) events.push({ type: "update", message: e.message, location: e.location, at: e.occurredAt });
  if (so.deliveredAt) {
    const how = so.deliveryConfirmedBy === "BUYER" ? " · you confirmed you received it" : so.deliveryConfirmedBy === "AUTO" ? ` · confirmed automatically ${AUTO_CONFIRM_DAYS} days after shipping` : "";
    events.push({ type: "delivered", message: `Delivered${how}`, location: null, at: so.deliveredAt });
  }
  if (so.cancelledAt) events.push({ type: "cancelled", message: buyerCancelMessage(so.cancelledBy, so.cancelReason), location: null, at: so.cancelledAt });
  if (so.refund?.sentAt) {
    const to = order.paymentMethod === "COD" ? "" : ` to your ${METHOD_NAME[order.paymentMethod]}`;
    events.push({ type: "refund", message: `Refund of ₱${(so.refund.amountCentavos / 100).toLocaleString("en-PH", { maximumFractionDigits: 2 })} sent${to}`, location: null, at: so.refund.sentAt });
  }
  // Oldest first (a stable sort keeps the order above for equal times), then reversed: newest first.
  return events
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .reverse()
    .map((e) => ({ ...e, at: e.at.toISOString() }));
}

/**
 * Takes the stock for these lines: all of it or none. The variant rows are locked in id
 * order (so two checkouts can't deadlock), checked, then decremented. Returns the first
 * line that's short, or null when everything was taken.
 */
async function takeStock(tx: Tx, lines: Line[]): Promise<{ variantId: string; left: number; title: string } | null> {
  const wanted = new Map<string, number>();
  for (const l of lines) wanted.set(l.variantId, (wanted.get(l.variantId) ?? 0) + l.quantity);
  const ids = [...wanted.keys()].sort();
  const rows = await tx.$queryRaw<{ id: string; stock: number; isActive: boolean; title: string; name: string }[]>`
    SELECT v.id, v.stock, v."isActive", p.title, v.name
    FROM product_variants v JOIN products p ON p.id = v."productId"
    WHERE v.id = ANY(${ids}::uuid[])
    ORDER BY v.id
    FOR UPDATE OF v`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    const row = byId.get(id);
    const qty = wanted.get(id) ?? 0;
    if (!row || !row.isActive || row.stock < qty) return { variantId: id, left: row && row.isActive ? row.stock : 0, title: row ? `${row.title} (${row.name})` : "an item" };
  }
  for (const id of ids) await tx.productVariant.update({ where: { id }, data: { stock: { decrement: wanted.get(id) ?? 0 } } });
  return null;
}
