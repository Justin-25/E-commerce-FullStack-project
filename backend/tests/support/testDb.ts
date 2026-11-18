/**
 * A fresh, empty database for one test file, built from the real migration SQL.
 *
 * - On your PC: PGlite (Postgres running inside Node). No internet, nothing to clean up.
 * - In CI (TEST_DATABASE_URL set): a brand-new schema on a real PostgreSQL 18 server,
 *   dropped afterwards, so the same tests also prove the code works on the real engine.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaPGlite } from "pglite-prisma-adapter";
import { PrismaClient } from "../../src/generated/prisma/client.js";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "prisma", "migrations");

/** Every migration's SQL, in order (folder names start with a timestamp). */
export const migrationSql: string[] = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()
  .map((name) => readFileSync(join(MIGRATIONS_DIR, name, "migration.sql"), "utf8"));

export interface TestDb {
  prisma: PrismaClient;
  engine: "pglite" | "postgres";
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const url = process.env.TEST_DATABASE_URL;
  return url ? createPostgresDb(url) : createPgliteDb();
}

async function createPgliteDb(): Promise<TestDb> {
  const db = new PGlite();
  for (const sql of migrationSql) await db.exec(sql);
  const prisma = new PrismaClient({ adapter: new PrismaPGlite(db) });
  return {
    prisma,
    engine: "pglite",
    close: async () => {
      await prisma.$disconnect();
      await db.close();
    }
  };
}

async function createPostgresDb(url: string): Promise<TestDb> {
  const schema = `test_${randomBytes(6).toString("hex")}`; // random → safe to interpolate
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.query(`SET search_path TO "${schema}"`);
  for (const sql of migrationSql) await admin.query(sql);

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4 }, { schema }) });
  return {
    prisma,
    engine: "postgres",
    close: async () => {
      await prisma.$disconnect();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  };
}
