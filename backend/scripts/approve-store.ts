/**
 * Until the admin screens (milestone 7): approve a submitted store by its web address.
 *   npm run store:approve -- my-store
 */
import { existsSync } from "node:fs";
import { createPrisma } from "../src/lib/prisma.js";
import { approveStore } from "../src/modules/seller/approval.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const url = process.env.DATABASE_URL;
const slug = process.argv[2];
if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
if (!slug) throw new Error("Usage: npm run store:approve -- <store-web-address>");

const prisma = createPrisma(url);
try {
  const result = await approveStore(prisma, slug, null);
  const messages = { approved: `Approved "${slug}": it's now live for shoppers.`, not_pending: `"${slug}" isn't waiting for review.`, not_found: `No store "${slug}".` };
  console.log(messages[result]);
  if (result !== "approved") process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
