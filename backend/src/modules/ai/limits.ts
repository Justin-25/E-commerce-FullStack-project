import { AppError } from "../../lib/errors.js";
import type { KeyValueStore } from "../../lib/kv.js";
import { manilaDayStart } from "../orders/deadlines.js";
import { manilaDay } from "../stores/visits.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Counters live a little over a day (their key already names the day). */
const KEEP_SECONDS = 2 * 24 * 60 * 60;

/** Questions per Philippine day: signed-out visitors (per network address), signed-in shoppers, sellers and admins (8b). */
export const QUESTIONS_PER_DAY = { visitor: 10, shopper: 30, staff: 50 } as const;

/** Who is asking, for the daily count: a signed-in account, or a signed-out visitor's network address. */
export type Asker = { kind: "user"; userId: string; perDay: number } | { kind: "visitor"; ipKey: string; perDay: number };

/**
 * The assistant's two cost limits, kept in Redis:
 * - a daily question count per person (signed out: per network address, IPv6 grouped by /56);
 * - a spending cap for the whole site per Philippine day (AI_DAILY_BUDGET_USD), from the real token counts
 *   of every answer. When it's reached, the assistant "rests" until midnight.
 * Both refuse when Redis doesn't answer (503): a Redis outage must never mean unlimited spending.
 */
export class AiLimits {
  constructor(
    private readonly deps: {
      kv: KeyValueStore;
      budgetUsd: number;
      now?: () => Date;
    }
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private spendKey() {
    return `ai:spend:${manilaDay(this.now())}`;
  }

  private questionKey(asker: Asker) {
    const who = asker.kind === "user" ? `u:${asker.userId}` : `ip:${asker.ipKey}`;
    return `ai:q:${who}:${manilaDay(this.now())}`;
  }

  /** Seconds until midnight in Manila, when the counts start again. */
  secondsUntilReset(): number {
    const next = manilaDayStart(this.now()).getTime() + DAY_MS;
    return Math.max(1, Math.ceil((next - this.now().getTime()) / 1000));
  }

  /** Today's spending in micro-dollars. */
  async spentToday(): Promise<number> {
    return Number((await this.deps.kv.get(this.spendKey())) ?? 0);
  }

  async isResting(): Promise<boolean> {
    return (await this.spentToday()) >= this.deps.budgetUsd * 1_000_000;
  }

  /** 503 while the daily budget is used up. */
  async ensureBudget(): Promise<void> {
    if (await this.isResting()) {
      const retryAfterSeconds = this.secondsUntilReset();
      throw new AppError(503, "SERVICE_UNAVAILABLE", "Vendora AI is resting for today. It'll be back at midnight (Philippine time).", {
        details: { reason: "ai_resting", retryAfterSeconds }
      });
    }
  }

  /** Counts one question; 429 once today's questions are used up. */
  async countQuestion(asker: Asker): Promise<{ used: number; left: number }> {
    const used = await this.deps.kv.increment(this.questionKey(asker), KEEP_SECONDS);
    if (used > asker.perDay) {
      const retryAfterSeconds = this.secondsUntilReset();
      throw new AppError(429, "RATE_LIMITED", `You've asked ${asker.perDay} questions today, the daily limit. Vendora AI will be back at midnight (Philippine time).`, {
        details: { reason: "ai_daily_limit", limit: asker.perDay, retryAfterSeconds }
      });
    }
    return { used, left: asker.perDay - used };
  }

  async questionsLeft(asker: Asker): Promise<number> {
    const used = Number((await this.deps.kv.get(this.questionKey(asker))) ?? 0);
    return Math.max(0, asker.perDay - used);
  }

  /** Adds an answer's cost to today's total. */
  async recordSpend(microUsd: number): Promise<void> {
    if (microUsd > 0) await this.deps.kv.incrementBy(this.spendKey(), microUsd, KEEP_SECONDS);
  }
}
