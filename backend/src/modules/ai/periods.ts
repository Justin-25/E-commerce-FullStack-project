import { z } from "zod";
import { manilaDate, manilaDayStart, manilaMonth, manilaMonthStart } from "../orders/deadlines.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The periods "Ask your data" understands. Days and months are Philippine ones. */
export const PERIODS = ["today", "yesterday", "last_7_days", "last_30_days", "last_90_days", "this_month", "last_month"] as const;
export type Period = (typeof PERIODS)[number];

export const periodInput = z
  .enum(PERIODS)
  .optional()
  .describe("today, yesterday, last_7_days (default; today included), last_30_days, last_90_days, this_month (so far), last_month. Days are Philippine days.");

export interface PeriodRange {
  /** "Last 7 days (Nov 23 – Nov 29)" */
  label: string;
  from: Date;
  /** Exclusive end (now, for periods that include today). */
  to: Date;
  /** The period before, of the same length (the same days of last month for "this month"), for comparisons. */
  previousFrom: Date;
  previousTo: Date;
  /** Philippine days in the period, today included. */
  days: number;
}

const span = (from: Date, lastDay: Date) => {
  const a = manilaDate.format(from);
  const b = manilaDate.format(lastDay);
  return a === b ? a : `${a} – ${b}`;
};

export function periodRange(period: Period, now: Date): PeriodRange {
  const today = manilaDayStart(now);
  const lastDays = (n: number, name: string): PeriodRange => {
    const from = new Date(today.getTime() - (n - 1) * DAY_MS);
    return { label: `${name} (${span(from, today)})`, from, to: now, previousFrom: new Date(from.getTime() - n * DAY_MS), previousTo: from, days: n };
  };
  switch (period) {
    case "today":
      return { label: `Today (${manilaDate.format(today)}, so far)`, from: today, to: now, previousFrom: new Date(today.getTime() - DAY_MS), previousTo: new Date(now.getTime() - DAY_MS), days: 1 };
    case "yesterday": {
      const from = new Date(today.getTime() - DAY_MS);
      return { label: `Yesterday (${manilaDate.format(from)})`, from, to: today, previousFrom: new Date(from.getTime() - DAY_MS), previousTo: from, days: 1 };
    }
    case "last_7_days":
      return lastDays(7, "Last 7 days");
    case "last_30_days":
      return lastDays(30, "Last 30 days");
    case "last_90_days":
      return lastDays(90, "Last 90 days");
    case "this_month": {
      const from = manilaMonthStart(manilaMonth(now));
      const previousFrom = manilaMonthStart(manilaMonth(new Date(from.getTime() - DAY_MS)));
      // The same stretch of last month (Nov 1–29 against Oct 1–29), never past its end.
      const previousTo = new Date(Math.min(previousFrom.getTime() + (now.getTime() - from.getTime()), from.getTime()));
      return { label: `This month (${span(from, today)})`, from, to: now, previousFrom, previousTo, days: Math.round((today.getTime() - from.getTime()) / DAY_MS) + 1 };
    }
    case "last_month": {
      const to = manilaMonthStart(manilaMonth(now));
      const from = manilaMonthStart(manilaMonth(new Date(to.getTime() - DAY_MS)));
      const previousFrom = manilaMonthStart(manilaMonth(new Date(from.getTime() - DAY_MS)));
      return { label: `Last month (${span(from, new Date(to.getTime() - DAY_MS))})`, from, to, previousFrom, previousTo: from, days: Math.round((to.getTime() - from.getTime()) / DAY_MS) };
    }
  }
}

/** +12.4 (percent) against the period before; null when there's nothing to compare with. */
export const percentChange = (now: number, before: number) => (before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : null);
