import type { EmailMessage } from "../../lib/email.js";
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
