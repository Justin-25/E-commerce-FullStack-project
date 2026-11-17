/**
 * Money is always an integer number of centavos (₱7,499 = 749_900).
 * Integers add and multiply exactly; decimal numbers can drift by a centavo.
 */

/** Throws unless the value is a safe, whole, non-negative number of centavos. */
export function assertCentavos(value: number, label = "amount"): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be whole, non-negative centavos (got ${value})`);
  return value;
}

/** ₱ → centavos. Accepts up to 2 decimals; anything finer is a mistake, not something to round away. */
export function pesosToCentavos(pesos: number): number {
  const centavos = Math.round(pesos * 100);
  if (Math.abs(centavos - pesos * 100) > 1e-6) throw new RangeError(`₱${pesos} has more than 2 decimal places`);
  return assertCentavos(centavos, "pesos");
}

/** "₱7,499" for whole pesos, "₱499.90" otherwise — matches the designs. */
export function formatPeso(centavos: number): string {
  const negative = centavos < 0;
  const abs = Math.abs(centavos);
  const pesos = Math.floor(abs / 100);
  const cents = abs % 100;
  const text = `₱${pesos.toLocaleString("en-PH")}${cents ? `.${String(cents).padStart(2, "0")}` : ""}`;
  return negative ? `−${text}` : text;
}

/** Vendora's fee in basis points (500 = 5%), rounded to the nearest whole peso. */
export function platformFee(subtotalCentavos: number, rateBps = 500): number {
  assertCentavos(subtotalCentavos, "subtotal");
  return Math.round((subtotalCentavos * rateBps) / 10_000 / 100) * 100;
}

/** Shoppers see order numbers as VD-21458. */
export const formatOrderNumber = (n: number): string => `VD-${n}`;
