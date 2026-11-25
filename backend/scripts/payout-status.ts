/**
 * Until the admin screens (milestone 7), the payout transfer is simulated: mark a payout paid,
 * or failed (its money goes back to the store's available balance). The seller's email is printed.
 *   npm run payout:paid -- PO-2026-1123-K4Q2
 *   npm run payout:failed -- PO-2026-1123-K4Q2 "The GCash account is closed"
 */
import { existsSync } from "node:fs";
import { DevOutbox } from "../src/lib/email.js";
import { createPrisma } from "../src/lib/prisma.js";
import { PayoutService } from "../src/modules/seller/payouts.service.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const url = process.env.DATABASE_URL;
const [action, reference, reason] = process.argv.slice(2);
if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
if ((action !== "paid" && action !== "failed") || !reference || (action === "failed" && !reason)) {
  throw new Error('Usage: npm run payout:paid -- <reference>   or   npm run payout:failed -- <reference> "<reason>"');
}

const prisma = createPrisma(url);
const outbox = new DevOutbox();
try {
  const payouts = new PayoutService({ prisma, email: outbox, appUrl: process.env.APP_URL ?? "http://localhost:5173" });
  const result = action === "paid" ? await payouts.markPaid(reference) : await payouts.markFailed(reference, reason ?? "");
  await payouts.drain();
  const messages: Record<string, string> = {
    paid: `${reference} is paid.`,
    failed: `${reference} failed: its money is back in the store's available balance.`,
    not_processing: `${reference} isn't in progress (already paid or failed).`,
    not_found: `No payout ${reference}.`
  };
  console.log(messages[result]);
  for (const m of outbox.sent) console.log(`Emailed ${m.to}: "${m.subject}"`);
  if (result === "not_processing" || result === "not_found") process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
