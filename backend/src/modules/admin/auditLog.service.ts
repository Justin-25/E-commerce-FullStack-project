import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { adminUser } from "./access.js";
import { AUDIT_PAGE_SIZE, type AuditArea, type AuditListQuery } from "./admin.schemas.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const AREA_PREFIXES: Record<AuditArea, string[]> = {
  stores: ["store."],
  users: ["user."],
  payouts: ["payout.", "payout_account."],
  refunds: ["refund."],
  admins: ["admin."]
};
/** "2026-11-27" (a Philippine day) → its first moment. */
const manilaDayStart = (day: string) => new Date(Date.parse(`${day}T00:00:00+08:00`));

type Meta = Record<string, unknown> | null;
const str = (m: Meta, key: string) => (m && typeof m[key] === "string" ? (m[key] as string) : "");

/** One row in plain words ("Approved store Lumen Home Studio"); an unknown action shows as it is. */
function summary(action: string, label: string, m: Meta): string {
  const it = label || "a deleted record";
  switch (action) {
    case "store.approve":
      return `Approved store ${it}`;
    case "store.request_changes":
      return `Asked ${it} for changes`;
    case "store.reject":
      return `Rejected the application of ${it}`;
    case "store.view_tin":
      return `Viewed the full TIN of ${it}`;
    case "store.view_document":
      return `Opened a document of ${it}`;
    case "store.suspend":
      return `Suspended store ${it}`;
    case "store.reactivate":
      return `Reactivated store ${it}`;
    case "store.rename": {
      const from = m && typeof m.from === "object" && m.from ? str(m.from as Meta, "name") : "";
      return `Renamed store ${from || "?"} to ${str((m?.to as Meta) ?? null, "name") || it}`;
    }
    case "payout_account.view_number":
      return `Viewed the payout account number of ${it}`;
    case "payout_account.verify":
      return `Verified the payout account of ${it}`;
    case "payout.view_account":
      return `Viewed the account for payout ${it}`;
    case "payout.mark_paid":
      return `Marked payout ${it} paid`;
    case "payout.mark_failed":
      return `Marked payout ${it} failed`;
    case "refund.retry":
      return `Tried the refund for ${it} again`;
    case "refund.mark_sent":
      return `Marked the refund for ${it} as sent`;
    case "user.suspend":
      return `Suspended ${it}`;
    case "user.reactivate":
      return `Reactivated ${it}`;
    case "user.two_factor_reset_requested":
      return `Started a two-step reset for ${it}`;
    case "user.two_factor_reset":
      return `${it} confirmed the two-step reset`;
    case "user.export":
      return `Exported users (${m && typeof m.rows === "number" ? m.rows : "?"} rows)`;
    case "admin.create":
      return `Made ${it} an admin`;
    case "admin.change_roles":
      return `Changed the admin roles of ${it}`;
    case "admin.remove":
      return `Removed ${it} as an admin`;
    default:
      return label ? `${action} · ${label}` : action;
  }
}

/**
 * Admin → Audit log (milestone 7c-2, every admin, whatever their roles): every admin action and every
 * look at sensitive data, newest first, in plain words, with who, when and from which IP. Filters: area
 * (stores, users, payouts, refunds, admins), admin, one record (from a store's or account's page) and
 * Philippine dates. Read-only: the app never edits or deletes these rows.
 */
export class AuditLogService {
  constructor(private readonly deps: { prisma: PrismaClient }) {}

  async list(adminId: string, query: AuditListQuery) {
    const { prisma } = this.deps;
    await adminUser(prisma, adminId);
    const where: Prisma.AuditLogWhereInput = {
      AND: [
        query.area ? { OR: AREA_PREFIXES[query.area].map((p) => ({ action: { startsWith: p } })) } : {},
        query.actor ? { actorId: query.actor } : {},
        query.target ? { targetId: query.target } : {},
        query.from ? { createdAt: { gte: manilaDayStart(query.from) } } : {},
        query.to ? { createdAt: { lt: new Date(manilaDayStart(query.to).getTime() + DAY_MS) } } : {}
      ]
    };
    const [rows, totalItems, admins] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * AUDIT_PAGE_SIZE,
        take: AUDIT_PAGE_SIZE,
        include: { actor: { select: { id: true, name: true } } }
      }),
      prisma.auditLog.count({ where }),
      prisma.user.findMany({ where: { role: "ADMIN" }, orderBy: [{ name: "asc" }, { id: "asc" }], select: { id: true, name: true } })
    ]);
    const labels = await this.labels(rows);
    return {
      items: rows.map((r) => {
        const label = r.targetId ? (labels.get(`${r.targetType}:${r.targetId}`) ?? "") : "";
        return {
          id: r.id,
          at: r.createdAt.toISOString(),
          action: r.action,
          summary: summary(r.action, label, (r.metadata as Meta) ?? null),
          actor: r.actor ? { id: r.actor.id, name: r.actor.name } : null,
          target: r.targetId ? { type: r.targetType, id: r.targetId, label: label || null } : null,
          ip: r.ipAddress,
          metadata: r.metadata
        };
      }),
      admins,
      page: query.page,
      pageSize: AUDIT_PAGE_SIZE,
      totalItems,
      totalPages: Math.ceil(totalItems / AUDIT_PAGE_SIZE)
    };
  }

  /** What each row is about, by name: one query per kind of record on the page. */
  private async labels(rows: { targetType: string; targetId: string | null }[]): Promise<Map<string, string>> {
    const { prisma } = this.deps;
    const ids = (type: string) => [...new Set(rows.filter((r) => r.targetType === type && r.targetId).map((r) => r.targetId as string))];
    const [stores, users, payouts, refunds, accounts] = await Promise.all([
      prisma.store.findMany({ where: { id: { in: ids("store") } }, select: { id: true, name: true } }),
      prisma.user.findMany({ where: { id: { in: ids("user") } }, select: { id: true, name: true, email: true } }),
      prisma.payout.findMany({ where: { id: { in: ids("payout") } }, select: { id: true, reference: true } }),
      prisma.refund.findMany({ where: { id: { in: ids("refund") } }, select: { id: true, payment: { select: { order: { select: { orderNumber: true } } } } } }),
      prisma.payoutAccount.findMany({ where: { id: { in: ids("payout_account") } }, select: { id: true, store: { select: { name: true } } } })
    ]);
    const map = new Map<string, string>();
    for (const s of stores) map.set(`store:${s.id}`, s.name);
    for (const u of users) map.set(`user:${u.id}`, `${u.name} (${u.email})`);
    for (const p of payouts) map.set(`payout:${p.id}`, p.reference);
    for (const r of refunds) map.set(`refund:${r.id}`, `order VD-${r.payment.order.orderNumber}`);
    for (const a of accounts) map.set(`payout_account:${a.id}`, a.store.name);
    return map;
  }
}
