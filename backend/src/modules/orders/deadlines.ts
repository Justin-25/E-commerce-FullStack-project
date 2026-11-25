/**
 * The clock of an order after it's paid. Philippine time is UTC+8 all year (no daylight
 * saving), so "6:00 PM in Manila" is always 10:00 UTC.
 */
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MANILA_OFFSET_MS = 8 * HOUR_MS;

/** Sellers ship by 6:00 PM (Manila), 2 days after the order is paid, like a courier's daily pickup cutoff. */
export const SHIP_WITHIN_DAYS = 2;
export const SHIP_CUTOFF_HOUR = 18;
/** A shipped package the buyer doesn't confirm is marked received this many days after shipping. */
export const AUTO_CONFIRM_DAYS = 7;
/** A sale becomes available for payout this many days after delivery (time for a problem to surface). */
export const EARNINGS_HOLD_DAYS = 7;

/** Midnight in Manila of the day `at` falls on. */
export function manilaDayStart(at: Date): Date {
  const local = at.getTime() + MANILA_OFFSET_MS;
  return new Date(local - (local % DAY_MS) - MANILA_OFFSET_MS);
}

/** 6:00 PM in Manila on the day `at` falls on. */
export function manilaCutoff(at: Date): Date {
  return new Date(manilaDayStart(at).getTime() + SHIP_CUTOFF_HOUR * HOUR_MS);
}

/** "Ship by Nov 25, 6:00 PM": paid on Nov 23 (any time that day, Manila) → Nov 25, 6:00 PM. */
export function shipByFor(paidAt: Date): Date {
  return new Date(manilaCutoff(paidAt).getTime() + SHIP_WITHIN_DAYS * DAY_MS);
}

export function autoConfirmAt(shippedAt: Date): Date {
  return new Date(shippedAt.getTime() + AUTO_CONFIRM_DAYS * DAY_MS);
}

export function earningsAvailableAt(deliveredAt: Date): Date {
  return new Date(deliveredAt.getTime() + EARNINGS_HOLD_DAYS * DAY_MS);
}

export const manilaTime = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
export const manilaDate = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric" });

/** A buyer can cancel a paid order themselves for this long after paying (while nothing has shipped). */
export const BUYER_CANCEL_MINUTES = 60;
/** A package still not shipped this many days after its ship-by time is cancelled automatically... */
export const AUTO_CANCEL_DAYS = 3;
/** ...and the seller is warned this many days after ship-by (the day before). */
export const CANCEL_WARNING_DAYS = 2;

export function buyerCancelUntil(paidAt: Date): Date {
  return new Date(paidAt.getTime() + BUYER_CANCEL_MINUTES * 60 * 1000);
}

export function autoCancelAt(shipBy: Date): Date {
  return new Date(shipBy.getTime() + AUTO_CANCEL_DAYS * DAY_MS);
}

/** Automatic payouts: every Monday at 9:00 AM, Manila time. */
export const PAYOUT_HOUR = 9;

/** The latest Monday 9:00 AM (Manila) at or before `at`. */
export function lastPayoutTime(at: Date): Date {
  const dayStart = manilaDayStart(at);
  const weekday = new Date(dayStart.getTime() + MANILA_OFFSET_MS).getUTCDay(); // 0 = Sunday … 1 = Monday
  const monday = dayStart.getTime() - ((weekday + 6) % 7) * DAY_MS + PAYOUT_HOUR * HOUR_MS;
  return new Date(monday <= at.getTime() ? monday : monday - 7 * DAY_MS);
}

/** The next Monday 9:00 AM (Manila) after `at`. */
export function nextPayoutTime(at: Date): Date {
  return new Date(lastPayoutTime(at).getTime() + 7 * DAY_MS);
}

/** "2026-11": the Philippine calendar month `at` falls in. */
export const manilaMonth = (at: Date) => new Date(at.getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 7);

/** The first moment of a Philippine calendar month ("2026-11" → Nov 1, 00:00 Manila). */
export const manilaMonthStart = (month: string) => new Date(Date.parse(`${month}-01T00:00:00.000Z`) - MANILA_OFFSET_MS);
