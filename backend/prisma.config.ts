import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

// Prisma 7 no longer reads .env by itself.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts"
  },
  datasource: {
    // Migrations need Neon's DIRECT connection; the running app uses the pooled DATABASE_URL.
    // Empty is fine for commands that don't touch a database (validate, generate, migrate diff).
    url: process.env.DIRECT_URL || process.env.DATABASE_URL || ""
  }
});
