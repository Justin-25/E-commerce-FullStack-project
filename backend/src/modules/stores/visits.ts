import type { PrismaClient } from "../../generated/prisma/client.js";
import { hmacHex, sha256Hex } from "../../lib/crypto.js";
import type { KeyValueStore } from "../../lib/kv.js";
import type { Logger } from "../../lib/logger.js";
import { manilaDayStart } from "../orders/deadlines.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Counts stay in Redis this long, so a missed nightly copy is caught up the night after. */
const KEEP_SECONDS = 3 * 24 * 60 * 60;
/** Crawlers, link previews and scripts aren't visitors. */
const NOT_A_VISITOR = /bot|crawl|spider|slurp|curl|wget|python|httpclient|headless|preview|monitor/i;

/** "2026-11-25": the Philippine calendar day `at` falls on. */
export const manilaDay = (at: Date) => new Date(manilaDayStart(at).getTime() + 8 * HOUR_MS).toISOString().slice(0, 10);

/**
 * "Store visits" on the seller dashboard: unique visitors per store per day, across the store
 * page and its product pages, counted the way privacy-friendly analytics do it (Plausible):
 *
 * - no cookie and no personal data: a visitor is a hash of their IP address and browser with a
 *   salt that changes every day and is never stored, so nobody can be followed from one day (or one
 *   store) to the next, and a stolen count reveals nothing;
 * - Redis HyperLogLog counts the unique hashes in a few KB per store per day, whatever the traffic
 *   (about 1% error); a job copies finished days into Postgres for the dashboard's history;
 * - counting never slows a page or fails it: if Redis is down, those visits just aren't counted.
 */
export class VisitService {
  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      kv: KeyValueStore;
      /** CODE_HASH_SECRET: the daily salt is derived from it, never stored. */
      secret: string;
      logger?: Logger;
      now?: () => Date;
    }
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  /** One page view of a store (its page or a product's). Resolves either way; never throws. */
  async record(storeId: string, visitor: { ip: string | undefined; userAgent: string | undefined }): Promise<void> {
    if (!visitor.ip || !visitor.userAgent || NOT_A_VISITOR.test(visitor.userAgent)) return;
    const day = manilaDay(this.now());
    const salt = hmacHex(this.deps.secret, `store-visits:${day}`);
    const visitorId = sha256Hex(`${salt}|${storeId}|${visitor.ip}|${visitor.userAgent}`).slice(0, 32);
    try {
      await this.deps.kv.countUnique(key(storeId, day), visitorId, KEEP_SECONDS);
    } catch (err) {
      this.deps.logger?.debug({ err }, "a store visit wasn't counted (Redis unavailable)");
    }
  }

  /**
   * Visits per day from `from` (a Manila day start) up to today: finished days from Postgres, the
   * last two (maybe not copied yet) from Redis when it answers.
   */
  async daily(storeId: string, from: Date): Promise<Map<string, number>> {
    const now = this.now();
    const rows = await this.deps.prisma.storeDailyVisit.findMany({ where: { storeId, day: { gte: new Date(`${manilaDay(from)}T00:00:00.000Z`) } }, select: { day: true, visits: true } });
    const byDay = new Map(rows.map((r) => [r.day.toISOString().slice(0, 10), r.visits]));
    for (const day of [manilaDay(now), manilaDay(new Date(now.getTime() - DAY_MS))]) {
      try {
        const live = await this.deps.kv.uniqueCount(key(storeId, day));
        byDay.set(day, Math.max(live, byDay.get(day) ?? 0));
      } catch {
        // Redis down: the stored days still show.
      }
    }
    return byDay;
  }

  /** Background job (hourly): copies the last two finished days into Postgres. Running it twice is harmless (an upsert). */
  async copyFinishedDays(): Promise<number> {
    const { prisma, kv } = this.deps;
    const now = this.now();
    const days = [1, 2].map((n) => manilaDay(new Date(now.getTime() - n * DAY_MS)));
    const stores = await prisma.store.findMany({ where: { status: { in: ["APPROVED", "SUSPENDED"] } }, select: { id: true } });
    let copied = 0;
    for (const day of days) {
      for (const { id } of stores) {
        const visits = await kv.uniqueCount(key(id, day));
        if (visits === 0) continue;
        const date = new Date(`${day}T00:00:00.000Z`);
        await prisma.storeDailyVisit.upsert({ where: { storeId_day: { storeId: id, day: date } }, create: { storeId: id, day: date, visits }, update: { visits } });
        copied++;
      }
    }
    return copied;
  }
}

const key = (storeId: string, day: string) => `visits:${storeId}:${day}`;
