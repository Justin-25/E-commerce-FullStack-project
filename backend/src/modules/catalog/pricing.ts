import { Prisma } from "../../generated/prisma/client.js";

/**
 * Deal pricing, in ONE place (catalog now, checkout in milestone 5).
 *
 * A variant sells at `priceCentavos`; `compareAtCentavos` is the crossed-out
 * regular price. With a deal countdown (`saleEndsAt`), once the time passes the
 * deal is over: the variant sells at the regular price again and nothing is
 * crossed out. No job has to "end" deals, so they can't be forgotten.
 */
export interface VariantPriceFields {
  priceCentavos: number;
  compareAtCentavos: number | null;
  saleEndsAt: Date | null;
}

export interface VariantPricing {
  priceCentavos: number;
  compareAtCentavos: number | null;
  saleEndsAt: Date | null;
  savingsCentavos: number;
  /** Whole percent, e.g. 25 for "Save 25%". */
  savingsPercent: number;
}

export function variantPricing(v: VariantPriceFields, now: Date): VariantPricing {
  const ended = v.saleEndsAt !== null && v.saleEndsAt <= now && v.compareAtCentavos !== null;
  const priceCentavos = ended ? (v.compareAtCentavos as number) : v.priceCentavos;
  const compareAtCentavos = ended ? null : v.compareAtCentavos;
  const savingsCentavos = compareAtCentavos !== null ? compareAtCentavos - priceCentavos : 0;
  return {
    priceCentavos,
    compareAtCentavos,
    saleEndsAt: ended ? null : v.saleEndsAt,
    savingsCentavos,
    savingsPercent: compareAtCentavos ? Math.round((savingsCentavos / compareAtCentavos) * 100) : 0
  };
}

/** The same rule in SQL, for filtering and sorting by price inside the database (alias `v`). */
export const EFFECTIVE_PRICE_SQL = Prisma.sql`(CASE WHEN v."saleEndsAt" IS NOT NULL AND v."saleEndsAt" <= now() AND v."compareAtCentavos" IS NOT NULL THEN v."compareAtCentavos" ELSE v."priceCentavos" END)`;
export const EFFECTIVE_COMPARE_AT_SQL = Prisma.sql`(CASE WHEN v."saleEndsAt" IS NOT NULL AND v."saleEndsAt" <= now() THEN NULL ELSE v."compareAtCentavos" END)`;
