/**
 * The demo stores' payout history (see prisma/demo-payouts.ts), for a database seeded before
 * milestone 6d. Safe to run again: stores that already have payouts are skipped.
 *   npm run demo:payouts
 */
import { existsSync } from "node:fs";
import { createPrisma } from "../src/lib/prisma.js";
import { seedDemoPayouts } from "../prisma/demo-payouts.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const url = process.env.DATABASE_URL;
const key = process.env.DATA_ENCRYPTION_KEY;
if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
if (!key) throw new Error("DATA_ENCRYPTION_KEY is not set (npm run secrets)");

const prisma = createPrisma(url);
try {
  const result = await seedDemoPayouts(prisma, key);
  console.log(`Demo payouts: ${result.payouts} payouts for ${result.stores} stores (stores that already had payouts were skipped).`);
} finally {
  await prisma.$disconnect();
}
