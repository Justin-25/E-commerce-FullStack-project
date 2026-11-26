/**
 * Admin accounts are made only here, on the server (milestone 7a):
 *   npm run admin:create -- ops@example.com support,finance   (roles: support, finance, moderation)
 *   npm run admin:remove -- ops@example.com
 * The account must exist with a verified email (sign up first) and can't be a seller's.
 * Running admin:create again for an admin changes their roles.
 */
import { existsSync } from "node:fs";
import { createPrisma } from "../src/lib/prisma.js";
import { makeAdmin, parseRoles, removeAdmin } from "../src/modules/admin/accounts.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const url = process.env.DATABASE_URL;
const [action, email, rolesText] = process.argv.slice(2);
if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
const roles = action === "create" ? parseRoles(rolesText ?? "") : null;
if (!email || (action !== "create" && action !== "remove") || (action === "create" && !roles)) {
  throw new Error("Usage: npm run admin:create -- <email> <support,finance,moderation>   or   npm run admin:remove -- <email>");
}

const prisma = createPrisma(url);
try {
  const result = action === "create" ? await makeAdmin(prisma, email, roles ?? []) : await removeAdmin(prisma, email);
  const messages: Record<string, string> = {
    made_admin: `${email} is now an admin (${(roles ?? []).join(", ").toLowerCase()}). They must turn on two-step verification at their next sign-in.`,
    roles_changed: `${email}'s admin roles are now: ${(roles ?? []).join(", ").toLowerCase()}.`,
    removed: `${email} is no longer an admin, and was signed out everywhere.`,
    not_found: `No account with the email ${email}. Sign up first.`,
    not_verified: `${email} hasn't verified their email yet.`,
    not_active: `${email}'s account isn't active.`,
    is_seller: `${email} owns a store (or started one). Use a separate account for admin work.`,
    not_an_admin: `${email} isn't an admin.`
  };
  console.log(messages[result]);
  if (!["made_admin", "roles_changed", "removed"].includes(result)) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
