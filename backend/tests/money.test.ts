import { describe, expect, it } from "vitest";
import { assertCentavos, formatOrderNumber, formatPeso, pesosToCentavos, platformFee } from "../src/lib/money.js";

describe("money helpers", () => {
  it("formats pesos like the designs", () => {
    expect(formatPeso(749_900)).toBe("₱7,499");
    expect(formatPeso(1_314_400)).toBe("₱13,144");
    expect(formatPeso(49_990)).toBe("₱499.90");
    expect(formatPeso(5)).toBe("₱0.05");
    expect(formatPeso(-330_000)).toBe("−₱3,300");
  });

  it("converts pesos to centavos exactly", () => {
    expect(pesosToCentavos(7499)).toBe(749_900);
    expect(pesosToCentavos(0.1 + 0.2)).toBe(30); // the classic float trap is handled
    expect(() => pesosToCentavos(1.234)).toThrow(/2 decimal places/);
    expect(() => pesosToCentavos(-1)).toThrow();
  });

  it("only accepts whole, non-negative, safe centavos", () => {
    expect(assertCentavos(0)).toBe(0);
    expect(() => assertCentavos(1.5)).toThrow();
    expect(() => assertCentavos(-100)).toThrow();
    expect(() => assertCentavos(Number.MAX_SAFE_INTEGER + 2)).toThrow();
  });

  it("charges a 5% fee rounded to the nearest peso", () => {
    expect(platformFee(999_800)).toBe(50_000); // ₱9,998 → ₱499.90 → ₱500 (seller gets ₱9,498)
    expect(platformFee(12_840_000)).toBe(642_000); // ₱128,400 → ₱6,420
    expect(platformFee(999_800, 0)).toBe(0); // first 30 days: 0%
  });

  it("shows order numbers as VD-#####", () => {
    expect(formatOrderNumber(21_458)).toBe("VD-21458");
  });
});
