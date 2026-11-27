import type { EmailMessage } from "../../lib/email.js";
import { formatPeso } from "../../lib/money.js";
import { manilaTime } from "../orders/deadlines.js";

/** After "Submit for review". */
export function storeSubmittedEmail(to: string, storeName: string, appUrl: string): EmailMessage {
  return {
    to,
    kind: "store-submitted",
    subject: `We're reviewing ${storeName}`,
    text: [
      `Thanks for opening ${storeName} on Vendora!`,
      "",
      "Our team is checking your details and documents. Review takes 1–2 business days, and we'll email you when it's done.",
      "You can add products in the meantime: they go live once your store is approved.",
      "",
      `Seller Center: ${appUrl}/seller`
    ].join("\n")
  };
}

/** A changed payout account is where money goes: always tell the owner, so a stolen session can't quietly redirect it. */
export function payoutAccountChangedEmail(to: string, storeName: string, summary: string, appUrl: string): EmailMessage {
  return {
    to,
    kind: "payout-account-changed",
    subject: `${storeName}'s payout account was changed`,
    text: [
      `Payouts for ${storeName} now go to: ${summary}.`,
      "",
      "If you didn't make this change, sign in, change your password, sign out other devices, and contact Vendora support right away.",
      "",
      `Payout settings: ${appUrl}/seller/payouts`
    ].join("\n")
  };
}

export interface NewOrderPackage {
  /** The package (seller order) id: its page in Seller Center. */
  id: string;
  number: string;
  items: { title: string; variantName: string; quantity: number }[];
  subtotalCentavos: number;
  deliveryOption: "STANDARD" | "EXPRESS";
  paymentMethod: "GCASH" | "MAYA" | "CARD" | "COD";
  shipBy: Date;
}

/** A paid (or cash-on-delivery) order for this store: what to pack and the deadline. */
export function newOrderEmail(to: string, storeName: string, pkg: NewOrderPackage, appUrl: string): EmailMessage {
  const units = pkg.items.reduce((n, i) => n + i.quantity, 0);
  return {
    to,
    kind: "seller-new-order",
    subject: `New order ${pkg.number}: ship by ${manilaTime.format(pkg.shipBy)}`,
    text: [
      `${storeName} has a new order (${units} ${units === 1 ? "item" : "items"}):`,
      "",
      ...pkg.items.map((i) => `  ${i.quantity} × ${i.title} · ${i.variantName}`),
      "",
      `Items: ${formatPeso(pkg.subtotalCentavos)} · ${pkg.deliveryOption === "EXPRESS" ? "Express" : "Standard"} delivery · ${pkg.paymentMethod === "COD" ? "cash on delivery" : "paid online"}`,
      `Ship it by ${manilaTime.format(pkg.shipBy)} (Philippine time), then mark it as shipped with the courier's tracking number.`,
      "",
      `Open the order: ${appUrl}/seller/orders/${pkg.id}`
    ].join("\n")
  };
}

export interface LowStockVariant {
  productId: string;
  title: string;
  variantName: string;
  sku: string;
  stock: number;
}

/** Items listed in one low-stock email; the rest are summed up. */
export const LOW_STOCK_ITEMS_PER_EMAIL = 20;

/** Variants that just dropped below 10 (one email per store per run; each variant once until it's restocked). */
export function lowStockEmail(to: string, storeName: string, variants: LowStockVariant[], appUrl: string): EmailMessage {
  const [first] = variants;
  const left = (n: number) => (n === 0 ? "out of stock" : `${n} left`);
  const subject =
    variants.length === 1 && first ? `Low stock: ${first.title} (${first.variantName}) is ${left(first.stock)}` : `Low stock: ${variants.length} items in ${storeName} are running out`;
  const more = variants.length - LOW_STOCK_ITEMS_PER_EMAIL;
  return {
    to,
    kind: "seller-low-stock",
    subject,
    text: [
      `These items in ${storeName} are running low:`,
      "",
      ...variants.slice(0, LOW_STOCK_ITEMS_PER_EMAIL).map((v) => `• ${v.title} · ${v.variantName} (SKU ${v.sku}): ${left(v.stock)}`),
      ...(more > 0 ? [`…and ${more} more.`] : []),
      "",
      `Restock them in Seller Center: ${appUrl}/seller/products`,
      "",
      "You get this email when a variant drops below 10. To stop it for a product, turn off its stock alert in the product form."
    ].join("\n")
  };
}

/** At the ship-by time: the order is late (one email per order). */
export function orderLateEmail(to: string, p: { id: string; number: string; cancelAt: Date }, appUrl: string): EmailMessage {
  return {
    to,
    kind: "seller-order-late",
    subject: `${p.number} is late: please ship it today`,
    text: [
      `Order ${p.number} passed its ship-by time and hasn't been marked as shipped.`,
      `Ship it as soon as you can. If it's still not shipped by ${manilaTime.format(p.cancelAt)} (Philippine time), it's cancelled automatically and the buyer is refunded.`,
      "If you can't ship it, cancel it now so the buyer isn't kept waiting.",
      "",
      `Open the order: ${appUrl}/seller/orders/${p.id}`
    ].join("\n")
  };
}

