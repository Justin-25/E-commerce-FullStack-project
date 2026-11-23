import type { PrismaClient } from "../../generated/prisma/client.js";
import { BackgroundMailer } from "../../lib/backgroundMailer.js";
import type { EmailSender } from "../../lib/email.js";
import type { Logger } from "../../lib/logger.js";
import { SELLER_LOW_STOCK } from "../seller/products.schemas.js";
import { lowStockEmail, type LowStockVariant } from "../seller/seller.emails.js";

/** Stores emailed per run; the rest wait for the next run (every 15 minutes). */
export const STORES_PER_RUN = 200;

/**
 * Low-stock emails for sellers ("Alert me when a variant has fewer than 10 left" in the product
 * form). Like price drops, the job looks at the DATA, not at events: any active variant below 10
 * that the seller hasn't been told about. So it doesn't matter what took the stock down (one
 * order or many), and a missed run catches up on the next one.
 *
 * Each variant is announced once (`lowStockAlertedAt`), until it's restocked to 10 or more. A low
 * number the seller typed in themselves isn't news (the product form marks it as known).
 */
export class LowStockService {
  private readonly mailer: BackgroundMailer;

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      email: EmailSender;
      config: { APP_URL: string };
      logger?: Logger;
      now?: () => Date;
    }
  ) {
    this.mailer = new BackgroundMailer(deps.email, deps.logger);
  }

  async drain(): Promise<void> {
    await this.mailer.drain();
  }

  /** One run of the job. Returns how many stores were emailed. */
  async run(): Promise<{ emailed: number }> {
    const { prisma } = this.deps;
    const now = this.deps.now?.() ?? new Date();

    // Restocked: the next drop below 10 is news again.
    await prisma.productVariant.updateMany({ where: { lowStockAlertedAt: { not: null }, stock: { gte: SELLER_LOW_STOCK } }, data: { lowStockAlertedAt: null } });

    type Row = LowStockVariant & { variantId: string; storeId: string; storeName: string; email: string };
    const rows = await prisma.$queryRaw<Row[]>`
      SELECT v.id AS "variantId", v.name AS "variantName", v.sku, v.stock, p.id AS "productId", p.title,
             s.id AS "storeId", s.name AS "storeName", u.email
      FROM product_variants v
      JOIN products p ON p.id = v."productId"
      JOIN stores s ON s.id = p."storeId"
      JOIN users u ON u.id = s."ownerId"
      WHERE v."isActive" AND v.stock < ${SELLER_LOW_STOCK} AND v."lowStockAlertedAt" IS NULL
        AND p.status = 'ACTIVE' AND p."lowStockAlert"
        AND s.status = 'APPROVED'
        AND u.status = 'ACTIVE' AND u."deletedAt" IS NULL
      ORDER BY s.id, v.stock, p.title, v."sortOrder", v.id
      LIMIT 5000`;

    const byStore = new Map<string, Row[]>();
    for (const r of rows) byStore.set(r.storeId, [...(byStore.get(r.storeId) ?? []), r]);

    let emailed = 0;
    for (const variants of [...byStore.values()].slice(0, STORES_PER_RUN)) {
      const [first] = variants;
      if (!first) continue;
      // Claim them: the condition is re-checked on the rows themselves, so two runs (or two
      // servers) at once can't announce the same variant twice.
      const claimed = await prisma.$queryRaw<{ id: string; stock: number }[]>`
        UPDATE product_variants SET "lowStockAlertedAt" = ${now}
        WHERE id = ANY(${variants.map((v) => v.variantId)}::uuid[]) AND "lowStockAlertedAt" IS NULL AND stock < ${SELLER_LOW_STOCK}
        RETURNING id, stock`;
      if (!claimed.length) continue;
      const stockNow = new Map(claimed.map((c) => [c.id, c.stock]));
      const mine = variants.filter((v) => stockNow.has(v.variantId)).map((v) => ({ ...v, stock: stockNow.get(v.variantId) ?? v.stock }));
      this.mailer.send(lowStockEmail(first.email, first.storeName, mine, this.deps.config.APP_URL));
      emailed++;
    }
    return { emailed };
  }
}
