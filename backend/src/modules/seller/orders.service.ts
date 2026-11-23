import type { DeliveryOption, PaymentMethod, Prisma, PrismaClient, SellerOrderStatus } from "../../generated/prisma/client.js";
import { BackgroundMailer } from "../../lib/backgroundMailer.js";
import { pesos, toCsv } from "../../lib/csv.js";
import type { EmailSender } from "../../lib/email.js";
import { AppError } from "../../lib/errors.js";
import { PLATFORM_FEE_RATE } from "../../lib/fees.js";
import { likeLiteral } from "../../lib/like.js";
import type { Logger } from "../../lib/logger.js";
import { isUniqueViolation } from "../../lib/prismaErrors.js";
import { AUTO_CONFIRM_DAYS, autoConfirmAt, earningsAvailableAt, manilaCutoff } from "../orders/deadlines.js";
import { packageShippedEmail } from "../orders/orders.emails.js";
import { sellerStore, type SellerStore } from "./access.js";
import { EXPORT_MAX_ROWS, SELLER_ORDERS_PAGE_SIZE, type SellerOrderExportQuery, type SellerOrderListQuery, type SellerOrderTab, type ShipmentInput } from "./orders.schemas.js";

const HOUR_MS = 60 * 60 * 1000;
const notFound = () => new AppError(404, "NOT_FOUND", "This order doesn't exist.");
const conflict = (reason: string, message: string, field?: { path: string; message: string }) =>
  new AppError(409, "CONFLICT", message, { details: { reason }, ...(field ? { fields: [field] } : {}) });
const orderNumber = (n: number) => `VD-${n}`;

/** The buyer's full address is shown only while the package still has to reach them. */
const ADDRESS_VISIBLE: readonly SellerOrderStatus[] = ["PREPARING", "SHIPPED"];

export interface SellerOrderRow {
  /** The package (seller order) id: what the order page and "Ship" use. */
  id: string;
  number: string;
  placedAt: string;
  /** "Maria S." and the city: enough to recognise the order, nothing more. */
  customer: { name: string; city: string };
  /** "AuraSound Pro + 1 more" · "2 items". */
  items: { first: { title: string; variantName: string; imageUrl: string | null; quantity: number }; moreLines: number; units: number };
  subtotalCentavos: number;
  deliveryOption: DeliveryOption;
  paymentMethod: PaymentMethod;
  status: SellerOrderStatus;
  shipBy: string | null;
  /** Still to ship and past its ship-by time. */
  late: boolean;
  courier: string | null;
  trackingNumber: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
}

export interface SellerOrderView {
  id: string;
  number: string;
  status: SellerOrderStatus;
  late: boolean;
  placedAt: string;
  paymentMethod: PaymentMethod;
  deliveryOption: DeliveryOption;
  shipBy: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  deliveryConfirmedBy: "buyer" | "auto" | null;
  /** While shipped: when it's confirmed automatically if the buyer doesn't. */
  autoConfirmAt: string | null;
  /** Courier, tracking number and weight once shipped ("Mark as shipped" shows them for fixing a typo). */
  shipment: { courier: string; trackingNumber: string; packageWeightGrams: number | null } | null;
  /** The items' weights added up (when every item has one): the form's starting value. */
  suggestedWeightGrams: number | null;
  canShip: boolean;
  canEditShipment: boolean;
  items: {
    id: string;
    productId: string;
    variantId: string;
    title: string;
    variantName: string;
    sku: string;
    imageUrl: string | null;
    unitPriceCentavos: number;
    quantity: number;
    lineTotalCentavos: number;
  }[];
  customer: { name: string; ordersWithStore: number };
  /** Full while it needs shipping; after delivery (or cancellation) only the name and city. */
  shipTo: {
    name: string;
    phone: string | null;
    street: string | null;
    barangay: string | null;
    city: string;
    province: string | null;
    region: string;
    postalCode: string | null;
    hidden: boolean;
  };
  earnings: {
    subtotalCentavos: number;
    feeCentavos: number;
    /** 5, or 0 in a store's first 30 days. */
    feePercent: number;
    netCentavos: number;
    /** after_delivery: not delivered yet · on_hold: delivered, released at availableAt · available · cancelled. */
    status: "after_delivery" | "on_hold" | "available" | "cancelled";
    availableAt: string | null;
  };
  /** Oldest first. */
  timeline: { type: "paid" | "placed" | "shipped" | "delivered" | "cancelled"; message: string; at: string }[];
  /** What happens next ("Waiting for you to ship", by Nov 25, 6:00 PM). */
  next: { message: string; by: string } | null;
  /** For the packing slip. */
  store: { name: string; shipsFrom: string | null };
}

