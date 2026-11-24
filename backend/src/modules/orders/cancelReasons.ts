import type { CancelReason, CancelledBy } from "../../generated/prisma/client.js";

/** The reasons a seller can choose in the "Cancel order" Modal. */
export const SELLER_CANCEL_REASONS = ["OUT_OF_STOCK", "CANNOT_SHIP_TO_ADDRESS", "BUYER_ASKED"] as const satisfies readonly CancelReason[];

const SHORT: Record<CancelReason, string> = {
  OUT_OF_STOCK: "out of stock",
  CANNOT_SHIP_TO_ADDRESS: "can't ship to this address",
  BUYER_ASKED: "the buyer asked to cancel",
  BUYER_CANCELLED: "the buyer cancelled it",
  NOT_SHIPPED_IN_TIME: "not shipped in time"
};

/** The buyer's timeline: "Cancelled by the seller · out of stock". */
export function buyerCancelMessage(by: CancelledBy | null, reason: CancelReason | null): string {
  if (by === "BUYER") return "You cancelled this order";
  if (by === "SYSTEM") return "Cancelled automatically · the seller didn't ship in time";
  if (by === "SELLER" && reason) return `Cancelled by the seller · ${reason === "BUYER_ASKED" ? "you asked to cancel" : SHORT[reason]}`;
  return "Order cancelled";
}

/** The seller's timeline: "You cancelled it · out of stock". */
export function sellerCancelMessage(by: CancelledBy | null, reason: CancelReason | null): string {
  if (by === "BUYER") return "The buyer cancelled it (within an hour of paying)";
  if (by === "SYSTEM") return "Cancelled automatically · not shipped in time";
  if (by === "SELLER" && reason) return `You cancelled it · ${SHORT[reason]}`;
  return "Cancelled";
}

/** Why, in the buyer's email: "…because the seller ran out of stock." */
export const BUYER_EMAIL_REASON: Record<CancelReason, string> = {
  OUT_OF_STOCK: "the seller ran out of stock",
  CANNOT_SHIP_TO_ADDRESS: "the seller can't ship to your address",
  BUYER_ASKED: "you asked the seller to cancel it",
  BUYER_CANCELLED: "you cancelled it",
  NOT_SHIPPED_IN_TIME: "the seller didn't ship it in time"
};
