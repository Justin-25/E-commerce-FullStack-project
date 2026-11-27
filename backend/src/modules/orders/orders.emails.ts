import type { EmailMessage } from "../../lib/email.js";
import type { CancelReason } from "../../generated/prisma/client.js";
import { BUYER_EMAIL_REASON } from "./cancelReasons.js";
import { manilaDate } from "./deadlines.js";
import type { OrderView } from "./orders.service.js";

const peso = (centavos: number) => `₱${(centavos / 100).toLocaleString("en-PH", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const METHOD_NAME: Record<string, string> = { GCASH: "GCash", MAYA: "Maya", CARD: "card", COD: "cash on delivery" };

export function orderConfirmedEmail(to: string, order: OrderView, appUrl: string): EmailMessage {
  const lines = order.packages.flatMap((p) => [
    `${p.store.name} (${p.deliveryOption === "EXPRESS" ? "Express" : "Standard"} delivery, ${p.deliveryDays.min}–${p.deliveryDays.max} days)`,
    ...p.items.map((i) => `  ${i.quantity} × ${i.title} · ${i.variantName}  ${peso(i.lineTotalCentavos)}`)
  ]);
  const paid = order.payment.method === "COD" ? `To pay on delivery: ${peso(order.totals.totalCentavos)}` : `Paid with ${METHOD_NAME[order.payment.method] ?? order.payment.method}: ${peso(order.totals.totalCentavos)}`;
  return {
    to,
    kind: "order-confirmed",
    subject: `Your Vendora order ${order.number} is confirmed`,
    text: [
      `Thank you! Your order ${order.number} is confirmed (${order.packages.length} ${order.packages.length === 1 ? "package" : "packages"}).`,
      "",
      ...lines,
      "",
      `Items ${peso(order.totals.subtotalCentavos)} · Delivery ${peso(order.totals.deliveryCentavos)}`,
      paid,
      "",
      `Track it: ${appUrl}/orders/${order.id}`
    ].join("\n")
  };
}

export function paymentRefundedEmail(to: string, orderNumber: string, amountCentavos: number, reason: "out_of_stock" | "duplicate"): EmailMessage {
  const why =
    reason === "duplicate"
      ? `We received a second payment for order ${orderNumber}, which was already paid.`
      : `Your payment for order ${orderNumber} arrived after the 15-minute payment window, and some items had sold out in the meantime.`;
  return {
    to,
    kind: "payment-refunded",
    subject: `We're refunding ${peso(amountCentavos)} for order ${orderNumber}`,
    text: [why, "", `We've refunded the full ${peso(amountCentavos)}. Depending on your bank or e-wallet, it can take a few days to appear.`, "", "Sorry for the trouble."].join("\n")
  };
}

export interface ShippedPackage {
  orderId: string;
  number: string;
  storeName: string;
  courier: string;
  trackingNumber: string;
  items: { title: string; variantName: string; quantity: number }[];
  autoConfirmAt: Date;
}

/** "Your package from SoundCraft is on its way", or the corrected tracking details (`updated`). */
export function packageShippedEmail(to: string, p: ShippedPackage, appUrl: string, updated = false): EmailMessage {
  return {
    to,
    kind: updated ? "package-tracking-updated" : "package-shipped",
    subject: updated ? `New tracking details for your ${p.storeName} package (${p.number})` : `Your package from ${p.storeName} is on its way (${p.number})`,
    text: [
      updated ? `${p.storeName} corrected the tracking details of your package from order ${p.number}.` : `Good news: ${p.storeName} shipped your package from order ${p.number}.`,
      "",
      ...p.items.map((i) => `  ${i.quantity} × ${i.title} · ${i.variantName}`),
      "",
      `Courier: ${p.courier}`,
      `Tracking number: ${p.trackingNumber}`,
      "",
      `When it arrives, tap "Order received" on the order page. If you don't, we'll confirm it for you on ${manilaDate.format(p.autoConfirmAt)}.`,
      `Track it: ${appUrl}/orders/${p.orderId}`
    ].join("\n")
  };
}

export interface CancelledPackage {
  orderId: string;
  number: string;
  storeName: string;
  reason: CancelReason;
  items: { title: string; variantName: string; quantity: number }[];
  /** null: nothing to refund (cash on delivery). */
  refundCentavos: number | null;
  paymentMethod: string;
}

/** A paid package was cancelled (by the seller, by the buyer, or automatically): why, and what happens to the money. */
export function packageCancelledEmail(to: string, p: CancelledPackage, appUrl: string): EmailMessage {
  const money =
    p.refundCentavos === null
      ? "You chose cash on delivery, so there's nothing to pay for these items."
      : `We're refunding ${peso(p.refundCentavos)} (the items and their delivery fee) to your ${METHOD_NAME[p.paymentMethod] ?? p.paymentMethod}. We'll email you when it's sent; it can then take a few days to appear.`;
  return {
    to,
    kind: "package-cancelled",
    subject: `Your package from ${p.storeName} was cancelled (${p.number})`,
    text: [
      `Your package from ${p.storeName} (order ${p.number}) was cancelled because ${BUYER_EMAIL_REASON[p.reason]}.`,
      "",
      ...p.items.map((i) => `  ${i.quantity} × ${i.title} · ${i.variantName}`),
      "",
      money,
      "",
      `Your order: ${appUrl}/orders/${p.orderId}`
    ].join("\n")
  };
}

/** A cancelled package's refund went through. */
export function refundSentEmail(to: string, r: { orderId: string; number: string; storeName: string; amountCentavos: number; paymentMethod: string }, appUrl: string): EmailMessage {
  return {
    to,
    kind: "refund-sent",
    subject: `Refund sent: ${peso(r.amountCentavos)} for order ${r.number}`,
    text: [
      `We've sent ${peso(r.amountCentavos)} back to your ${METHOD_NAME[r.paymentMethod] ?? r.paymentMethod} for the cancelled package from ${r.storeName} (order ${r.number}).`,
      "Depending on your bank or e-wallet, it can take a few days to appear.",
      "",
      `Your order: ${appUrl}/orders/${r.orderId}`
    ].join("\n")
  };
}

/** A Finance admin sent a delayed refund another way (e.g. a GCash transfer), keeping the "refund delayed" email's promise. */
export function refundSentByHandEmail(to: string, r: { orderId: string; number: string; amountCentavos: number; reference: string }, appUrl: string): EmailMessage {
  return {
    to,
    kind: "refund-sent-by-hand",
    subject: `Refund sent: ${peso(r.amountCentavos)} for order ${r.number}`,
    text: [
      `As promised, our team has sent your refund of ${peso(r.amountCentavos)} for order ${r.number} by hand.`,
      `Transfer reference: ${r.reference}. Depending on your bank or e-wallet, it can take a few days to appear.`,
      "",
      `Your order: ${appUrl}/orders/${r.orderId}`
    ].join("\n")
  };
}

/** PayMongo kept refusing the refund for 3 days: a person sends it by hand. */
export function refundDelayedEmail(to: string, r: { orderId: string; number: string; amountCentavos: number }, appUrl: string): EmailMessage {
  return {
    to,
    kind: "refund-delayed",
    subject: `Your refund for order ${r.number} is taking longer`,
    text: [
      `We couldn't send your refund of ${peso(r.amountCentavos)} for order ${r.number} automatically. Our team is sending it by hand, and we'll email you when it's done.`,
      "Sorry for the wait.",
      "",
      `Your order: ${appUrl}/orders/${r.orderId}`
    ].join("\n")
  };
}
