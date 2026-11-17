import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

/**
 * Prisma 7 talks to PostgreSQL through the `pg` driver adapter.
 * Use Neon's POOLED connection string here (host contains "-pooler");
 * migrations use the direct one (DIRECT_URL, see prisma.config.ts).
 */
export function createPrisma(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString, max: 10, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000 });
  return new PrismaClient({ adapter });
}

export type { PrismaClient };
