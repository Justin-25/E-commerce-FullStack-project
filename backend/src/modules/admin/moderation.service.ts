import type { FlagStatus, Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { BackgroundMailer } from "../../lib/backgroundMailer.js";
import type { EmailSender } from "../../lib/email.js";
import { AppError } from "../../lib/errors.js";
import { likeLiteral } from "../../lib/like.js";
import type { Logger } from "../../lib/logger.js";
import { REPORT_REASON_LABEL, type ReportReason } from "../moderation/reports.service.js";
import { shortName } from "../seller/orders.service.js";
import { listingRemovedEmail, listingRestoredEmail, sellerWarnedEmail, storeReactivatedEmail, type WarningOutcome } from "../seller/seller.emails.js";
import { adminUser } from "./access.js";
import { ADMIN_PAGE_SIZE, type ModerationListQuery } from "./admin.schemas.js";
import { audit } from "./audit.js";

type Tx = Prisma.TransactionClient;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A second warning within this many days... */
export const WARNING_WINDOW_DAYS = 90;
/** ...suspends the store for this many (then it comes back by itself; Support can lift it early). */
export const WARNING_SUSPENSION_DAYS = 7;
const notFound = () => new AppError(404, "NOT_FOUND", "This listing doesn't exist.");
const conflict = (reason: string, message: string) => new AppError(409, "CONFLICT", message, { details: { reason } });
const reasonLabel = (reason: string) => REPORT_REASON_LABEL[reason as ReportReason] ?? reason;

/**
 * Admin → Product moderation (milestone 7d, Moderation role). Shoppers' reports are grouped per listing
 * (most reports first). Moderation keeps the listing (the reports are closed) or removes it (hidden from
 * shoppers, the seller can't change it, orders already placed are untouched; the seller is told why), either
 * with a warning to the store. A second warning within 90 days suspends the store for 7 days, at once, in the
 * same transaction (the store row is locked, so two warnings at the same moment count correctly); a job lifts
 * it when the 7 days end, and Support can lift it early. A removed listing can be restored (inactive), with
 * its warning withdrawn if Moderation chooses. Each action is audited with the change; the seller is emailed.
 * No "Confirm it's you" here: these are frequent decisions that move no money (all audited).
 */
export class ModerationService {
  private readonly mailer: BackgroundMailer;

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      email: EmailSender;
      config: { APP_URL: string };
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

  // --- the queue ------------------------------------------------------------------

  async queue(adminId: string, query: ModerationListQuery) {
    const { prisma } = this.deps;
    await adminUser(prisma, adminId, "MODERATION");
    const open = query.tab === "open";
    const status: Prisma.ProductFlagWhereInput = open ? { status: "OPEN" } : { status: { in: ["KEPT", "REMOVED"] } };
    const search: Prisma.ProductFlagWhereInput = query.q
      ? { product: { OR: [{ title: { contains: likeLiteral(query.q), mode: "insensitive" } }, { store: { name: { contains: likeLiteral(query.q), mode: "insensitive" } } }] } }
      : {};
    const where: Prisma.ProductFlagWhereInput = { AND: [status, search] };
    const [groups, allGroups, openListings, resolvedListings] = await Promise.all([
      prisma.productFlag.groupBy({
        by: ["productId"],
        where,
        _count: { _all: true },
        _min: { createdAt: true },
        _max: { resolvedAt: true },
        orderBy: open ? [{ _count: { productId: "desc" } }, { _min: { createdAt: "asc" } }, { productId: "asc" }] : [{ _max: { resolvedAt: "desc" } }, { productId: "asc" }],
        skip: (query.page - 1) * ADMIN_PAGE_SIZE,
        take: ADMIN_PAGE_SIZE
      }),
      prisma.productFlag.groupBy({ by: ["productId"], where }),
      prisma.productFlag.groupBy({ by: ["productId"], where: { status: "OPEN" } }),
      prisma.productFlag.groupBy({ by: ["productId"], where: { status: { in: ["KEPT", "REMOVED"] } } })
    ]);
    const ids = groups.map((g) => g.productId);
    const [products, reasons, buyers] = await Promise.all([
      prisma.product.findMany({
        where: { id: { in: ids } },
        select: { id: true, title: true, slug: true, status: true, images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } }, store: { select: { id: true, name: true, slug: true } } }
      }),
      prisma.productFlag.groupBy({ by: ["productId", "reason"], where: { AND: [status, { productId: { in: ids } }] }, _count: { _all: true } }),
      prisma.productFlag.groupBy({ by: ["productId"], where: { AND: [status, { productId: { in: ids } }, { orderId: { not: null } }] }, _count: { _all: true } })
    ]);
    const byId = new Map(products.map((p) => [p.id, p]));
    return {
      items: groups.flatMap((g) => {
        const p = byId.get(g.productId);
        if (!p) return [];
        return [
          {
            product: { id: p.id, title: p.title, slug: p.slug, status: p.status, imageUrl: p.images[0]?.url ?? null },
            store: p.store,
            reports: g._count._all,
            fromBuyers: buyers.find((b) => b.productId === p.id)?._count._all ?? 0,
            reasons: reasons
              .filter((r) => r.productId === p.id)
              .sort((a, b) => b._count._all - a._count._all || a.reason.localeCompare(b.reason))
              .map((r) => ({ reason: r.reason, label: reasonLabel(r.reason), count: r._count._all })),
            firstReportedAt: g._min.createdAt?.toISOString() ?? null,
            decidedAt: g._max.resolvedAt?.toISOString() ?? null
          }
        ];
      }),
      counts: { open: openListings.length, resolved: resolvedListings.length },
      page: query.page,
      pageSize: ADMIN_PAGE_SIZE,
      totalItems: allGroups.length,
      totalPages: Math.ceil(allGroups.length / ADMIN_PAGE_SIZE)
    };
  }

  // --- one listing ------------------------------------------------------------------

  async listing(adminId: string, productId: string) {
    await adminUser(this.deps.prisma, adminId, "MODERATION");
    return this.load(productId);
  }

  private async load(productId: string) {
    const { prisma } = this.deps;
    const now = this.now();
    const p = await prisma.product.findUnique({
      where: { id: productId },
      include: {
        images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } },
        variants: { where: { isActive: true }, select: { priceCentavos: true } },
        removedBy: { select: { name: true } },
        store: {
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
            suspendedCause: true,
            suspendedUntil: true,
            approvedAt: true,
            warnings: { where: { withdrawnAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, reason: true, createdAt: true, productId: true } }
          }
        }
      }
    });
    if (!p) throw notFound();
    const [flags, history] = await Promise.all([
      prisma.productFlag.findMany({
        where: { productId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 100,
        include: { reporter: { select: { name: true } }, order: { select: { orderNumber: true } }, resolvedBy: { select: { name: true } } }
      }),
      prisma.auditLog.findMany({ where: { targetType: "product", targetId: productId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50, include: { actor: { select: { name: true } } } })
    ]);
    const since = new Date(now.getTime() - WARNING_WINDOW_DAYS * DAY_MS);
    const prices = p.variants.map((v) => v.priceCentavos);
    const open = flags.filter((f) => f.status === "OPEN").length;
    return {
      product: {
        id: p.id,
        title: p.title,
        slug: p.slug,
        status: p.status,
        description: p.description.slice(0, 600),
        imageUrl: p.images[0]?.url ?? null,
        priceCentavos: prices.length ? Math.min(...prices) : null,
        removed: p.status === "REMOVED" ? { at: p.removedAt?.toISOString() ?? null, reason: p.removedReason, by: p.removedBy?.name ?? null } : null
      },
      store: {
        id: p.store.id,
        name: p.store.name,
        slug: p.store.slug,
        status: p.store.status,
        suspendedForWarningsUntil: p.store.suspendedCause === "WARNINGS" ? (p.store.suspendedUntil?.toISOString() ?? null) : null,
        approvedAt: p.store.approvedAt?.toISOString() ?? null,
        warningsIn90Days: p.store.warnings.filter((w) => w.createdAt > since).length,
        warnings: p.store.warnings.map((w) => ({ id: w.id, reason: w.reason, at: w.createdAt.toISOString(), thisListing: w.productId === p.id }))
      },
      reports: flags.map((f) => ({
        id: f.id,
        source: f.source,
        reason: f.reason,
        label: reasonLabel(f.reason),
        message: f.message,
        reporter: f.reporter ? shortName(f.reporter.name) : null,
        order: f.order ? `VD-${f.order.orderNumber}` : null,
        status: f.status,
        at: f.createdAt.toISOString(),
        decidedAt: f.resolvedAt?.toISOString() ?? null,
        decidedBy: f.resolvedBy?.name ?? null
      })),
      openReports: open,
      canKeep: open > 0,
      canRemove: p.status !== "REMOVED",
      canRestore: p.status === "REMOVED",
      history: history.map((h) => ({ action: h.action, by: h.actor?.name ?? "Automatic", at: h.createdAt.toISOString(), metadata: h.metadata }))
    };
  }

  private async product(productId: string) {
    const p = await this.deps.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, title: true, status: true, storeId: true, store: { select: { name: true, owner: { select: { email: true } } } } }
    });
    if (!p) throw notFound();
    return p;
  }

  // --- decisions --------------------------------------------------------------------

  /** Closes the listing's open reports with this outcome; returns how many. */
  private async decide(tx: Tx, productId: string, outcome: Exclude<FlagStatus, "OPEN">, adminId: string, now: Date, note: string | null) {
    const done = await tx.productFlag.updateMany({ where: { productId, status: "OPEN" }, data: { status: outcome, resolvedAt: now, resolvedById: adminId, resolutionNote: note } });
    return done.count;
  }

  /**
   * A warning for the store. The store row is locked first, so two warnings at the same moment are counted
   * one after the other; the second within 90 days suspends a live store for 7 days (a store already
   * suspended, e.g. by Support, keeps its suspension).
   */
  private async warn(tx: Tx, storeId: string, productId: string, reason: string, adminId: string, now: Date): Promise<WarningOutcome> {
    await tx.$queryRaw`SELECT 1 FROM stores WHERE id = ${storeId}::uuid FOR UPDATE`;
    await tx.storeWarning.create({ data: { storeId, productId, reason, issuedById: adminId, createdAt: now } });
    await tx.store.update({ where: { id: storeId }, data: { warningCount: { increment: 1 } } });
    const count = await tx.storeWarning.count({ where: { storeId, withdrawnAt: null, createdAt: { gt: new Date(now.getTime() - WARNING_WINDOW_DAYS * DAY_MS) } } });
    if (count < 2) return { count, suspendedUntil: null };
    const until = new Date(now.getTime() + WARNING_SUSPENSION_DAYS * DAY_MS);
    const suspended = await tx.store.updateMany({
      where: { id: storeId, status: "APPROVED" },
      data: { status: "SUSPENDED", suspendedAt: now, suspendedCause: "WARNINGS", suspendedUntil: until, suspendedReason: `A second warning within ${WARNING_WINDOW_DAYS} days: suspended for ${WARNING_SUSPENSION_DAYS} days.` }
    });
    if (suspended.count !== 1) return { count, suspendedUntil: null };
    await audit(tx, { actorId: adminId, action: "store.suspend", targetType: "store", targetId: storeId, metadata: { cause: "WARNINGS", until: until.toISOString(), warnings: count } });
    return { count, suspendedUntil: until };
  }

  /** "Keep listing": the reports are closed; optionally a warning (something had to change). */
  async keep(adminId: string, productId: string, warning: string | null, ip: string | null) {
    const { prisma, config } = this.deps;
    const admin = await adminUser(prisma, adminId, "MODERATION");
    const p = await this.product(productId);
    const now = this.now();
    const result = await prisma.$transaction(async (tx) => {
      const reports = await this.decide(tx, p.id, "KEPT", admin.id, now, warning);
      if (reports === 0) return { decided: false as const }; // nothing open (another moderator decided meanwhile)
      const warned = warning ? await this.warn(tx, p.storeId, p.id, warning, admin.id, now) : null;
      await audit(tx, { actorId: admin.id, action: "product.keep", targetType: "product", targetId: p.id, metadata: { reports, warned: Boolean(warned), warning, suspendedUntil: warned?.suspendedUntil?.toISOString() ?? null }, ip });
      return { decided: true as const, warned };
    });
    if (!result.decided) throw conflict("nothing_open", "This listing has no open reports any more. Reload to see who decided.");
    if (warning && result.warned) this.mailer.send(sellerWarnedEmail(p.store.owner.email, p.store.name, p.title, warning, result.warned, config.APP_URL));
    return this.load(p.id);
  }

  /** "Remove listing": hidden from shoppers, the seller can't change it, orders already placed are untouched. */
  async remove(adminId: string, productId: string, input: { reason: string; warn: boolean }, ip: string | null) {
    const { prisma, config } = this.deps;
    const admin = await adminUser(prisma, adminId, "MODERATION");
    const p = await this.product(productId);
    if (p.status === "REMOVED") throw conflict("already_removed", "This listing is already removed.");
    const now = this.now();
    const warned = await prisma.$transaction(async (tx) => {
      // Only if it isn't removed yet, checked in the same statement (two moderators at once: one removes it).
      const won = await tx.product.updateMany({ where: { id: p.id, status: { not: "REMOVED" } }, data: { status: "REMOVED", removedAt: now, removedReason: input.reason, removedById: admin.id } });
      if (won.count !== 1) return undefined;
      const reports = await this.decide(tx, p.id, "REMOVED", admin.id, now, input.reason);
      const outcome = input.warn ? await this.warn(tx, p.storeId, p.id, input.reason, admin.id, now) : null;
      await audit(tx, { actorId: admin.id, action: "product.remove", targetType: "product", targetId: p.id, metadata: { reason: input.reason, reports, warned: input.warn, suspendedUntil: outcome?.suspendedUntil?.toISOString() ?? null }, ip });
      return outcome;
    });
    if (warned === undefined) throw conflict("already_removed", "This listing is already removed.");
    this.mailer.send(listingRemovedEmail(p.store.owner.email, p.store.name, p.title, input.reason, warned, config.APP_URL));
    return this.load(p.id);
  }

  /**
   * "Restore listing": back as inactive (the seller turns it on). Optionally withdraws the warning given with
   * its removal; if that leaves fewer than two warnings in 90 days, a 7-day warning suspension ends now too.
   */
  async restore(adminId: string, productId: string, withdrawWarning: boolean, ip: string | null) {
    const { prisma, config } = this.deps;
    const admin = await adminUser(prisma, adminId, "MODERATION");
    const p = await this.product(productId);
    if (p.status !== "REMOVED") throw conflict("not_removed", "This listing isn't removed.");
    const now = this.now();
    const result = await prisma.$transaction(async (tx) => {
      const won = await tx.product.updateMany({ where: { id: p.id, status: "REMOVED" }, data: { status: "ARCHIVED", removedAt: null, removedReason: null, removedById: null } });
      if (won.count !== 1) return null;
      let warningWithdrawn = false;
      let storeBack = false;
      if (withdrawWarning) {
        await tx.$queryRaw`SELECT 1 FROM stores WHERE id = ${p.storeId}::uuid FOR UPDATE`;
        const w = await tx.storeWarning.findFirst({ where: { storeId: p.storeId, productId: p.id, withdrawnAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
        if (w) {
          await tx.storeWarning.update({ where: { id: w.id }, data: { withdrawnAt: now, withdrawnById: admin.id } });
          await tx.store.update({ where: { id: p.storeId }, data: { warningCount: { decrement: 1 } } });
          warningWithdrawn = true;
          const count = await tx.storeWarning.count({ where: { storeId: p.storeId, withdrawnAt: null, createdAt: { gt: new Date(now.getTime() - WARNING_WINDOW_DAYS * DAY_MS) } } });
          if (count < 2) {
            const lifted = await tx.store.updateMany({
              where: { id: p.storeId, status: "SUSPENDED", suspendedCause: "WARNINGS" },
              data: { status: "APPROVED", suspendedAt: null, suspendedCause: null, suspendedReason: null, suspendedUntil: null }
            });
            if (lifted.count === 1) {
              storeBack = true;
              await audit(tx, { actorId: admin.id, action: "store.reactivate", targetType: "store", targetId: p.storeId, metadata: { cause: "WARNINGS", via: "warning_withdrawn" }, ip });
            }
          }
        }
      }
      await audit(tx, { actorId: admin.id, action: "product.restore", targetType: "product", targetId: p.id, metadata: { warningWithdrawn, storeBack }, ip });
      return { warningWithdrawn, storeBack };
    });
    if (!result) throw conflict("not_removed", "This listing isn't removed.");
    this.mailer.send(listingRestoredEmail(p.store.owner.email, p.store.name, p.title, result, config.APP_URL));
    return this.load(p.id);
  }

  // --- the job ----------------------------------------------------------------------

  /** Background job (every 15 minutes): 7-day warning suspensions that ended. Each store once (conditional update). */
  async liftEndedSuspensions(): Promise<number> {
    const { prisma, config, logger } = this.deps;
    const now = this.now();
    const due = await prisma.store.findMany({
      where: { status: "SUSPENDED", suspendedCause: "WARNINGS", suspendedUntil: { lte: now } },
      select: { id: true, name: true, owner: { select: { email: true } } },
      take: 100
    });
    let lifted = 0;
    for (const s of due) {
      const done = await prisma.$transaction(async (tx) => {
        const won = await tx.store.updateMany({
          where: { id: s.id, status: "SUSPENDED", suspendedCause: "WARNINGS", suspendedUntil: { lte: now } },
          data: { status: "APPROVED", suspendedAt: null, suspendedCause: null, suspendedReason: null, suspendedUntil: null }
        });
        if (won.count !== 1) return false;
        await audit(tx, { actorId: null, action: "store.reactivate", targetType: "store", targetId: s.id, metadata: { cause: "WARNINGS", via: "automatic" } });
        return true;
      });
      if (!done) continue;
      lifted++;
      this.mailer.send(storeReactivatedEmail(s.owner.email, s.name, config.APP_URL));
    }
    if (lifted) logger?.info({ lifted }, "7-day warning suspensions ended");
    return lifted;
  }
}
