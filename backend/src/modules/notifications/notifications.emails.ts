import type { EmailMessage } from "../../lib/email.js";
import { formatPeso } from "../../lib/money.js";

export interface DroppedItem {
  productId: string;
  title: string;
  /** The price when the shopper saved it (the "was" price). */
  savedCentavos: number;
  nowCentavos: number;
  /** A running deal's end ("Deal ends Nov 24, 9:00 PM"). */
  saleEndsAt: Date | null;
}

/** Items listed in one email; the rest are summed up with a link to the wishlist. */
export const ITEMS_PER_EMAIL = 10;

const manilaTime = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * "Price drop on 2 items in your wishlist". At most one a day per shopper. Every one has an
 * unsubscribe link, plus the List-Unsubscribe headers mail apps use for their own one-click
 * "Unsubscribe" button (RFC 8058; Gmail and Yahoo expect it on bulk email).
 */
export function priceDropEmail(
  to: string,
  name: string,
  items: DroppedItem[],
  links: { appUrl: string; unsubscribeUrl: string; oneClickUrl: string }
): EmailMessage {
  const first = items[0];
  const subject =
    items.length === 1 && first ? `Price drop: ${short(first.title, 60)} is now ${formatPeso(first.nowCentavos)}` : `Price drop on ${items.length} items in your wishlist`;
  const lines = items.slice(0, ITEMS_PER_EMAIL).flatMap((i) => {
    const percent = Math.round(((i.savedCentavos - i.nowCentavos) / i.savedCentavos) * 100);
    const deal = i.saleEndsAt ? ` Deal ends ${manilaTime.format(i.saleEndsAt)}.` : "";
    return [`• ${i.title}: now ${formatPeso(i.nowCentavos)} (was ${formatPeso(i.savedCentavos)}, save ${percent}%).${deal}`, `  ${links.appUrl}/products/${i.productId}`];
  });
  const more = items.length - ITEMS_PER_EMAIL;
  return {
    to,
    subject,
    kind: "price-drop",
    headers: { "List-Unsubscribe": `<${links.oneClickUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    text: [
      `Hi ${name.split(" ")[0] || name},`,
      "",
      `${items.length === 1 ? "An item" : `${items.length} items`} in your Vendora wishlist got cheaper:`,
      "",
      ...lines,
      ...(more > 0 ? [`…and ${more} more.`] : []),
      "",
      `See your wishlist: ${links.appUrl}/wishlist`,
      "",
      "You're getting this because you saved these items to your wishlist.",
      `Stop price-drop emails: ${links.unsubscribeUrl}`
    ].join("\n")
  };
}
