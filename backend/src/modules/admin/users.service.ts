import type { Prisma, PrismaClient, Role } from "../../generated/prisma/client.js";
import { BackgroundMailer } from "../../lib/backgroundMailer.js";
import { toCsv } from "../../lib/csv.js";
import { randomToken } from "../../lib/crypto.js";
import type { EmailSender } from "../../lib/email.js";
import { AppError } from "../../lib/errors.js";
import type { KeyValueStore } from "../../lib/kv.js";
import { likeLiteral } from "../../lib/like.js";
import type { Logger } from "../../lib/logger.js";
import { describeDevice } from "../../lib/userAgent.js";
import { accountReactivatedMessage, accountSuspendedMessage, twoFactorResetRequestMessage } from "../auth/auth.emails.js";
import { authKeys } from "../auth/keys.js";
import { LOCKOUT } from "../auth/lockout.js";
import { bestEffort, SessionRevoker } from "../auth/sessionRevoker.js";
import { ACCESS_TTL_SECONDS } from "../auth/tokens.js";
import { TrustedDevices } from "../auth/trustedDevices.js";
import { TWO_FACTOR_RESET_TTL_SECONDS, twoFactorResetHash } from "../auth/twoFactorReset.js";
import { adminUser } from "./access.js";
import { ADMIN_PAGE_SIZE, USER_EXPORT_LIMIT, type UserListQuery, type UserTab } from "./admin.schemas.js";
import { audit } from "./audit.js";

const ROLE_OF: Partial<Record<UserTab, Role>> = { customers: "CUSTOMER", sellers: "SELLER", admins: "ADMIN" };
const LOCK_MS = LOCKOUT.lockSeconds * 1000;
const HOUR_MS = 60 * 60 * 1000;
const manilaStamp = (d: Date) => new Date(d.getTime() + 8 * HOUR_MS).toISOString().slice(0, 16).replace("T", " ");
const notFound = () => new AppError(404, "NOT_FOUND", "This account doesn't exist.");
const conflict = (reason: string, message: string) => new AppError(409, "CONFLICT", message, { details: { reason } });

const ROW_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  adminRoles: true,
  status: true,
  twoFactorEnabledAt: true,
  createdAt: true,
  _count: { select: { orders: { where: { placedAt: { not: null } } } } },
  securityEvents: { where: { type: "LOCKED" }, orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } }
} satisfies Prisma.UserSelect;
type Row = Prisma.UserGetPayload<{ select: typeof ROW_SELECT }>;

/**
 * Admin → Users (milestone 7c-1, Support role). The list (tabs, search, Export CSV), one account's
 * details, and Support's account actions, each asking "Confirm it's you" first and written to the
 * audit log in the same transaction:
 *
 * - Suspend: takes effect at once, even in an open session (sign-in refused, every sign-in ended, and
 *   its access passes refused through the per-user "invalid before" key). A seller's live store is
 *   suspended with the account (hidden from shoppers; paid orders they can't ship are cancelled and
 *   refunded after the ship-by deadline). The person is emailed the reason.
 * - Reactivate: the account, and the store if the suspension took it down.
 * - Reset two-step verification: Support writes how they checked who the person is; nothing happens
 *   until the owner opens the link sent to their verified email (SecurityService.confirmTwoFactorReset).
 *
 * Admin accounts are never changed here (only by the server command), so one admin can't lock out another.
 * Locks after wrong passwords are shown ("Locked until 3:42 PM") but never lifted here: they end by
 * themselves in 15 minutes, and the owner can reset their password.
 */
