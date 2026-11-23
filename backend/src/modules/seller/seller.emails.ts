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
