import type { Prisma, PrismaClient, StoreStatus } from "../../generated/prisma/client.js";
import { BackgroundMailer } from "../../lib/backgroundMailer.js";
import type { EmailSender } from "../../lib/email.js";
import { AppError } from "../../lib/errors.js";
import { likeLiteral } from "../../lib/like.js";
import type { Logger } from "../../lib/logger.js";
import { isUniqueViolation } from "../../lib/prismaErrors.js";
import { storeReactivatedEmail, storeRenamedEmail, storeSuspendedEmail } from "../seller/seller.emails.js";
import { RESERVED_STORE_SLUGS, storeSlug } from "../seller/seller.schemas.js";
import { adminUser } from "./access.js";
import { ADMIN_PAGE_SIZE, type StoreListQuery, type StoreTab } from "./admin.schemas.js";
import { audit } from "./audit.js";

const STATUSES: Record<StoreTab, StoreStatus[]> = { live: ["APPROVED"], suspended: ["SUSPENDED"], all: ["APPROVED", "SUSPENDED"] };
const notFound = () => new AppError(404, "NOT_FOUND", "This store doesn't exist (applications are on Seller approvals).");
const conflict = (reason: string, message: string, field?: string) =>
  new AppError(409, "CONFLICT", message, { details: { reason }, ...(field ? { fields: [{ path: field, message }] } : {}) });
const nameTaken = () => conflict("name_taken", "This store name is taken (or was another store's name). Please choose another.", "name");

/**
 * Admin → Stores (milestone 7c-2, Support role): live and suspended stores (applications stay on
 * Seller approvals). Each action asks "Confirm it's you", is audited in the same transaction, and the
 * seller is emailed.
 *
 * - Suspend (with a reason the seller sees): hidden from shoppers, nothing can be changed, payouts pause;
 *   orders already paid still have to be shipped (late ones are cancelled and refunded by the 6c-2 job).
 * - Reactivate: only a store Support (or warnings, 7d) suspended; one that went down with its owner's
 *   account comes back by reactivating the account.
 * - Rename: the same name rules sellers have; the old address redirects to the store forever and stays
 *   reserved (no other store can take it). Renaming back to an old name takes it back.
 */
export class StoreAdminService {
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

  // --- the list -------------------------------------------------------------------

