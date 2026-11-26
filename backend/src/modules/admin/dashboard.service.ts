import type { PrismaClient } from "../../generated/prisma/client.js";
import { manilaDayStart, manilaMonth, manilaMonthStart } from "../orders/deadlines.js";
import { manilaDay } from "../stores/visits.js";
import { adminUser } from "./access.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CHART_DAYS = 14;
const percentChange = (now: number, before: number) => (before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : null);

/**
 * Admin → Dashboard (milestone 7a; every admin, whatever their roles): the marketplace this month
 * (sales and orders, compared with the same days of last month), what's waiting for an admin
 * (applications, payout accounts to check, flagged listings, refunds that need a person, payouts in
 * progress), orders per day for 14 days, and the first items of the queues.
 */
export class AdminDashboardService {
  constructor(private readonly deps: { prisma: PrismaClient; now?: () => Date }) {}

  async view(adminId: string) {
    const { prisma } = this.deps;
    const admin = await adminUser(prisma, adminId);
    const now = this.deps.now?.() ?? new Date();
    const month = manilaMonth(now);
    const monthStart = manilaMonthStart(month);
    const previousStart = manilaMonthStart(manilaMonth(new Date(monthStart.getTime() - DAY_MS)));
    // The same stretch of last month (Nov 1–25 against Oct 1–25), never past its end.
    const previousEnd = new Date(Math.min(previousStart.getTime() + (now.getTime() - monthStart.getTime()), monthStart.getTime()));
    const chartFrom = new Date(manilaDayStart(now).getTime() - (CHART_DAYS - 1) * DAY_MS);

    const [sales, perDay, waiting, oldest, changesRequested, accountsToCheck, flags, refunds, payouts, applications, openFlags] = await Promise.all([
      prisma.$queryRaw<{ current: boolean; gmv: bigint; orders: number }[]>`
        SELECT o."placedAt" >= ${monthStart} AS current,
               coalesce(sum(so."subtotalCentavos" + so."deliveryCentavos"), 0)::bigint AS gmv,
               count(DISTINCT o.id)::int AS orders
        FROM seller_orders so JOIN orders o ON o.id = so."orderId"
        WHERE so.status NOT IN ('CANCELLED', 'AWAITING_PAYMENT')
          AND ((o."placedAt" >= ${monthStart} AND o."placedAt" <= ${now}) OR (o."placedAt" >= ${previousStart} AND o."placedAt" < ${previousEnd}))
        GROUP BY 1`,
      prisma.$queryRaw<{ day: string; orders: number }[]>`
        SELECT to_char(o."placedAt" AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD') AS day, count(*)::int AS orders
        FROM orders o WHERE o."placedAt" >= ${chartFrom} AND o."placedAt" <= ${now} AND o.status <> 'CANCELLED'
        GROUP BY 1`,
      prisma.store.count({ where: { status: "PENDING" } }),
      prisma.store.findFirst({ where: { status: "PENDING" }, orderBy: { submittedAt: "asc" }, select: { submittedAt: true } }),
      prisma.store.count({ where: { status: "CHANGES_REQUESTED" } }),
      prisma.payoutAccount.count({ where: { verifiedAt: null, store: { status: { in: ["APPROVED", "SUSPENDED"] } } } }),
      prisma.productFlag.count({ where: { status: "OPEN" } }),
      prisma.refund.groupBy({ by: ["status"], where: { status: { in: ["FAILED", "PENDING"] } }, _count: { _all: true } }),
      prisma.payout.aggregate({ where: { status: "PROCESSING" }, _count: { _all: true }, _sum: { amountCentavos: true } }),
      prisma.store.findMany({
        where: { status: "PENDING" },
        orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
        take: 4,
        select: { id: true, name: true, businessType: true, submittedAt: true, category: { select: { name: true } } }
      }),
      prisma.productFlag.findMany({
        where: { status: "OPEN" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 3,
        select: { id: true, source: true, reason: true, createdAt: true, product: { select: { id: true, title: true, store: { select: { name: true } } } } }
      })
    ]);

    const current = sales.find((s) => s.current);
    const before = sales.find((s) => !s.current);
    const gmv = Number(current?.gmv ?? 0);
    const gmvBefore = Number(before?.gmv ?? 0);
    const byDay = new Map(perDay.map((d) => [d.day, d.orders]));
    const refundCount = (status: "FAILED" | "PENDING") => refunds.find((r) => r.status === status)?._count._all ?? 0;

    return {
      admin: { name: admin.name, roles: admin.roles },
      month,
      sales: { gmvCentavos: gmv, previousCentavos: gmvBefore, change: percentChange(gmv, gmvBefore) },
      orders: { count: current?.orders ?? 0, previous: before?.orders ?? 0, change: percentChange(current?.orders ?? 0, before?.orders ?? 0) },
      waiting: {
        applications: waiting,
        oldestApplicationAt: oldest?.submittedAt?.toISOString() ?? null,
        changesRequested,
        payoutAccountsToCheck: accountsToCheck,
        flaggedListings: flags,
        refundsNeedingAPerson: refundCount("FAILED"),
        refundsRetrying: refundCount("PENDING"),
        payoutsInProgress: payouts._count._all,
        payoutsInProgressCentavos: payouts._sum.amountCentavos ?? 0
      },
      ordersPerDay: Array.from({ length: CHART_DAYS }, (_, i) => {
        const day = manilaDay(new Date(chartFrom.getTime() + i * DAY_MS));
        return { day, orders: byDay.get(day) ?? 0 };
      }),
      queues: {
        applications: applications.map((a) => ({ storeId: a.id, name: a.name, businessType: a.businessType, category: a.category?.name ?? null, submittedAt: a.submittedAt?.toISOString() ?? null })),
        flaggedListings: openFlags.map((f) => ({ id: f.id, source: f.source, reason: f.reason, createdAt: f.createdAt.toISOString(), product: { id: f.product.id, title: f.product.title, store: f.product.store.name } }))
      }
    };
  }
}