const TAB_WHERE: Record<SellerOrderTab, Prisma.SellerOrderWhereInput> = {
  to_ship: { status: "PREPARING" },
  shipped: { status: "SHIPPED" },
  delivered: { status: "DELIVERED" },
  all: {}
};

const STATUS_LABEL: Record<SellerOrderStatus, string> = {
  AWAITING_PAYMENT: "Awaiting payment",
  PREPARING: "To ship",
  SHIPPED: "Shipped",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
  RETURN_REQUESTED: "Return requested",
  RETURNED: "Returned"
};
const METHOD_NAME: Record<PaymentMethod, string> = { GCASH: "GCash", MAYA: "Maya", CARD: "card", COD: "cash on delivery" };

/** "Maria Santos" → "Maria S."; one word stays as it is. */
export function shortName(fullName: string): string {
  const words = fullName.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  if (!first) return "Customer";
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  return last ? `${first} ${last.charAt(0).toUpperCase()}.` : first;
}

type Address = { fullName?: string; phone?: string; street?: string; barangay?: string; city?: string; province?: string | null; region?: string; postalCode?: string };
const addressOf = (json: unknown): Address => (json && typeof json === "object" ? (json as Address) : {});

/** "VD-21458", "#VD-21458" or "21458" finds that order; other text matches the products' names. */
function search(q: string): Prisma.SellerOrderWhereInput {
  const number = /^#?\s*(?:vd\s*-?\s*)?(\d{1,9})$/i.exec(q)?.[1];
  const byProduct: Prisma.SellerOrderWhereInput = { items: { some: { productTitle: { contains: likeLiteral(q), mode: "insensitive" } } } };
  return number ? { OR: [{ order: { orderNumber: Number(number) } }, byProduct] } : byProduct;
}

/** "2026-11-23 14:41" in Philippine time, for spreadsheets. */
const manilaStamp = (d: Date | null) => (d ? new Date(d.getTime() + 8 * HOUR_MS).toISOString().slice(0, 16).replace("T", " ") : null);

/**
 * Seller Center → Orders (milestone 6c): the orders list and its tabs, one order's page (with
 * what the seller earns), "Mark as shipped" and Export CSV.
 *
 * A seller sees a package only once it's paid (or placed with cash on delivery), and only their
 * own store's part of an order: never the other stores' items or the buyer's whole total.
 */
export class SellerOrderService {
  private readonly mailer: BackgroundMailer;

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      email: EmailSender;
      appUrl: string;
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

  private where(storeId: string, tab: SellerOrderTab, q?: string): Prisma.SellerOrderWhereInput {
    return { AND: [{ storeId, order: { placedAt: { not: null } } }, TAB_WHERE[tab], q ? search(q) : {}] };
  }

  // --- the orders list ------------------------------------------------------------

