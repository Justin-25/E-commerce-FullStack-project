/**
 * The demo stores' payout history: each gets a demo GCash payout account (encrypted like a real
 * one, verified since the store was approved) and one payout for every past Monday 9:00 AM
 * (Manila), made of the ledger lines that had become available by then, like a store that has
 * been paid every week. Paid the next day; the latest one may still be on its way. Lines that
 * became available since the last Monday stay "Available now".
 *
 * Stores that already have payouts are skipped, so it's safe to run again (re-seeding the demo
 * orders clears the demo payouts first, see demo-reviews.ts).
 */
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "../src/generated/prisma/client.js";
import { createFieldCipher } from "../src/lib/encryption.js";
import { lastPayoutTime } from "../src/modules/orders/deadlines.js";
import { payoutReference } from "../src/modules/seller/payouts.service.js";
import { STORES } from "./demo-data.js";

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;

export async function seedDemoPayouts(prisma: PrismaClient, encryptionKey: string, now = new Date()): Promise<{ stores: number; payouts: number }> {
  const cipher = createFieldCipher(encryptionKey);
  const lastMonday = lastPayoutTime(now);
  const stores = await prisma.store.findMany({
    where: { slug: { in: STORES.map((s) => s.slug) } },
    include: { owner: { select: { name: true } }, payoutAccount: true, _count: { select: { payouts: true } } },
    orderBy: { slug: "asc" }
  });
  let storesDone = 0;
  let made = 0;
  for (const [i, store] of stores.entries()) {
    if (store._count.payouts > 0) continue;
    const number = `09175550${String(140 + i)}`; // a made-up GCash number per store
    const account =
      store.payoutAccount ??
      (await prisma.payoutAccount.create({
        data: { storeId: store.id, method: "GCASH", accountName: store.owner.name, accountNumberEncrypted: cipher.encrypt(number, `store:${store.id}:payout`), last4: number.slice(-4), verifiedAt: store.approvedAt ?? now }
      }));

    // Every line goes to the first Monday 9:00 AM at or after it became available.
    const lines = await prisma.ledgerEntry.findMany({
      where: { storeId: store.id, payoutId: null, availableAt: { lte: lastMonday } },
      orderBy: [{ availableAt: "asc" }, { id: "asc" }],
      select: { id: true, type: true, sellerOrderId: true, amountCentavos: true, availableAt: true }
    });
    const weeks = new Map<number, typeof lines>();
    for (const l of lines) {
      const last = lastPayoutTime(l.availableAt).getTime();
      const at = last === l.availableAt.getTime() ? last : last + WEEK_MS;
      weeks.set(at, [...(weeks.get(at) ?? []), l]);
    }

    const payouts: Prisma.PayoutCreateManyInput[] = [];
    const payoutLines: Prisma.LedgerEntryCreateManyInput[] = [];
    const links: { payoutId: string; ids: string[] }[] = [];
    for (const [at, group] of [...weeks].sort((a, b) => a[0] - b[0])) {
      const total = group.reduce((s, l) => s + l.amountCentavos, 0);
      if (total <= 0) continue;
      const id = randomUUID();
      const createdAt = new Date(at);
      const paidAt = new Date(at + 25 * HOUR_MS); // the next day, 10:00 AM
      const sum = (type: string) => group.filter((l) => l.type === type).reduce((s, l) => s + l.amountCentavos, 0);
      const reference = payoutReference(createdAt);
      payouts.push({
        id,
        storeId: store.id,
        reference,
        amountCentavos: total,
        method: account.method,
        accountLast4: account.last4,
        orderCount: new Set(group.filter((l) => l.type === "SALE").map((l) => l.sellerOrderId)).size,
        grossCentavos: sum("SALE"),
        feesCentavos: -sum("FEE"),
        ...(paidAt <= now ? { status: "PAID" as const, paidAt, transferReference: `DEMO-${reference}` } : { status: "PROCESSING" as const }),
        createdAt,
        updatedAt: paidAt <= now ? paidAt : createdAt
      });
      payoutLines.push({ storeId: store.id, payoutId: id, type: "PAYOUT", amountCentavos: -total, description: `Payout ${reference}`, availableAt: createdAt, createdAt });
      links.push({ payoutId: id, ids: group.map((l) => l.id) });
    }
    await prisma.$transaction(
      async (tx) => {
        await tx.payout.createMany({ data: payouts });
        for (const l of links) await tx.ledgerEntry.updateMany({ where: { id: { in: l.ids } }, data: { payoutId: l.payoutId } });
        await tx.ledgerEntry.createMany({ data: payoutLines });
      },
      { timeout: 120_000, maxWait: 20_000 }
    );
    storesDone++;
    made += payouts.length;
  }
  return { stores: storesDone, payouts: made };
}
