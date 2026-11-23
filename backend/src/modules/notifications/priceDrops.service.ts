import { type PrismaClient } from "../../generated/prisma/client.js";
import { BackgroundMailer } from "../../lib/backgroundMailer.js";
import { hmacHex, safeEqualHex } from "../../lib/crypto.js";
import type { EmailSender } from "../../lib/email.js";
import { AppError } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import { EFFECTIVE_PRICE_SQL } from "../catalog/pricing.js";
import { VISIBLE_PRODUCTS_FROM } from "../catalog/search.js";
import { priceDropEmail, type DroppedItem } from "./notifications.emails.js";

/** At most one price-drop email per shopper in this many hours. */
export const PRICE_DROP_EVERY_HOURS = 24;
/** Shoppers emailed per run; the rest wait for the next run (every 15 minutes). */
export const SHOPPERS_PER_RUN = 200;
const HOUR_MS = 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const badLink = () => new AppError(400, "VALIDATION_ERROR", "This unsubscribe link isn't valid. You can turn price-drop emails off in your account's notification settings.");

/**
 * Wishlist price-drop emails. A background job (every 15 minutes) looks at the DATA, not at
 * events: any saved item whose price today (same rules as everywhere: cheapest variant, ended
 * deals don't count) is below the price when it was saved AND below the price we last emailed
 * about. So it doesn't matter what caused the drop (a seller's edit, a deal starting), a missed
 * run catches up on the next one, and a restart loses nothing.
 */
export class PriceDropService {
  private readonly mailer: BackgroundMailer;

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      email: EmailSender;
      config: { APP_URL: string; CODE_HASH_SECRET: string };
      logger?: Logger;
      now?: () => Date;
    }
  ) {
    this.mailer = new BackgroundMailer(deps.email, deps.logger);
  }

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  async drain(): Promise<void> {
    await this.mailer.drain();
  }

  /** One run of the job. Returns how many shoppers were emailed. */
  async run(): Promise<{ emailed: number }> {
    const { prisma } = this.deps;
    const now = this.now();
    const since = new Date(now.getTime() - PRICE_DROP_EVERY_HOURS * HOUR_MS);

    // A drop that's over (no variant below the saved price any more): the next drop is news again.
    await prisma.$executeRaw`
      UPDATE wishlist_items w SET "notifiedPriceCentavos" = NULL
      WHERE w."notifiedPriceCentavos" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v."productId" = w."productId" AND v."isActive" AND ${EFFECTIVE_PRICE_SQL} < w."priceAtSaveCentavos")`;

    type Row = DroppedItem & { userId: string; email: string; name: string };
    const rows = await prisma.$queryRaw<Row[]>`
      SELECT w."userId", u.email, u.name, p.id AS "productId", p.title,
             w."priceAtSaveCentavos" AS "savedCentavos", cheapest.price AS "nowCentavos", cheapest.sale_ends_at AS "saleEndsAt"
      ${VISIBLE_PRODUCTS_FROM}
      JOIN wishlist_items w ON w."productId" = p.id
      JOIN users u ON u.id = w."userId"
      WHERE p.status = 'ACTIVE'
        AND u."priceDropEmails" AND u.status = 'ACTIVE' AND u."deletedAt" IS NULL AND u."emailVerifiedAt" IS NOT NULL
        AND (u."priceDropEmailedAt" IS NULL OR u."priceDropEmailedAt" <= ${since})
        AND cheapest.price < w."priceAtSaveCentavos"
        AND cheapest.price < coalesce(w."notifiedPriceCentavos", w."priceAtSaveCentavos")
      ORDER BY w."userId", (w."priceAtSaveCentavos" - cheapest.price) DESC, p.id
      LIMIT 5000`;

    const byUser = new Map<string, Row[]>();
    for (const r of rows) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);

    let emailed = 0;
    for (const [userId, items] of [...byUser].slice(0, SHOPPERS_PER_RUN)) {
      const [first] = items;
      if (!first) continue;
      // Claim today's email for this shopper: the condition is re-checked on the row itself, so if
      // two runs (or two servers) get here at once, exactly one wins and nobody gets two emails.
      const claimed = await prisma.$transaction(async (tx) => {
        const won = await tx.user.updateMany({
          where: { id: userId, priceDropEmails: true, OR: [{ priceDropEmailedAt: null }, { priceDropEmailedAt: { lte: since } }] },
          data: { priceDropEmailedAt: now }
        });
        if (won.count !== 1) return false;
        for (const i of items) await tx.wishlistItem.updateMany({ where: { userId, productId: i.productId }, data: { notifiedPriceCentavos: i.nowCentavos } });
        return true;
      });
      if (!claimed) continue;
      const token = this.unsubscribeToken(userId);
      const appUrl = this.deps.config.APP_URL;
      this.mailer.send(
        priceDropEmail(first.email, first.name, items, {
          appUrl,
          unsubscribeUrl: `${appUrl}/unsubscribe?token=${token}`,
          oneClickUrl: `${appUrl}/api/v1/notifications/unsubscribe?token=${token}`
        })
      );
      emailed++;
    }
    return { emailed };
  }

  // --- unsubscribing ------------------------------------------------------------

  /**
   * "<user id>.<signature>": proves the link came from us for this account, without storing
   * anything or expiring (an unsubscribe link must keep working). A keyed hash with the server's
   * code key and its own purpose prefix, so it can't be swapped with any other signed value.
   */
  unsubscribeToken(userId: string): string {
    return `${userId}.${this.sign(userId)}`;
  }

  /** One click from the email: no sign-in needed (the token is the proof). Doing it twice is fine. */
  async unsubscribe(token: string): Promise<void> {
    const [userId = "", signature = ""] = token.split(".");
    if (!UUID.test(userId) || !safeEqualHex(signature, this.sign(userId))) throw badLink();
    await this.deps.prisma.user.updateMany({ where: { id: userId }, data: { priceDropEmails: false } });
  }

  async preferences(userId: string): Promise<{ priceDrops: boolean }> {
    const user = await this.deps.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { priceDropEmails: true } });
    return { priceDrops: user.priceDropEmails };
  }

  async setPreferences(userId: string, input: { priceDrops: boolean }): Promise<{ priceDrops: boolean }> {
    await this.deps.prisma.user.update({ where: { id: userId }, data: { priceDropEmails: input.priceDrops } });
    return this.preferences(userId);
  }

  private sign(userId: string): string {
    return hmacHex(this.deps.config.CODE_HASH_SECRET, `unsubscribe:price-drops:${userId}`);
  }
}