export class UserAdminService {
  private readonly mailer: BackgroundMailer;
  private readonly revoker: SessionRevoker;
  private readonly trustedDevices: TrustedDevices;

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      kv: KeyValueStore;
      email: EmailSender;
      config: { APP_URL: string; CODE_HASH_SECRET: string };
      logger?: Logger;
      now?: () => Date;
    }
  ) {
    this.mailer = new BackgroundMailer(deps.email, deps.logger);
    this.revoker = new SessionRevoker(deps.prisma, deps.kv, deps.logger, () => this.now());
    this.trustedDevices = new TrustedDevices(deps.prisma, () => this.now());
  }

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  async drain(): Promise<void> {
    await this.mailer.drain();
  }

  // --- the list -------------------------------------------------------------------

  private where(tab: UserTab, q: string | undefined, now: Date): Prisma.UserWhereInput {
    const byTab: Prisma.UserWhereInput =
      tab === "locked_suspended"
        ? { OR: [{ status: "SUSPENDED" }, { securityEvents: { some: { type: "LOCKED", createdAt: { gt: new Date(now.getTime() - LOCK_MS) } } } }] }
        : ROLE_OF[tab]
          ? { role: ROLE_OF[tab] }
          : {};
    const search: Prisma.UserWhereInput = q ? { OR: [{ name: { contains: likeLiteral(q), mode: "insensitive" } }, { email: { contains: likeLiteral(q.toLowerCase()) } }] } : {};
    return { AND: [{ deletedAt: null }, byTab, search] };
  }

  /** Locked after wrong passwords: until when (about; a lock lasts 15 minutes), or null. */
  private lockedUntil(lastLock: Date | undefined, now: Date): Date | null {
    if (!lastLock) return null;
    const until = new Date(lastLock.getTime() + LOCK_MS);
    return until > now ? until : null;
  }

  private item(u: Row, now: Date) {
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      adminRoles: u.adminRoles,
      twoFactor: u.twoFactorEnabledAt !== null,
      orders: u._count.orders,
      joinedAt: u.createdAt.toISOString(),
      status: u.status,
      lockedUntil: this.lockedUntil(u.securityEvents[0]?.createdAt, now)?.toISOString() ?? null
    };
  }

  async list(adminId: string, query: UserListQuery) {
    const { prisma } = this.deps;
    await adminUser(prisma, adminId, "SUPPORT");
    const now = this.now();
    const where = this.where(query.tab, query.q, now);
    const count = (tab: UserTab) => prisma.user.count({ where: this.where(tab, undefined, now) });
    const [rows, totalItems, all, customers, sellers, admins, lockedSuspended] = await Promise.all([
      prisma.user.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (query.page - 1) * ADMIN_PAGE_SIZE, take: ADMIN_PAGE_SIZE, select: ROW_SELECT }),
      prisma.user.count({ where }),
      count("all"),
      count("customers"),
      count("sellers"),
      count("admins"),
      count("locked_suspended")
    ]);
    return {
      items: rows.map((u) => this.item(u, now)),
      counts: { all, customers, sellers, admins, lockedSuspended },
      page: query.page,
      pageSize: ADMIN_PAGE_SIZE,
      totalItems,
      totalPages: Math.ceil(totalItems / ADMIN_PAGE_SIZE)
    };
  }

  /** "Export CSV": the list's accounts (up to 5,000), only the columns the list shows. Each export is logged. */
  async exportCsv(adminId: string, query: { tab: UserTab; q: string | undefined }, ip: string | null): Promise<{ filename: string; csv: string }> {
    const { prisma } = this.deps;
    const admin = await adminUser(prisma, adminId, "SUPPORT");
    const now = this.now();
    const rows = await prisma.user.findMany({ where: this.where(query.tab, query.q, now), orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: USER_EXPORT_LIMIT, select: ROW_SELECT });
    const csv = toCsv(
      ["Name", "Email", "Role", "Two-step", "Orders", "Joined (PH time)", "Status"],
      rows.map((u) => {
        const item = this.item(u, now);
        const status = item.status === "SUSPENDED" ? "Suspended" : item.lockedUntil ? `Locked until ${manilaStamp(new Date(item.lockedUntil))}` : "Active";
        return [u.name, u.email, u.role.charAt(0) + u.role.slice(1).toLowerCase(), item.twoFactor ? "On" : "Off", item.orders, manilaStamp(u.createdAt), status];
      })
    );
    await audit(prisma, { actorId: admin.id, action: "user.export", targetType: "user", targetId: null, metadata: { tab: query.tab, q: query.q ?? null, rows: rows.length }, ip });
    return { filename: `vendora-users-${query.tab}-${manilaStamp(now).slice(0, 10)}.csv`, csv };
  }

  // --- one account ----------------------------------------------------------------

  async view(adminId: string, userId: string) {
    await adminUser(this.deps.prisma, adminId, "SUPPORT");
    return this.load(userId);
  }

  private async load(userId: string) {
    const { prisma } = this.deps;
    const now = this.now();
    const u = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      include: {
        store: { select: { id: true, name: true, slug: true, status: true, suspendedCause: true } },
        suspendedBy: { select: { name: true } },
        oauthAccounts: { select: { provider: true } },
        _count: { select: { orders: { where: { placedAt: { not: null } } }, backupCodes: { where: { usedAt: null } }, sessions: { where: { revokedAt: null, expiresAt: { gt: now } } } } }
      }
    });
    if (!u) throw notFound();
    const [events, lastLock, history, reset] = await Promise.all([
      prisma.securityEvent.findMany({ where: { userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20 }),
      prisma.securityEvent.findFirst({ where: { userId, type: "LOCKED" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
      prisma.auditLog.findMany({ where: { targetType: "user", targetId: userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50, include: { actor: { select: { name: true } } } }),
      prisma.twoFactorReset.findFirst({ where: { userId, confirmedAt: null, cancelledAt: null, expiresAt: { gt: now } }, orderBy: { createdAt: "desc" }, include: { requestedBy: { select: { name: true } } } })
    ]);
    const changeable = u.role !== "ADMIN";
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      emailVerified: u.emailVerifiedAt !== null,
      role: u.role,
      adminRoles: u.adminRoles,
      status: u.status,
      joinedAt: u.createdAt.toISOString(),
      lastSignInAt: u.lastLoginAt?.toISOString() ?? null,
      suspended: u.status === "SUSPENDED" ? { at: u.suspendedAt?.toISOString() ?? null, reason: u.suspendedReason, by: u.suspendedBy?.name ?? null } : null,
      twoFactor: { enabled: u.twoFactorEnabledAt !== null, enabledAt: u.twoFactorEnabledAt?.toISOString() ?? null, backupCodesLeft: u._count.backupCodes },
      google: u.oauthAccounts.some((a) => a.provider === "GOOGLE"),
      lockedUntil: this.lockedUntil(lastLock?.createdAt, now)?.toISOString() ?? null,
      orders: u._count.orders,
      openSessions: u._count.sessions,
      store: u.store ? { id: u.store.id, name: u.store.name, slug: u.store.slug, status: u.store.status, suspendedWithAccount: u.store.suspendedCause === "ACCOUNT" } : null,
      twoFactorReset: reset ? { requestedAt: reset.createdAt.toISOString(), expiresAt: reset.expiresAt.toISOString(), by: reset.requestedBy?.name ?? null } : null,
      canSuspend: changeable && u.status === "ACTIVE",
      canReactivate: changeable && u.status === "SUSPENDED",
      canResetTwoFactor: changeable && u.status === "ACTIVE" && u.twoFactorEnabledAt !== null,
      securityActivity: events.map((e) => ({ type: e.type, at: e.createdAt.toISOString(), ip: e.ipAddress, device: describeDevice(e.userAgent).label, location: e.location })),
      history: history.map((h) => ({ action: h.action, by: h.actor?.name ?? "A command on the server", at: h.createdAt.toISOString(), metadata: h.metadata }))
    };
  }

  /** The account an action is about: never an admin's (those change only by the server command). */
  private async target(userId: string) {
    const u = await this.deps.prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: { id: true, name: true, email: true, role: true, status: true, twoFactorEnabledAt: true } });
    if (!u) throw notFound();
    if (u.role === "ADMIN") {
      throw new AppError(403, "FORBIDDEN", "Admin accounts change only with the server command (npm run admin:remove).", { details: { reason: "admin_target" } });
    }
    return u;
  }

  // --- actions ----------------------------------------------------------------------

  /** "Suspend account" (see the class comment). */
  async suspend(adminId: string, userId: string, reason: string, ctx: { ensureConfirmed: () => Promise<void>; ip: string | null }) {
    const { prisma, kv, logger } = this.deps;
    const admin = await adminUser(prisma, adminId, "SUPPORT");
    const u = await this.target(userId);
    if (u.status === "SUSPENDED") throw conflict("already_suspended", "This account is already suspended.");
    await ctx.ensureConfirmed();
    const now = this.now();
    const families = await prisma.$transaction(async (tx) => {
      // Only an active account, checked in the same statement (two admins at once: one suspends).
      const won = await tx.user.updateMany({ where: { id: u.id, status: "ACTIVE" }, data: { status: "SUSPENDED", suspendedAt: now, suspendedReason: reason, suspendedById: admin.id } });
      if (won.count !== 1) return null;
      const ended = await this.revoker.revokeAllSessions(tx, u.id, "suspended");
      await this.trustedDevices.revokeAll(tx, u.id);
      await tx.twoFactorReset.updateMany({ where: { userId: u.id, confirmedAt: null, cancelledAt: null }, data: { cancelledAt: now } });
      const store = await tx.store.updateMany({ where: { ownerId: u.id, status: "APPROVED" }, data: { status: "SUSPENDED", suspendedAt: now, suspendedCause: "ACCOUNT" } });
      await audit(tx, { actorId: admin.id, action: "user.suspend", targetType: "user", targetId: u.id, metadata: { reason, storeSuspended: store.count > 0 }, ip: ctx.ip });
      return ended;
    });
    if (!families) throw conflict("already_suspended", "This account is already suspended.");
    // Its access passes stop working at once (the sign-ins themselves were ended above).
    await bestEffort(logger, "suspension time not saved; the person's access passes stay valid up to 15 minutes", () =>
      kv.set(authKeys.invalidBefore(u.id), String(Math.floor(now.getTime() / 1000)), ACCESS_TTL_SECONDS + 60)
    );
    await this.revoker.markFamiliesRevoked(families);
    this.mailer.send(accountSuspendedMessage(u.email, u.name, reason));
    return this.load(u.id);
  }

  /** "Reactivate account": and the store, if the suspension took it down (a store Support suspended on its own stays suspended). */
  async reactivate(adminId: string, userId: string, ctx: { ensureConfirmed: () => Promise<void>; ip: string | null }) {
    const { prisma } = this.deps;
    const admin = await adminUser(prisma, adminId, "SUPPORT");
    const u = await this.target(userId);
    if (u.status !== "SUSPENDED") throw conflict("not_suspended", "This account isn't suspended.");
    await ctx.ensureConfirmed();
    const done = await prisma.$transaction(async (tx) => {
      const won = await tx.user.updateMany({ where: { id: u.id, status: "SUSPENDED" }, data: { status: "ACTIVE", suspendedAt: null, suspendedReason: null, suspendedById: null } });
      if (won.count !== 1) return false;
      const store = await tx.store.updateMany({ where: { ownerId: u.id, status: "SUSPENDED", suspendedCause: "ACCOUNT" }, data: { status: "APPROVED", suspendedAt: null, suspendedCause: null } });
      await audit(tx, { actorId: admin.id, action: "user.reactivate", targetType: "user", targetId: u.id, metadata: { storeReactivated: store.count > 0 }, ip: ctx.ip });
      return true;
    });
    if (!done) throw conflict("not_suspended", "This account isn't suspended.");
    this.mailer.send(accountReactivatedMessage(u.email, u.name, this.deps.config.APP_URL));
    return this.load(u.id);
  }

  /**
   * "Reset two-step verification", Support's half: how they checked who the person is, then a link to the
   * owner's verified email (24 hours, once). A newer request cancels older ones. Nothing changes until the
   * owner opens it, so a Support account alone (stolen, or talked into it) can't remove anyone's 2FA.
   */
  async requestTwoFactorReset(adminId: string, userId: string, identityCheck: string, ctx: { ensureConfirmed: () => Promise<void>; ip: string | null }) {
    const { prisma, config } = this.deps;
    const admin = await adminUser(prisma, adminId, "SUPPORT");
    const u = await this.target(userId);
    if (u.status !== "ACTIVE") throw conflict("suspended", "This account is suspended. Reactivate it first.");
    if (!u.twoFactorEnabledAt) throw conflict("two_factor_off", "Two-step verification is already off on this account.");
    await ctx.ensureConfirmed();
    const now = this.now();
    const token = randomToken(32);
    const expiresAt = new Date(now.getTime() + TWO_FACTOR_RESET_TTL_SECONDS * 1000);
    await prisma.$transaction(async (tx) => {
      await tx.twoFactorReset.updateMany({ where: { userId: u.id, confirmedAt: null, cancelledAt: null }, data: { cancelledAt: now } });
      const reset = await tx.twoFactorReset.create({
        data: { userId: u.id, requestedById: admin.id, identityCheck, tokenHash: twoFactorResetHash(config.CODE_HASH_SECRET, token), expiresAt, createdAt: now }
      });
      await audit(tx, { actorId: admin.id, action: "user.two_factor_reset_requested", targetType: "user", targetId: u.id, metadata: { resetId: reset.id, identityCheck, expiresAt: expiresAt.toISOString() }, ip: ctx.ip });
    });
    // The token sits after "#", so it never reaches server logs or other sites (like password-reset links).
    this.mailer.send(twoFactorResetRequestMessage(u.email, u.name, `${config.APP_URL}/account/two-step-reset#token=${token}`, TWO_FACTOR_RESET_TTL_SECONDS / 3600));
    return this.load(u.id);
  }
}
