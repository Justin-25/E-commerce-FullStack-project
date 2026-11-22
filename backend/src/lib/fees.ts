const DAY_MS = 24 * 60 * 60 * 1000;

/** Vendora's commission on each package's items... */
export const PLATFORM_FEE_RATE = 0.05;
/** ...except in a store's first 30 days ("0% commission for your first 30 days" on Home). */
export const FEE_FREE_DAYS = 30;

export function platformFeeCentavos(subtotalCentavos: number, storeApprovedAt: Date | null, now: Date): number {
  if (storeApprovedAt && now.getTime() - storeApprovedAt.getTime() < FEE_FREE_DAYS * DAY_MS) return 0;
  return Math.round(subtotalCentavos * PLATFORM_FEE_RATE);
}
