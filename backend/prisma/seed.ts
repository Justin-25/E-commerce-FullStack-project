/**
 * Demo data matching the Figma designs (see prisma/demo-data.ts): 15 categories,
 * 7 approved stores, 63 products, and demo shoppers with delivered orders and reviews.
 * Run with `npm run db:seed`.
 * Safe to run again (upserts by email / slug / SKU). Deal countdowns restart from now.
 */
import { existsSync } from "node:fs";
import { createPrisma } from "../src/lib/prisma.js";
import { seedDemoData } from "./demo-data.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
const prisma = createPrisma(url);

try {
  const demo = await seedDemoData(prisma);
  const counts = await Promise.all([prisma.category.count(), prisma.store.count(), prisma.product.count(), prisma.productVariant.count(), prisma.user.count()]);
  console.log(`Seeded: ${counts[0]} categories, ${counts[1]} stores, ${counts[2]} products, ${counts[3]} variants, ${counts[4]} users`);
  console.log(`Demo shoppers: ${demo.shoppers}, with ${demo.orders} delivered orders and ${demo.reviews} reviews (ratings recomputed)`);
} finally {
  await prisma.$disconnect();
}
