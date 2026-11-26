import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { autoCancelAt, manilaCutoff, manilaDayStart, manilaTime } from "../orders/deadlines.js";
import { manilaDay, type VisitService } from "../stores/visits.js";
import { sellerStore } from "./access.js";
import { ROW_INCLUDE, sellerOrderRow } from "./orders.service.js";
import { SELLER_LOW_STOCK } from "./products.schemas.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const RECENT_ORDERS = 5;

/** "Last 7 days" or "Last 30 days" (today included). */
export const dashboardQuerySchema = z.object({
  period: z.enum(["7d", "30d"], { error: "Choose 7d or 30d" }).default("7d")
});
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

export interface DashboardTask {
  kind: "ship_today" | "late" | "out_of_stock" | "low_stock" | "payout_account" | "store_review" | "store_suspended";
  count: number;
  title: string;
  detail: string;
}

/** +12.4 (percent) compared with the period before; null when there's nothing to compare with. */
const percentChange = (now: number, before: number) => (before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : null);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Seller Center → Dashboard (milestone 6d): how the store did in the last 7 or 30 days (sales,
 * orders, store visits, rating, each against the period before), sales per day, the latest orders
 * and what needs attention now. Days are Philippine days; sales are what paid packages cost the
 * buyers (items, before Vendora's fee), cancelled packages left out.
 */
export class DashboardService {
  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      visits: VisitService;
      now?: () => Date;
    }
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  async view(userId: string, query: DashboardQuery) {
    const { prisma } = this.deps;
    const store = await sellerStore(prisma, userId, { write: false });
    const now = this.now();
    const days = query.period === "30d" ? 30 : 7;
    const from = new Date(manilaDayStart(now).getTime() - (days - 1) * DAY_MS);
    const previousFrom = new Date(from.getTime() - days * DAY_MS);
    const cutoff = manilaCutoff(now);

    const [totals, perDay, recent, toShip, rating, ratingBefore, stock, visitsByDay, details] = await Promise.all([
      prisma.$queryRaw<{ current: boolean; orders: number; sales: bigint }[]>`
        SELECT o."placedAt" >= ${from} AS current, count(*)::int AS orders, coalesce(sum(so."subtotalCentavos"), 0)::bigint AS sales
        FROM seller_orders so JOIN orders o ON o.id = so."orderId"
        WHERE so."storeId" = ${store.id}::uuid AND o."placedAt" >= ${previousFrom} AND o."placedAt" <= ${now}
          AND so.status NOT IN ('CANCELLED', 'AWAITING_PAYMENT')
        GROUP BY 1`,
      prisma.$queryRaw<{ day: string; sales: bigint }[]>`
        SELECT to_char(o."placedAt" AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD') AS day, coalesce(sum(so."subtotalCentavos"), 0)::bigint AS sales
        FROM seller_orders so JOIN orders o ON o.id = so."orderId"
        WHERE so."storeId" = ${store.id}::uuid AND o."placedAt" >= ${from} AND o."placedAt" <= ${now} AND so.status NOT IN ('CANCELLED', 'AWAITING_PAYMENT')
        GROUP BY 1`,
      prisma.sellerOrder.findMany({ where: { storeId: store.id, order: { placedAt: { not: null } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: RECENT_ORDERS, include: ROW_INCLUDE }),
      // Every late package (whatever its time), plus those due by today's 6:00 PM (after it, only late ones are left).
      prisma.sellerOrder.findMany({ where: { storeId: store.id, status: "PREPARING", order: { placedAt: { not: null } }, shipBy: { lte: now > cutoff ? now : cutoff } }, select: { shipBy: true } }),
      prisma.store.findUniqueOrThrow({ where: { id: store.id }, select: { ratingAvg: true, ratingCount: true } }),
      prisma.$queryRaw<{ avg: number | null }[]>`
        SELECT avg(r.rating)::float8 AS avg FROM reviews r JOIN products p ON p.id = r."productId"
        WHERE p."storeId" = ${store.id}::uuid AND r.status = 'PUBLISHED' AND r."createdAt" < ${from}`,
      prisma.$queryRaw<{ out: number; low: number }[]>`
        SELECT count(*) FILTER (WHERE v.stock = 0)::int AS out,
               count(*) FILTER (WHERE v.stock > 0 AND v.stock < ${SELLER_LOW_STOCK} AND p."lowStockAlert")::int AS low
        FROM product_variants v JOIN products p ON p.id = v."productId"
        WHERE p."storeId" = ${store.id}::uuid AND p.status = 'ACTIVE' AND v."isActive"`,
      this.deps.visits.daily(store.id, previousFrom),
      prisma.store.findUniqueOrThrow({ where: { id: store.id }, select: { payoutAccount: { select: { verifiedAt: true } } } })
    ]);

    const current = totals.find((t) => t.current);
    const previous = totals.find((t) => !t.current);
    const sales = Number(current?.sales ?? 0);
    const salesBefore = Number(previous?.sales ?? 0);
    const orders = current?.orders ?? 0;
    const ordersBefore = previous?.orders ?? 0;

    // Visits: this period and the one before, by Philippine day.
    const dayList = (start: Date) => Array.from({ length: days }, (_, i) => manilaDay(new Date(start.getTime() + i * DAY_MS)));
    const visits = dayList(from).reduce((s, d) => s + (visitsByDay.get(d) ?? 0), 0);
    const visitsBefore = dayList(previousFrom).reduce((s, d) => s + (visitsByDay.get(d) ?? 0), 0);

    const salesByDay = new Map(perDay.map((d) => [d.day, Number(d.sales)]));
    const chart = dayList(from).map((day) => ({ day, salesCentavos: salesByDay.get(day) ?? 0 }));
    const best = chart.reduce<{ day: string; salesCentavos: number } | null>((b, d) => (d.salesCentavos > 0 && (!b || d.salesCentavos > b.salesCentavos) ? d : b), null);

    const avg = Number(rating.ratingAvg);
    const before = ratingBefore[0]?.avg ?? null;
    const late = toShip.filter((p) => p.shipBy && p.shipBy <= now);
    const dueToday = toShip.length - late.length;

    // Needs attention: only what the seller can act on now.
    const tasks: DashboardTask[] = [];
    if (store.status === "PENDING") tasks.push({ kind: "store_review", count: 1, title: "Your store is being reviewed", detail: "Your products go live once it's approved (1–2 business days)." });
    if (store.status === "SUSPENDED") tasks.push({ kind: "store_suspended", count: 1, title: "Your store is suspended", detail: "Shoppers can't see your products. Contact Vendora support." });
    if (late.length) {
      const earliest = late.reduce((e, p) => (p.shipBy && p.shipBy < e ? p.shipBy : e), late[0]?.shipBy ?? now);
      tasks.push({ kind: "late", count: late.length, title: `${plural(late.length, "order is", "orders are")} late`, detail: `Ship or cancel: not shipped by ${manilaTime.format(autoCancelAt(earliest))}, they're cancelled automatically.` });
    }
    if (dueToday) tasks.push({ kind: "ship_today", count: dueToday, title: `${plural(dueToday, "order", "orders")} to ship today`, detail: `Ship by ${manilaTime.format(cutoff)}.` });
    const s = stock[0];
    if (s?.out) tasks.push({ kind: "out_of_stock", count: s.out, title: `${plural(s.out, "item is", "items are")} out of stock`, detail: "Shoppers can't buy them until you restock." });
    if (s?.low) tasks.push({ kind: "low_stock", count: s.low, title: `${plural(s.low, "item is", "items are")} running low`, detail: `Fewer than ${SELLER_LOW_STOCK} left.` });
    const account = details.payoutAccount;
    if (!account) tasks.push({ kind: "payout_account", count: 1, title: "Add a payout account", detail: "We need it to send you your sales." });
    else if (!account.verifiedAt) tasks.push({ kind: "payout_account", count: 1, title: "Your payout account is being checked", detail: "Payouts start once it's verified." });

    return {
      store: { name: store.name, status: store.status },
      period: { days, from: from.toISOString(), to: now.toISOString() },
      stats: {
        sales: { centavos: sales, previousCentavos: salesBefore, change: percentChange(sales, salesBefore) },
        orders: { count: orders, previous: ordersBefore, change: percentChange(orders, ordersBefore), toShipToday: dueToday + late.length },
        visits: { count: visits, previous: visitsBefore, change: percentChange(visits, visitsBefore) },
        rating: { average: Math.round(avg * 10) / 10, count: rating.ratingCount, change: before === null || rating.ratingCount === 0 ? null : Math.round((avg - before) * 10) / 10 }
      },
      chart: { days: chart, totalCentavos: sales, bestDay: best?.day ?? null },
      recentOrders: recent.map((so) => sellerOrderRow(so, now)),
      tasks
    };
  }
}
