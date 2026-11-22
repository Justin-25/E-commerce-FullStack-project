import type { EmailMessage } from "../../lib/email.js";

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
