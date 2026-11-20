import type { Express } from "express";
import { pino } from "pino";
import { seedDemoData } from "../../prisma/demo-data.js";
import { createApp } from "../../src/app.js";
import { MemoryKv } from "../../src/lib/kv.js";
import { catalogRouter } from "../../src/modules/catalog/catalog.routes.js";
import { CatalogService } from "../../src/modules/catalog/catalog.service.js";
import { silentLogger, testConfig } from "../helpers.js";
import { FlakyKv, type RedisSwitch } from "./flaky.js";
import { createTestDb, type TestDb } from "./testDb.js";

/** The real catalog routes on a fresh test database filled with the demo data (63 products). */
export async function createCatalogHarness() {
  const db: TestDb = await createTestDb();
  await seedDemoData(db.prisma);
  const redis: RedisSwitch = { down: false };
  const memory = new MemoryKv();
  const logs: { msg: string }[] = [];
  const logger = pino({ level: "warn" }, { write: (line: string) => void logs.push(JSON.parse(line)) });
  const catalog = new CatalogService({ prisma: db.prisma, kv: new FlakyKv(memory, redis), logger });
  const app: Express = createApp({ config: testConfig({ RATE_LIMIT_MAX: "100000" }), logger: silentLogger, routers: [catalogRouter({ catalog })] });

  /** A product's id by its slug (demo data slugs are unique). */
  const idOf = async (slug: string) => (await db.prisma.product.findFirstOrThrow({ where: { slug }, select: { id: true } })).id;

  return { app, db, kv: memory, redis, logs, catalog, idOf, close: () => db.close() };
}

export type CatalogHarness = Awaited<ReturnType<typeof createCatalogHarness>>;