/** A day before the automatic cancel (one email per order). */
export function orderCancelWarningEmail(to: string, p: { id: string; number: string; cancelAt: Date }, appUrl: string): EmailMessage {
  return {
    to,
    kind: "seller-order-cancel-warning",
    subject: `${p.number} will be cancelled tomorrow unless you ship it`,
    text: [
      `Order ${p.number} still isn't shipped. It will be cancelled automatically on ${manilaTime.format(p.cancelAt)} (Philippine time), and the buyer refunded.`,
      "Mark it as shipped with the courier's tracking number to keep it.",
      "",
      `Open the order: ${appUrl}/seller/orders/${p.id}`
    ].join("\n")
  };
}

/** The buyer cancelled (within the hour) or it was cancelled automatically: don't ship it. */
export function orderCancelledForSellerEmail(to: string, p: { id: string; number: string; by: "BUYER" | "SYSTEM" }, appUrl: string): EmailMessage {
  return {
    to,
    kind: "seller-order-cancelled",
    subject: `${p.number} was cancelled: don't ship it`,
    text: [
      p.by === "BUYER"
        ? `The buyer cancelled order ${p.number} within an hour of paying. Please don't ship it; its stock is back in your store.`
        : `Order ${p.number} was cancelled automatically because it wasn't shipped within 3 days of its ship-by time. The buyer is being refunded and its stock is back in your store.`,
      "",
      `Open the order: ${appUrl}/seller/orders/${p.id}`
    ].join("\n")
  };
}

export interface PayoutInfo {
  reference: string;
  amountCentavos: number;
  method: "GCASH" | "BANK";
  accountLast4: string;
}
const destination = (p: PayoutInfo) => `${p.method === "GCASH" ? "GCash" : "bank account"} ending in ${p.accountLast4}`;

/** A payout was made (every Monday, or "Request payout"). */
export function payoutStartedEmail(to: string, storeName: string, p: PayoutInfo, appUrl: string): EmailMessage {
  return {
    to,
    kind: "seller-payout-started",
    subject: `Payout ${p.reference}: ${formatPeso(p.amountCentavos)} is on its way`,
    text: [
      `We're sending ${formatPeso(p.amountCentavos)} from ${storeName}'s sales to your ${destination(p)}.`,
      "It usually arrives within 1–2 business days.",
      "",
      `Payouts: ${appUrl}/seller/payouts`
    ].join("\n")
  };
}

export function payoutPaidEmail(to: string, storeName: string, p: PayoutInfo & { transferReference: string }, appUrl: string): EmailMessage {
  return {
    to,
    kind: "seller-payout-paid",
    subject: `Payout ${p.reference} paid: ${formatPeso(p.amountCentavos)}`,
    text: [
      `${formatPeso(p.amountCentavos)} from ${storeName}'s sales was paid to your ${destination(p)}.`,
      `Transfer reference: ${p.transferReference} (quote it if the money hasn't arrived within 2 banking days).`,
      "",
      `Payouts: ${appUrl}/seller/payouts`
    ].join("\n")
  };
}

/** The transfer failed: the money is back in the store's balance for the next payout. */
export function payoutFailedEmail(to: string, storeName: string, p: PayoutInfo & { reason: string }, appUrl: string): EmailMessage {
  return {
    to,
    kind: "seller-payout-failed",
    subject: `Payout ${p.reference} didn't go through`,
    text: [
      `We couldn't pay ${formatPeso(p.amountCentavos)} to your ${destination(p)}: ${p.reason}.`,
      `The money is back in ${storeName}'s available balance. Check your payout account, then request the payout again (or wait for Monday's).`,
      "",
      `Payouts: ${appUrl}/seller/payouts`
    ].join("\n")
  };
}

/** An admin approved the store: it's live. */
export function storeApprovedEmail(to: string, storeName: string, appUrl: string, note: string | null): EmailMessage {
  return {
    to,
    kind: "store-approved",
    subject: `${storeName} is approved and live on Vendora`,
    text: [
      `Good news: we've reviewed ${storeName}, and it's now live. Shoppers can find your published products.`,
      ...(note ? ["", `A note from our team: ${note}`] : []),
      "",
      `Seller Center: ${appUrl}/seller`
    ].join("\n")
  };
}

/** An admin needs something changed before approving: the note says what. */
export function storeChangesRequestedEmail(to: string, storeName: string, note: string, appUrl: string): EmailMessage {
  return {
    to,
    kind: "store-changes-requested",
    subject: `${storeName}: we need a few changes before approving`,
    text: [
      `Thanks for applying to sell on Vendora. Before we can approve ${storeName}, please change the following:`,
      "",
      note,
      "",
      "Your details and documents can be edited again. When you're done, choose \"Submit again\".",
      "",
      `Your application: ${appUrl}/seller/onboarding`
    ].join("\n")
  };
}

/** Final: the application was rejected. */
export function storeRejectedEmail(to: string, storeName: string, note: string): EmailMessage {
  return {
    to,
    kind: "store-rejected",
    subject: `Your Vendora application for ${storeName}`,
    text: [`We've reviewed your application for ${storeName}, and we can't approve it.`, "", `Reason: ${note}`, "", "If you think this is a mistake, reply to this email or contact Vendora support."].join("\n")
  };
}

/** A changed payout account was checked: payouts go there now. */
export function payoutAccountVerifiedEmail(to: string, storeName: string, summary: string, appUrl: string): EmailMessage {
  return {
    to,
    kind: "payout-account-verified",
    subject: `${storeName}'s payout account is verified`,
    text: [`We've checked ${storeName}'s new payout account (${summary}). Payouts go there from now on.`, "", `Payouts: ${appUrl}/seller/payouts`].join("\n")
  };
}
