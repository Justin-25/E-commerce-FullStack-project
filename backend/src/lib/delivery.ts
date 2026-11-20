/**
 * Delivery rules from the design (Philippines). Shared by the catalog (product
 * page) and checkout (milestone 5), so they can never disagree.
 */
export const DELIVERY = {
  /** "Free delivery when a seller's subtotal is ₱999 or more." */
  freeThresholdCentavos: 99_900,
  standardFeeCentavos: 4_900, // ₱49
  expressFeeCentavos: 12_900, // ₱129
  /** Shown as "Arrives in 2–5 days" (exact dates aren't built yet). */
  standardDays: { min: 2, max: 5 },
  expressDays: { min: 1, max: 2 },
  returnDays: 30
} as const;
