import type { AdminRole, PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";

export type { AdminRole };
export const ADMIN_ROLES = ["SUPPORT", "FINANCE", "MODERATION"] as const satisfies readonly AdminRole[];
const ROLE_NAME: Record<AdminRole, string> = { SUPPORT: "Support", FINANCE: "Finance", MODERATION: "Moderation" };

export interface Admin {
  id: string;
  name: string;
  email: string;
  roles: AdminRole[];
}

const forbidden = (reason: string, message: string, details: Record<string, string> = {}) => new AppError(403, "FORBIDDEN", message, { details: { reason, ...details } });

/**
 * The admin screens' door, checked in the database on every request (a role in an old access
 * pass isn't enough, and removing an admin takes effect at once): an ADMIN account, active, with
 * two-step verification on, and (for most screens) a role: Support, Finance or Moderation. Each
 * admin holds only the roles they need, so one stolen admin account can't do everything.
 */
export async function adminUser(prisma: PrismaClient, userId: string, role?: AdminRole): Promise<Admin> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, name: true, email: true, role: true, status: true, deletedAt: true, twoFactorEnabledAt: true, adminRoles: true }
  });
  if (user.role !== "ADMIN" || user.status !== "ACTIVE" || user.deletedAt) throw forbidden("not_an_admin", "This page is for Vendora admins.");
  if (!user.twoFactorEnabledAt) throw forbidden("two_factor_required", "Turn on two-step verification to use the admin pages.");
  if (role && !user.adminRoles.includes(role)) throw forbidden("missing_role", `This needs the ${ROLE_NAME[role]} role.`, { role });
  return { id: user.id, name: user.name, email: user.email, roles: user.adminRoles };
}
