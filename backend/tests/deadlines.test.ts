import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "../src/lib/csv.js";
import { buyerCancelMessage, sellerCancelMessage } from "../src/modules/orders/cancelReasons.js";
import {
  autoCancelAt,
  autoConfirmAt,
  buyerCancelUntil,
  earningsAvailableAt,
  lastPayoutTime,
  manilaCutoff,
  manilaDayStart,
  manilaMonth,
  manilaMonthStart,
  nextPayoutTime,
  shipByFor
} from "../src/modules/orders/deadlines.js";
import { manilaDay } from "../src/modules/stores/visits.js";
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

  it("lets the buyer cancel for an hour after paying, and cancels unshipped packages 3 days after ship-by", () => {
    expect(buyerCancelUntil(new Date("2026-11-23T05:30:00.000Z")).toISOString()).toBe("2026-11-23T06:30:00.000Z");
    expect(autoCancelAt(new Date("2026-11-25T10:00:00.000Z")).toISOString()).toBe("2026-11-28T10:00:00.000Z");
  });

  it("says who cancelled and why, in the buyer's and the seller's words", () => {
    expect(buyerCancelMessage("SELLER", "OUT_OF_STOCK")).toBe("Cancelled by the seller · out of stock");
    expect(buyerCancelMessage("SELLER", "BUYER_ASKED")).toBe("Cancelled by the seller · you asked to cancel");
    expect(buyerCancelMessage("BUYER", "BUYER_CANCELLED")).toBe("You cancelled this order");
    expect(buyerCancelMessage("SYSTEM", "NOT_SHIPPED_IN_TIME")).toBe("Cancelled automatically · the seller didn't ship in time");
    expect(buyerCancelMessage(null, null)).toBe("Order cancelled"); // an unpaid order that expired
    expect(sellerCancelMessage("SELLER", "CANNOT_SHIP_TO_ADDRESS")).toBe("You cancelled it · can't ship to this address");
    expect(sellerCancelMessage("SYSTEM", "NOT_SHIPPED_IN_TIME")).toBe("Cancelled automatically · not shipped in time");
  });

  it("pays out on Mondays at 9:00 AM Manila (01:00 UTC); days and months are Philippine ones", () => {
    // Nov 23, 2026 is a Monday.
    expect(lastPayoutTime(new Date("2026-11-23T00:59:00.000Z")).toISOString()).toBe("2026-11-16T01:00:00.000Z"); // 8:59 AM: last week's
    expect(lastPayoutTime(new Date("2026-11-23T01:00:00.000Z")).toISOString()).toBe("2026-11-23T01:00:00.000Z");
    expect(lastPayoutTime(new Date("2026-11-29T15:59:00.000Z")).toISOString()).toBe("2026-11-23T01:00:00.000Z"); // Sunday 11:59 PM
    expect(nextPayoutTime(new Date("2026-11-23T01:00:00.000Z")).toISOString()).toBe("2026-11-30T01:00:00.000Z");
    expect(manilaDay(new Date("2026-11-23T16:30:00.000Z"))).toBe("2026-11-24"); // 12:30 AM in Manila
    expect(manilaMonth(new Date("2026-11-30T16:30:00.000Z"))).toBe("2026-12");
    expect(manilaMonthStart("2026-12").toISOString()).toBe("2026-11-30T16:00:00.000Z");
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