  /**
   * "To ship" lists the most urgent first (earliest ship-by); the other tabs newest first.
   * `alerts` feeds "3 orders are due to ship today by 6:00 PM" and the late count.
   */
  async list(userId: string, query: SellerOrderListQuery) {
    const { prisma } = this.deps;
    const store = await sellerStore(prisma, userId, { write: false });
    const now = this.now();
    const where = this.where(store.id, query.tab, query.q);
    const count = (tab: SellerOrderTab) => prisma.sellerOrder.count({ where: this.where(store.id, tab) });
    const cutoff = manilaCutoff(now);
    const [rows, totalItems, toShip, shipped, delivered, all, dueToday, late] = await Promise.all([
      prisma.sellerOrder.findMany({
        where,
        orderBy: query.tab === "to_ship" ? [{ shipBy: "asc" }, { createdAt: "asc" }, { id: "asc" }] : [{ createdAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * SELLER_ORDERS_PAGE_SIZE,
        take: SELLER_ORDERS_PAGE_SIZE,
        include: {
          order: { select: { orderNumber: true, placedAt: true, paymentMethod: true, shippingAddress: true } },
          items: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { productTitle: true, variantName: true, imageUrl: true, quantity: true } }
        }
      }),
      prisma.sellerOrder.count({ where }),
      count("to_ship"),
      count("shipped"),
      count("delivered"),
      count("all"),
      now < cutoff ? prisma.sellerOrder.count({ where: { AND: [this.where(store.id, "to_ship"), { shipBy: { gt: now, lte: cutoff } }] } }) : Promise.resolve(0),
      prisma.sellerOrder.count({ where: { AND: [this.where(store.id, "to_ship"), { shipBy: { lte: now } }] } })
    ]);

    const items: SellerOrderRow[] = rows.map((so) => {
      const address = addressOf(so.order.shippingAddress);
      const [first] = so.items;
      return {
        id: so.id,
        number: orderNumber(so.order.orderNumber),
        placedAt: (so.order.placedAt ?? so.createdAt).toISOString(),
        customer: { name: shortName(address.fullName ?? ""), city: address.city ?? "" },
        items: {
          first: { title: first?.productTitle ?? "", variantName: first?.variantName ?? "", imageUrl: first?.imageUrl ?? null, quantity: first?.quantity ?? 0 },
          moreLines: Math.max(0, so.items.length - 1),
          units: so.items.reduce((n, i) => n + i.quantity, 0)
        },
        subtotalCentavos: so.subtotalCentavos,
        deliveryOption: so.deliveryOption,
        paymentMethod: so.order.paymentMethod,
        status: so.status,
        shipBy: so.shipBy?.toISOString() ?? null,
        late: so.status === "PREPARING" && so.shipBy !== null && so.shipBy <= now,
        courier: so.courier,
        trackingNumber: so.trackingNumber,
        shippedAt: so.shippedAt?.toISOString() ?? null,
        deliveredAt: so.deliveredAt?.toISOString() ?? null
      };
    });
    return {
      items,
      counts: { toShip, shipped, delivered, all },
      alerts: { dueToday, dueBy: cutoff.toISOString(), late },
      page: query.page,
      pageSize: SELLER_ORDERS_PAGE_SIZE,
      totalItems,
      totalPages: Math.ceil(totalItems / SELLER_ORDERS_PAGE_SIZE)
    };
  }

  // --- one order ------------------------------------------------------------------

  async view(userId: string, id: string): Promise<SellerOrderView> {
    return this.load(await sellerStore(this.deps.prisma, userId, { write: false }), id);
  }

  private async load(store: SellerStore, id: string): Promise<SellerOrderView> {
    const { prisma } = this.deps;
    const so = await prisma.sellerOrder.findFirst({
      where: { id, storeId: store.id, order: { placedAt: { not: null } } },
      include: {
        order: { select: { userId: true, orderNumber: true, placedAt: true, paymentMethod: true, shippingAddress: true } },
        items: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], include: { variant: { select: { sku: true, weightGrams: true } } } },
        ledgerEntries: { where: { type: "SALE" }, select: { availableAt: true } }
      }
    });
    if (!so) throw notFound();
    const now = this.now();
    const placedAt = so.order.placedAt ?? so.createdAt;
    const ordersWithStore = await prisma.sellerOrder.count({ where: { storeId: store.id, order: { userId: so.order.userId, placedAt: { not: null } } } });

    const address = addressOf(so.order.shippingAddress);
    const hidden = !ADDRESS_VISIBLE.includes(so.status);
    const shipTo = {
      name: hidden ? shortName(address.fullName ?? "") : (address.fullName ?? ""),
      phone: hidden ? null : (address.phone ?? null),
      street: hidden ? null : (address.street ?? null),
      barangay: hidden ? null : (address.barangay ?? null),
      city: address.city ?? "",
      province: address.province ?? null,
      region: address.region ?? "",
      postalCode: hidden ? null : (address.postalCode ?? null),
      hidden
    };

    const weights = so.items.map((i) => (i.variant.weightGrams ? i.variant.weightGrams * i.quantity : null));
    const suggestedWeightGrams = weights.length && weights.every((w) => w !== null) ? weights.reduce<number>((s, w) => s + (w ?? 0), 0) : null;

    const sale = so.ledgerEntries[0];
    const availableAt = sale?.availableAt ?? (so.deliveredAt ? earningsAvailableAt(so.deliveredAt) : null);
    const earningsStatus: SellerOrderView["earnings"]["status"] =
      so.status === "CANCELLED" ? "cancelled" : !so.deliveredAt ? "after_delivery" : availableAt && availableAt > now ? "on_hold" : "available";

    const timeline: SellerOrderView["timeline"] = [
      so.order.paymentMethod === "COD"
        ? { type: "placed", message: "Ordered with cash on delivery (the courier collects the payment)", at: placedAt.toISOString() }
        : { type: "paid", message: `Paid with ${METHOD_NAME[so.order.paymentMethod]}`, at: placedAt.toISOString() }
    ];
    if (so.shippedAt) timeline.push({ type: "shipped", message: `Shipped with ${so.courier ?? "the courier"} · tracking ${so.trackingNumber ?? "—"}`, at: so.shippedAt.toISOString() });
    if (so.deliveredAt) {
      const how = so.deliveryConfirmedBy === "BUYER" ? " · the buyer confirmed it" : so.deliveryConfirmedBy === "AUTO" ? ` · confirmed automatically ${AUTO_CONFIRM_DAYS} days after shipping` : "";
      timeline.push({ type: "delivered", message: `Delivered${how}`, at: so.deliveredAt.toISOString() });
    }
    if (so.cancelledAt) timeline.push({ type: "cancelled", message: "Cancelled", at: so.cancelledAt.toISOString() });