  async list(adminId: string, query: StoreListQuery) {
    const { prisma } = this.deps;
    await adminUser(prisma, adminId, "SUPPORT");
    const q = query.q;
    const search: Prisma.StoreWhereInput = q
      ? {
          OR: [
            { name: { contains: likeLiteral(q), mode: "insensitive" } },
            { slug: { contains: likeLiteral(q.toLowerCase()) } },
            { owner: { email: { contains: likeLiteral(q.toLowerCase()) } } },
            { owner: { name: { contains: likeLiteral(q), mode: "insensitive" } } }
          ]
        }
      : {};
    const where: Prisma.StoreWhereInput = { AND: [{ status: { in: STATUSES[query.tab] } }, search] };
    const count = (tab: StoreTab) => prisma.store.count({ where: { status: { in: STATUSES[tab] } } });
    const [rows, totalItems, live, suspended, all] = await Promise.all([
      prisma.store.findMany({
        where,
        orderBy: [{ approvedAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * ADMIN_PAGE_SIZE,
        take: ADMIN_PAGE_SIZE,
        include: { owner: { select: { id: true, name: true, email: true } }, category: { select: { name: true } }, _count: { select: { products: { where: { status: "ACTIVE" } } } } }
      }),
      prisma.store.count({ where }),
      count("live"),
      count("suspended"),
      count("all")
    ]);
    return {
      items: rows.map((s) => ({
        id: s.id,
        name: s.name,
        slug: s.slug,
        logoUrl: s.logoUrl,
        owner: s.owner,
        category: s.category?.name ?? null,
        products: s._count.products,
        rating: { average: Number(s.ratingAvg), count: s.ratingCount },
        followers: s.followerCount,
        status: s.status,
        suspendedCause: s.suspendedCause,
        approvedAt: s.approvedAt?.toISOString() ?? null
      })),
      counts: { live, suspended, all },
      page: query.page,
      pageSize: ADMIN_PAGE_SIZE,
      totalItems,
      totalPages: Math.ceil(totalItems / ADMIN_PAGE_SIZE)
    };
  }

  // --- one store ------------------------------------------------------------------

  async view(adminId: string, storeId: string) {
    await adminUser(this.deps.prisma, adminId, "SUPPORT");
    return this.load(storeId);
  }

  private async load(storeId: string) {
    const { prisma } = this.deps;
    const s = await prisma.store.findFirst({
      where: { id: storeId, status: { in: ["APPROVED", "SUSPENDED"] } },
      include: {
        owner: { select: { id: true, name: true, email: true, status: true } },
        category: { select: { name: true } },
        payoutAccount: { select: { method: true, bankName: true, last4: true, verifiedAt: true } },
        oldSlugs: { orderBy: [{ createdAt: "desc" }, { slug: "asc" }], select: { slug: true, createdAt: true } },
        _count: { select: { products: { where: { status: "ACTIVE" } }, sellerOrders: { where: { order: { placedAt: { not: null } } } } } }
      }
    });
    if (!s) throw notFound();
    const history = await prisma.auditLog.findMany({
      where: { targetType: "store", targetId: s.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 50,
      include: { actor: { select: { name: true } } }
    });
    return {
      id: s.id,
      name: s.name,
      slug: s.slug,
      logoUrl: s.logoUrl,
      status: s.status,
      category: s.category?.name ?? null,
      shipsFrom: s.shipsFrom,
      approvedAt: s.approvedAt?.toISOString() ?? null,
      owner: s.owner,
      suspension:
        s.status === "SUSPENDED"
          ? { at: s.suspendedAt?.toISOString() ?? null, cause: s.suspendedCause, reason: s.suspendedReason, until: s.suspendedUntil?.toISOString() ?? null }
          : null,
      rating: { average: Number(s.ratingAvg), count: s.ratingCount },
      followers: s.followerCount,
      warnings: s.warningCount,
      products: s._count.products,
      orders: s._count.sellerOrders,
      payoutAccount: s.payoutAccount
        ? { method: s.payoutAccount.method, bankName: s.payoutAccount.bankName, last4: s.payoutAccount.last4, verified: s.payoutAccount.verifiedAt !== null }
        : null,
      previousAddresses: s.oldSlugs.map((o) => ({ slug: o.slug, until: o.createdAt.toISOString() })),
      canSuspend: s.status === "APPROVED",
      canReactivate: s.status === "SUSPENDED" && s.suspendedCause !== "ACCOUNT",
      history: history.map((h) => ({ action: h.action, by: h.actor?.name ?? "A command on the server", at: h.createdAt.toISOString(), metadata: h.metadata }))
    };
  }

  private async store(storeId: string) {
    const s = await this.deps.prisma.store.findFirst({
      where: { id: storeId, status: { in: ["APPROVED", "SUSPENDED"] } },
      select: { id: true, name: true, slug: true, status: true, suspendedCause: true, owner: { select: { email: true } } }
    });
    if (!s) throw notFound();
    return s;
  }

  // --- actions ----------------------------------------------------------------------

  /** "Suspend store" (see the class comment). */
  async suspend(adminId: string, storeId: string, reason: string, ctx: { ensureConfirmed: () => Promise<void>; ip: string | null }) {
    const { prisma, config } = this.deps;
    const admin = await adminUser(prisma, adminId, "SUPPORT");
    const s = await this.store(storeId);
    if (s.status !== "APPROVED") throw conflict("not_live", "This store is already suspended.");
    await ctx.ensureConfirmed();
    const now = this.now();
    const done = await prisma.$transaction(async (tx) => {
      // Only a live store, checked in the same statement (two admins at once: one suspends it).
      const won = await tx.store.updateMany({ where: { id: s.id, status: "APPROVED" }, data: { status: "SUSPENDED", suspendedAt: now, suspendedCause: "ADMIN", suspendedReason: reason } });
      if (won.count !== 1) return false;
      await audit(tx, { actorId: admin.id, action: "store.suspend", targetType: "store", targetId: s.id, metadata: { reason }, ip: ctx.ip });
      return true;
    });
    if (!done) throw conflict("not_live", "This store is already suspended.");
    this.mailer.send(storeSuspendedEmail(s.owner.email, s.name, reason, config.APP_URL));
    return this.load(s.id);
  }

  /** "Reactivate store": not one that went down with its owner's account (reactivate the account instead). */
  async reactivate(adminId: string, storeId: string, ctx: { ensureConfirmed: () => Promise<void>; ip: string | null }) {
    const { prisma, config } = this.deps;
    const admin = await adminUser(prisma, adminId, "SUPPORT");
    const s = await this.store(storeId);
    if (s.status !== "SUSPENDED") throw conflict("not_suspended", "This store isn't suspended.");
    if (s.suspendedCause === "ACCOUNT") throw conflict("suspended_with_account", "This store went down with its owner's account. Reactivate the account (Users) instead.");
    await ctx.ensureConfirmed();
    const done = await prisma.$transaction(async (tx) => {
      const won = await tx.store.updateMany({
        where: { id: s.id, status: "SUSPENDED", suspendedCause: { in: ["ADMIN", "WARNINGS"] } },
        data: { status: "APPROVED", suspendedAt: null, suspendedCause: null, suspendedReason: null, suspendedUntil: null }
      });
      if (won.count !== 1) return false;
      await audit(tx, { actorId: admin.id, action: "store.reactivate", targetType: "store", targetId: s.id, metadata: { cause: s.suspendedCause }, ip: ctx.ip });
      return true;
    });
    if (!done) throw conflict("not_suspended", "This store changed meanwhile. Reload and check it again.");
    this.mailer.send(storeReactivatedEmail(s.owner.email, s.name, config.APP_URL));
    return this.load(s.id);
  }

  /** "Rename store" (see the class comment). */
  async rename(adminId: string, storeId: string, name: string, ctx: { ensureConfirmed: () => Promise<void>; ip: string | null }) {
    const { prisma, config } = this.deps;
    const admin = await adminUser(prisma, adminId, "SUPPORT");
    const s = await this.store(storeId);
    const slug = storeSlug(name);
    if (RESERVED_STORE_SLUGS.includes(slug) || slug.includes("vendora")) throw conflict("name_reserved", "This name is reserved. Please choose another.", "name");
    if (name === s.name) throw conflict("same_name", "That's already the store's name.", "name");
    await ctx.ensureConfirmed();
    const now = this.now();
    let from: { name: string; slug: string };
    try {
      from = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM stores WHERE id = ${s.id}::uuid FOR UPDATE`; // one rename of this store at a time
        const current = await tx.store.findUniqueOrThrow({ where: { id: s.id }, select: { name: true, slug: true } });
        if (slug !== current.slug) {
          const other = await tx.store.findUnique({ where: { slug }, select: { id: true } });
          if (other) throw nameTaken();
          // Another store's old address stays reserved forever; this store's own old one it can take back.
          const old = await tx.storeSlugRedirect.findUnique({ where: { slug }, select: { storeId: true } });
          if (old && old.storeId !== s.id) throw nameTaken();
          if (old) await tx.storeSlugRedirect.delete({ where: { slug } });
          await tx.storeSlugRedirect.create({ data: { slug: current.slug, storeId: s.id, createdAt: now } });
        }
        await tx.store.update({ where: { id: s.id }, data: { name, slug } });
        await audit(tx, { actorId: admin.id, action: "store.rename", targetType: "store", targetId: s.id, metadata: { from: current, to: { name, slug } }, ip: ctx.ip });
        return current;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken(); // another store took the name at the same moment
      throw err;
    }
    this.mailer.send(storeRenamedEmail(s.owner.email, from.name, name, slug, config.APP_URL));
    return this.load(s.id);
  }
}
