import type { PrismaClient } from "../../generated/prisma/client.js";
import type { CatalogService, ProductCard } from "../catalog/catalog.service.js";
import type { OrderService, OrderView, TrackingStep } from "../orders/orders.service.js";
import { parseOrderNumber } from "./shopperTools.js";

/** What an answer links to, kept with the message: the cards are read live whenever the chat is shown. */
export interface CardRefs {
  products: string[];
  orders: string[];
}

/** The design's order card: "Order #VD-20931 · 2 items", status, stepper, arriving, "Sold by … · Tracking …". */
export interface OrderCard {
  id: string;
  number: string;
  status: OrderView["status"];
  itemCount: number;
  totalCentavos: number;
  packages: {
    store: { slug: string; name: string };
    status: string;
    courier: string | null;
    trackingNumber: string | null;
    estimatedDelivery: { earliest: string; latest: string } | null;
    deliveredAt: string | null;
    steps: { step: TrackingStep; at: string | null }[];
    firstItem: { title: string; imageUrl: string | null } | null;
  }[];
}

export interface Cards {
  products: ProductCard[];
  orders: OrderCard[];
}

const MAX_PRODUCTS = 6;
const MAX_ORDERS = 3;
const PRODUCT_LINK = /\]\(\/products\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi;
const ORDER_LINK = /\]\(\/orders\/(VD-\d{1,9})\)/gi;

const unique = (values: string[], max: number) => [...new Set(values)].slice(0, max);

/** The products and orders an answer links to, in the order they appear. */
export function linkedRefs(text: string): CardRefs {
  return {
    products: unique([...text.matchAll(PRODUCT_LINK)].map((m) => (m[1] ?? "").toLowerCase()), MAX_PRODUCTS),
    orders: unique([...text.matchAll(ORDER_LINK)].map((m) => (m[1] ?? "").toUpperCase()), MAX_ORDERS)
  };
}

/**
 * Cards from the database, never from the answer's text: prices, stock and statuses are always the real,
 * current ones. Products show only while on sale (an invented or removed id simply has no card). Orders only
 * for the chat's owner: a visitor's chat, or a number from someone else's account, gets no card.
 */
export async function resolveCards(deps: { prisma: PrismaClient; catalog: CatalogService; orders: OrderService }, refs: CardRefs, ownerUserId: string | null): Promise<Cards> {
  const products = refs.products.length ? await deps.catalog.cardsByIds(refs.products) : [];
  const orders: OrderCard[] = [];
  if (ownerUserId) {
    for (const ref of refs.orders) {
      const number = parseOrderNumber(ref);
      const row = number === null ? null : await deps.prisma.order.findFirst({ where: { orderNumber: number, userId: ownerUserId }, select: { id: true } });
      if (row) orders.push(orderCard(await deps.orders.view(row.id)));
    }
  }
  return { products, orders };
}

function orderCard(o: OrderView): OrderCard {
  return {
    id: o.id,
    number: o.number,
    status: o.status,
    itemCount: o.itemCount,
    totalCentavos: o.totals.totalCentavos,
    packages: o.packages.map((p) => ({
      store: { slug: p.store.slug, name: p.store.name },
      status: p.status,
      courier: p.courier,
      trackingNumber: p.trackingNumber,
      estimatedDelivery: p.estimatedDelivery,
      deliveredAt: p.deliveredAt,
      steps: p.steps,
      firstItem: p.items[0] ? { title: p.items[0].title, imageUrl: p.items[0].imageUrl } : null
    }))
  };
}
