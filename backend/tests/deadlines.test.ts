import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "../src/lib/csv.js";
import { autoConfirmAt, earningsAvailableAt, manilaCutoff, manilaDayStart, shipByFor } from "../src/modules/orders/deadlines.js";
import { shortName } from "../src/modules/seller/orders.service.js";

describe("order deadlines (Philippine time, UTC+8)", () => {
  it("ship by 6:00 PM in Manila, 2 days after the day it was paid", () => {
    // Paid any time on Nov 23 in Manila → Nov 25, 6:00 PM Manila (10:00 UTC).
    for (const paid of ["2026-11-22T16:00:00.000Z", "2026-11-23T01:30:00.000Z", "2026-11-23T15:59:59.999Z"]) {
      expect(shipByFor(new Date(paid)).toISOString()).toBe("2026-11-25T10:00:00.000Z");
    }
    // A minute after midnight in Manila is the next day.
    expect(shipByFor(new Date("2026-11-23T16:00:00.000Z")).toISOString()).toBe("2026-11-26T10:00:00.000Z");
    expect(manilaDayStart(new Date("2026-11-23T03:00:00.000Z")).toISOString()).toBe("2026-11-22T16:00:00.000Z");
    expect(manilaCutoff(new Date("2026-11-23T03:00:00.000Z")).toISOString()).toBe("2026-11-23T10:00:00.000Z");
  });

  it("confirms delivery 7 days after shipping, and releases earnings 7 days after delivery", () => {
    expect(autoConfirmAt(new Date("2026-11-23T10:00:00.000Z")).toISOString()).toBe("2026-11-30T10:00:00.000Z");
    expect(earningsAvailableAt(new Date("2026-11-30T10:00:00.000Z")).toISOString()).toBe("2026-12-07T10:00:00.000Z");
  });
});

const BOM = String.fromCharCode(0xfeff);

describe("CSV files", () => {
  it("quotes commas, quotes and line breaks, and defuses formulas (= + - @ tab CR) with an apostrophe", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    for (const danger of ["=1+1", "+63917", "-2+3", "@SUM(A1)", "\tx", "\rx"]) expect(csvCell(danger).replace(/^"/, "").startsWith("'")).toBe(true);
    expect(csvCell('=HYPERLINK("http://evil.test")')).toBe(`"'=HYPERLINK(""http://evil.test"")"`);
    expect(csvCell(42)).toBe("42");
    expect(csvCell(null)).toBe("");
    expect(toCsv(["a", "b"], [[1, "x,y"]])).toBe(`${BOM}a,b\r\n1,"x,y"\r\n`);
  });

  it('shows buyers as "Maria S."', () => {
    expect(shortName("Maria Santos")).toBe("Maria S.");
    expect(shortName("  Juan  dela Cruz ")).toBe("Juan C.");
    expect(shortName("Cher")).toBe("Cher");
    expect(shortName("")).toBe("Customer");
  });
});