    const autoAt = so.status === "SHIPPED" && so.shippedAt ? autoConfirmAt(so.shippedAt) : null;
    const next =
      so.status === "PREPARING" && so.shipBy
        ? { message: so.shipBy <= now ? "Late: ship it as soon as you can" : "Waiting for you to ship", by: so.shipBy.toISOString() }
        : autoAt
          ? { message: "Waiting for the buyer to confirm delivery", by: autoAt.toISOString() }
          : earningsStatus === "on_hold" && availableAt
            ? { message: "Your earnings are released to your payout balance", by: availableAt.toISOString() }
            : null;

    return {
      id: so.id,
      number: orderNumber(so.order.orderNumber),
      status: so.status,
      late: so.status === "PREPARING" && so.shipBy !== null && so.shipBy <= now,
      placedAt: placedAt.toISOString(),
      paymentMethod: so.order.paymentMethod,
      deliveryOption: so.deliveryOption,
      shipBy: so.shipBy?.toISOString() ?? null,
      shippedAt: so.shippedAt?.toISOString() ?? null,
      deliveredAt: so.deliveredAt?.toISOString() ?? null,
      deliveryConfirmedBy: so.deliveryConfirmedBy === "BUYER" ? "buyer" : so.deliveryConfirmedBy === "AUTO" ? "auto" : null,
      autoConfirmAt: autoAt?.toISOString() ?? null,
      shipment: so.courier && so.trackingNumber ? { courier: so.courier, trackingNumber: so.trackingNumber, packageWeightGrams: so.packageWeightGrams } : null,
      suggestedWeightGrams,
      canShip: so.status === "PREPARING",
      canEditShipment: so.status === "SHIPPED",
      items: so.items.map((i) => ({
        id: i.id,
        productId: i.productId,
        variantId: i.variantId,
        title: i.productTitle,
        variantName: i.variantName,
        sku: i.variant.sku,
        imageUrl: i.imageUrl,
        unitPriceCentavos: i.unitPriceCentavos,
        quantity: i.quantity,
        lineTotalCentavos: i.unitPriceCentavos * i.quantity
      })),
      customer: { name: shortName(address.fullName ?? ""), ordersWithStore },
      shipTo,
      earnings: {
        subtotalCentavos: so.subtotalCentavos,
        feeCentavos: so.platformFeeCentavos,
        feePercent: so.platformFeeCentavos > 0 ? Math.round(PLATFORM_FEE_RATE * 100) : 0,
        netCentavos: so.subtotalCentavos - so.platformFeeCentavos,
        status: earningsStatus,
        availableAt: availableAt?.toISOString() ?? null
      },
      timeline,
      next,
      store: { name: store.name, shipsFrom: store.shipsFrom }
    };
  }

  // --- Mark as shipped ------------------------------------------------------------

  /**
   * "Mark as shipped" with the courier and tracking number; the buyer is emailed. Sending it
   * again (a double click) or with corrected details while the package is on its way just updates
   * them. A suspended store can still ship: these orders are paid and the buyers are waiting.
   */
  async ship(userId: string, id: string, input: ShipmentInput): Promise<SellerOrderView> {
    const { prisma } = this.deps;
    const store = await sellerStore(prisma, userId, { write: false });
    const found = await prisma.sellerOrder.findFirst({ where: { id, storeId: store.id, order: { placedAt: { not: null } } }, select: { status: true } });
    if (!found) throw notFound();
    const details = { courier: input.courier, trackingNumber: input.trackingNumber, packageWeightGrams: input.packageWeightGrams };

    let email: "shipped" | "updated" | null = null;
    try {
      // Only from "to ship", checked in the same statement that changes it: two clicks (or two
      // tabs) can't both ship it, and an order cancelled meanwhile can't be shipped.
      if (found.status === "PREPARING") {
        const won = await prisma.sellerOrder.updateMany({ where: { id, status: "PREPARING" }, data: { ...details, status: "SHIPPED", shippedAt: this.now() } });
        if (won.count === 1) email = "shipped";
      }
      if (!email) {
        const before = await prisma.sellerOrder.findUniqueOrThrow({ where: { id }, select: { status: true, courier: true, trackingNumber: true } });
        if (before.status !== "SHIPPED") throw cannotShip(before.status);
        const won = await prisma.sellerOrder.updateMany({ where: { id, status: "SHIPPED" }, data: details });
        if (won.count !== 1) throw cannotShip((await prisma.sellerOrder.findUniqueOrThrow({ where: { id }, select: { status: true } })).status);
        if (before.courier !== input.courier || before.trackingNumber !== input.trackingNumber) email = "updated";
      }
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw conflict("tracking_in_use", "This tracking number is already used for another package.", {
          path: "trackingNumber",
          message: "This tracking number is already used for another package. Check the courier's receipt."
        });
      }
      throw err;
    }
    if (email) await this.emailBuyer(id, email === "updated");
    return this.load(store, id);
  }

  private async emailBuyer(id: string, updated: boolean) {
    const so = await this.deps.prisma.sellerOrder.findUniqueOrThrow({
      where: { id },
      include: {
        store: { select: { name: true } },
        order: { select: { id: true, orderNumber: true, user: { select: { email: true } } } },
        items: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { productTitle: true, variantName: true, quantity: true } }
      }
    });
    if (!so.courier || !so.trackingNumber || !so.shippedAt) return;
    this.mailer.send(
      packageShippedEmail(
        so.order.user.email,
        {
          orderId: so.order.id,
          number: orderNumber(so.order.orderNumber),
          storeName: so.store.name,
          courier: so.courier,
          trackingNumber: so.trackingNumber,
          items: so.items.map((i) => ({ title: i.productTitle, variantName: i.variantName, quantity: i.quantity })),
          autoConfirmAt: autoConfirmAt(so.shippedAt)
        },
        this.deps.appUrl,
        updated
      )
    );
  }

  // --- Export CSV -----------------------------------------------------------------

  /** The orders of a tab (and search) as a spreadsheet, newest first, up to 5,000. Buyers appear as "Maria S." and their city. */
  async exportCsv(userId: string, query: SellerOrderExportQuery): Promise<{ filename: string; csv: string }> {
    const { prisma } = this.deps;
    const store = await sellerStore(prisma, userId, { write: false });
    const rows = await prisma.sellerOrder.findMany({
      where: this.where(store.id, query.tab, query.q),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: EXPORT_MAX_ROWS,
      include: {
        order: { select: { orderNumber: true, placedAt: true, paymentMethod: true, shippingAddress: true } },
        items: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { productTitle: true, variantName: true, quantity: true } }
      }
    });
    const header = [
      "Order",
      "Placed (PH time)",
      "Status",
      "Customer",
      "City",
      "Items",
      "Units",
      "Items subtotal (PHP)",
      "Vendora fee (PHP)",
      "You receive (PHP)",
      "Delivery",
      "Payment",
      "Ship by (PH time)",
      "Courier",
      "Tracking number",
      "Shipped (PH time)",
      "Delivered (PH time)"
    ];
    const csv = toCsv(
      header,
      rows.map((so) => {
        const address = addressOf(so.order.shippingAddress);
        return [
          orderNumber(so.order.orderNumber),
          manilaStamp(so.order.placedAt ?? so.createdAt),
          STATUS_LABEL[so.status],
          shortName(address.fullName ?? ""),
          address.city ?? "",
          so.items.map((i) => `${i.quantity} × ${i.productTitle} (${i.variantName})`).join("; "),
          so.items.reduce((n, i) => n + i.quantity, 0),
          pesos(so.subtotalCentavos),
          pesos(so.platformFeeCentavos),
          pesos(so.subtotalCentavos - so.platformFeeCentavos),
          so.deliveryOption === "EXPRESS" ? "Express" : "Standard",
          so.order.paymentMethod === "COD" ? "Cash on delivery" : METHOD_NAME[so.order.paymentMethod],
          manilaStamp(so.shipBy),
          so.courier,
          so.trackingNumber,
          manilaStamp(so.shippedAt),
          manilaStamp(so.deliveredAt)
        ];
      })
    );
    const today = manilaStamp(this.now())?.slice(0, 10) ?? "today";
    return { filename: `vendora-orders-${today}.csv`, csv };
  }
}

function cannotShip(status: SellerOrderStatus): AppError {
  if (status === "CANCELLED") return conflict("cancelled", "This order was cancelled, so it can't be shipped.");
  if (status === "AWAITING_PAYMENT") return notFound();
  return conflict("already_delivered", "This package was already delivered, so its shipping details can't change.");
}
