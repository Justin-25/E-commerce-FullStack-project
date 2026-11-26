import type { PrismaClient } from "../../generated/prisma/client.js";
import { ADMIN_ROLES, type AdminRole } from "./access.js";
import { audit } from "./audit.js";

export type MakeAdminResult = "made_admin" | "roles_changed" | "not_found" | "not_verified" | "not_active" | "is_seller";
export type RemoveAdminResult = "removed" | "not_found" | "not_an_admin";

/** "support,finance" → ["SUPPORT", "FINANCE"]; null if a name isn't a role or none is given. */
export function parseRoles(text: string): AdminRole[] | null {
  const names = [...new Set(text.split(",").map((r) => r.trim().toUpperCase()).filter(Boolean))];
  if (!names.length || names.some((n) => !(ADMIN_ROLES as readonly string[]).includes(n))) return null;
  return names as AdminRole[];
}

/**
 * Admins are made only by a command on the server (`npm run admin:create`), never from a screen:
 * there's no "make me an admin" request for anyone to abuse. The account must already exist with a
 * verified email; a seller's account can't be an admin (one person, two accounts). Running it again
 * for an admin changes their roles. Two-step verification is required before any admin page opens.
 */
export async function makeAdmin(prisma: PrismaClient, email: string, roles: AdminRole[]): Promise<MakeAdminResult> {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      select: { id: true, role: true, status: true, deletedAt: true, emailVerifiedAt: true, adminRoles: true, store: { select: { id: true } } }
    });
    if (!user) return "not_found";
    if (user.status !== "ACTIVE" || user.deletedAt) return "not_active";
    if (!user.emailVerifiedAt) return "not_verified";
    // A store not submitted yet counts too (the account is still a "customer" until then): an admin must never own a store.
    if (user.role === "SELLER" || user.store) return "is_seller";
    const was = user.role === "ADMIN";
    await tx.user.update({ where: { id: user.id }, data: { role: "ADMIN", adminRoles: roles } });
    await audit(tx, { actorId: null, action: was ? "admin.change_roles" : "admin.create", targetType: "user", targetId: user.id, metadata: { roles, before: user.adminRoles, via: "command" } });
    return was ? "roles_changed" : "made_admin";
  });
}

/** Back to a normal customer account, signed out everywhere (the admin pages refuse it at once anyway). */
export async function removeAdmin(prisma: PrismaClient, email: string, now = new Date()): Promise<RemoveAdminResult> {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { email: email.trim().toLowerCase() }, select: { id: true, role: true, adminRoles: true } });
    if (!user) return "not_found";
    if (user.role !== "ADMIN") return "not_an_admin";
    await tx.user.update({ where: { id: user.id }, data: { role: "CUSTOMER", adminRoles: [] } });
    await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now, revokedReason: "admin_removed" } });
    await audit(tx, { actorId: null, action: "admin.remove", targetType: "user", targetId: user.id, metadata: { roles: user.adminRoles, via: "command" } });
    return "removed";
  });
}
