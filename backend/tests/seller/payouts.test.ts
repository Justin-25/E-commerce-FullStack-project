import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFieldCipher } from "../../src/lib/encryption.js";
import { lastPayoutTime, nextPayoutTime } from "../../src/modules/orders/deadlines.js";
import { seedDemoPayouts } from "../../prisma/demo-payouts.js";
import { STORES } from "../../prisma/demo-data.js";
import type { Browser } from "../support/browser.js";
import { createCatalogHarness, type CatalogHarness } from "../support/catalogHarness.js";
import { sellers } from "../support/sellers.js";
import { shopping } from "../support/shopping.js";
import { testConfig } from "../helpers.js";

let h: CatalogHarness;
let sell: ReturnType<typeof sellers>;
let shop: ReturnType<typeof shopping>;
beforeAll(async () => {
  h = await createCatalogHarness();
  sell = sellers(h);
  shop = shopping(h);
}, 120_000);
beforeEach(() => {
  h.clock.offsetMs = 0;
});
afterAll(() => h?.close());

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const P = "/api/v1/seller/payouts";
type Payouts = {
  available: { centavos: number };
  waiting: { centavos: number; orders: number };
  paidThisMonth: { centavos: number };
  account: { method: string; last4: string; verified: boolean } | null;
  schedule: { nextAutomaticAt: string; minimumCentavos: number };
  canRequest: boolean;
  cannotRequest: { reason: string } | null;
  history: { items: { reference: string; status: string; amountCentavos: number; orders: number; grossCentavos: number; feesCentavos: number; failureReason: string | null; accountLast4: string }[]; totalItems: number };
};

/** An approved seller past the fee-free days (5% fee) with a ₱1,500 product; its payout account is verified at approval. */
async function sellerWithProduct(priceCentavos = 150_000) {
  const seller = await sell.seller({ approve: true });
  await h.db.prisma.store.update({ where: { id: seller.store.id }, data: { approvedAt: new Date(Date.now() - 40 * DAY) } });
  const product = await sell.publish(seller.browser, { variants: [{ name: "Blue", sku: `SKU-${randomUUID().slice(0, 8)}`, priceCentavos, stock: 50 }] });
  return { seller, sku: product.variants[0]?.sku ?? "" };
}

/** A cash-on-delivery order of one unit; "shipped" ships it through Seller Center, "delivered" also has the buyer confirm it. */
async function sale(seller: { browser: Browser }, sku: string, to: "placed" | "shipped" | "delivered") {
  const buyer = await shop.shopper();
  const o = await shop.order(buyer, [[sku, 1]]);
  const id = o.packages[0]?.id ?? "";
  if (to !== "placed") expect((await seller.browser.put(`/api/v1/seller/orders/${id}/shipment`, { courier: "LBC", trackingNumber: `LBC${randomUUID().replace(/-/g, "").slice(0, 10)}` })).status).toBe(200);
  if (to === "delivered") expect((await buyer.browser.post(`/api/v1/orders/${o.id}/packages/${id}/received`)).status).toBe(200);
  return id;
}

const page = async (b: Browser) => {
  const res = await b.get(P);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Payouts;
};
const balanceOf = async (storeId: string) => (await h.db.prisma.ledgerEntry.aggregate({ where: { storeId }, _sum: { amountCentavos: true } }))._sum.amountCentavos ?? 0;
const mail = (to: string, kind: string) => h.outbox.sent.filter((m) => m.to === to && m.kind === kind);

describe("Payouts", () => {
  it("waits 7 days after delivery, then Request payout pays everything available, once; paid adds to this month", async () => {
    const { seller, sku } = await sellerWithProduct();
    await sale(seller, sku, "delivered");
    await sale(seller, sku, "shipped");
    await sale(seller, sku, "placed");

    let view = await page(seller.browser);
    expect(view).toMatchObject({
      available: { centavos: 0 },
      waiting: { centavos: 3 * 142_500, orders: 3 }, // ₱1,500 − 5% each: on hold, shipped, to ship
      account: { method: "GCASH", last4: "4567", verified: true },
      schedule: { nextAutomaticAt: nextPayoutTime(new Date()).toISOString(), minimumCentavos: 10_000 },
      canRequest: false,
      cannotRequest: { reason: "below_minimum" }
    });
    expect((await seller.browser.post(P)).body.error?.details?.reason).toBe("below_minimum");

    h.clock.offsetMs = 7 * DAY + HOUR; // a week after delivery
    view = await page(seller.browser);
    expect(view).toMatchObject({ available: { centavos: 142_500 }, waiting: { centavos: 2 * 142_500, orders: 2 }, canRequest: true, cannotRequest: null });

    const res = await seller.browser.post(P);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    view = res.body;
    const [payout] = view.history.items;
    expect(payout).toMatchObject({ status: "PROCESSING", amountCentavos: 142_500, orders: 1, grossCentavos: 150_000, feesCentavos: 7_500, accountLast4: "4567" });
    expect(payout?.reference).toMatch(/^PO-\d{4}-\d{4}-[A-Z0-9]{4}$/);
    expect(view).toMatchObject({ available: { centavos: 0 }, canRequest: false, cannotRequest: { reason: "in_progress" } });
    expect(mail(seller.user.email, "seller-payout-started").at(-1)?.subject).toBe(`Payout ${payout?.reference}: ₱1,425 is on its way`);
    expect(await balanceOf(seller.store.id)).toBe(0); // the sale, the fee and the payout add up to nothing left
    const again = await seller.browser.post(P);
    expect([again.status, again.body.error?.details?.reason]).toEqual([409, "in_progress"]);

    expect(await h.payouts().markPaid(payout?.reference ?? "")).toBe("paid");
    expect(await h.payouts().markPaid(payout?.reference ?? "")).toBe("not_processing");
    view = await page(seller.browser);
    expect(view.history.items[0]?.status).toBe("PAID");
    expect(view.paidThisMonth.centavos).toBe(142_500);
    expect(mail(seller.user.email, "seller-payout-paid")).toHaveLength(1);

    // The next payout takes only what's new: the shipped order, once it's delivered and released.
    h.clock.offsetMs = 0;
    const shipped = await h.db.prisma.sellerOrder.findFirstOrThrow({ where: { storeId: seller.store.id, status: "SHIPPED" } });
    await h.delivery().deliver(shipped.id, new Date(), "BUYER");
    h.clock.offsetMs = 7 * DAY + 2 * HOUR;
    const next = ((await seller.browser.post(P)).body as Payouts).history.items[0];
    expect(next).toMatchObject({ status: "PROCESSING", amountCentavos: 142_500, orders: 1 });
  });

  it("a failed payout puts the money back with a new line (nothing edited), and it can be paid again", async () => {
    const { seller, sku } = await sellerWithProduct();
    await sale(seller, sku, "delivered");
    h.clock.offsetMs = 7 * DAY + HOUR;
    const first = ((await seller.browser.post(P)).body as Payouts).history.items[0];
    expect(await h.payouts().markFailed(first?.reference ?? "", "The GCash account is closed")).toBe("failed");

    const view = await page(seller.browser);
    expect(view.history.items[0]).toMatchObject({ status: "FAILED", failureReason: "The GCash account is closed", orders: 1, amountCentavos: 142_500 });
    expect(view).toMatchObject({ available: { centavos: 142_500 }, canRequest: true });
    const lines = await h.db.prisma.ledgerEntry.findMany({ where: { storeId: seller.store.id }, orderBy: { type: "asc" }, select: { type: true, amountCentavos: true, payoutId: true } });
    expect(lines.map((l) => [l.type, l.amountCentavos, l.payoutId !== null])).toEqual([
      ["SALE", 150_000, false],
      ["FEE", -7_500, false],
      ["PAYOUT", -142_500, true],
      ["ADJUSTMENT", 142_500, true]
    ]);
    expect(mail(seller.user.email, "seller-payout-failed").at(-1)?.text).toContain("The GCash account is closed");

    const second = await seller.browser.post(P);
    expect(second.status).toBe(201);
    expect((second.body as Payouts).history.items.map((p) => [p.status, p.amountCentavos])).toEqual([
      ["PROCESSING", 142_500],
      ["FAILED", 142_500]
    ]);
    expect(await balanceOf(seller.store.id)).toBe(0);
  });

  it("only to a verified payout account; not for suspended stores; only sellers", async () => {
    const { seller, sku } = await sellerWithProduct();
    await sale(seller, sku, "delivered");
    h.clock.offsetMs = 7 * DAY + HOUR;
    await h.db.prisma.payoutAccount.update({ where: { storeId: seller.store.id }, data: { verifiedAt: null } });
    let res = await seller.browser.post(P);
    expect([res.status, res.body.error?.details?.reason]).toEqual([409, "account_not_verified"]);
    expect((await page(seller.browser)).account?.verified).toBe(false);
    await h.db.prisma.payoutAccount.update({ where: { storeId: seller.store.id }, data: { verifiedAt: new Date() } });
    await h.db.prisma.store.update({ where: { id: seller.store.id }, data: { status: "SUSPENDED" } });
    res = await seller.browser.post(P);
    expect([res.status, res.body.error?.details?.reason]).toEqual([403, "store_suspended"]);
    expect((await page(seller.browser)).cannotRequest?.reason).toBe("store_not_approved");

    const shopper = await shop.shopper();
    expect((await shopper.browser.get(P)).status).toBe(403);
    expect((await request(h.app).get(P)).status).toBe(401);
  });

  it("the Monday payout: from 9:00 AM Manila, what was available by then, once a week; two runs at once make one", async () => {
    const { seller, sku } = await sellerWithProduct();
    await sale(seller, sku, "delivered");
    const releasedAt = new Date(Date.now() + 7 * DAY);
    const monday = nextPayoutTime(releasedAt); // the first Monday 9:00 AM after the money is released
    const at = (t: number) => {
      h.clock.offsetMs = t - Date.now();
    };
    const mine = () => h.db.prisma.payout.count({ where: { storeId: seller.store.id } });

    at(monday.getTime() - 60_000); // 8:59 AM: not yet (and on any day before, it waits for Monday)
    await h.payouts().runWeekly();
    expect(await mine()).toBe(0);
    at(monday.getTime() + 60_000);
    await Promise.all([h.payouts().runWeekly(), h.payouts().runWeekly()]);
    expect(await mine()).toBe(1);
    const payout = await h.db.prisma.payout.findFirstOrThrow({ where: { storeId: seller.store.id } });
    expect(payout).toMatchObject({ status: "PROCESSING", amountCentavos: 142_500 });
    expect(lastPayoutTime(payout.createdAt).getTime()).toBe(monday.getTime());

    await h.payouts().markPaid(payout.reference);
    at(monday.getTime() + 2 * DAY); // later that week: already paid this week
    await h.payouts().runWeekly();
    expect(await mine()).toBe(1);
  });

  it("statements: one month's ledger lines as CSV (amounts as numbers, negative for money out)", async () => {
    const { seller, sku } = await sellerWithProduct();
    const id = await sale(seller, sku, "delivered");
    h.clock.offsetMs = 7 * DAY + HOUR;
    const ref = ((await seller.browser.post(P)).body as Payouts).history.items[0]?.reference;
    const created = await h.db.prisma.ledgerEntry.findFirstOrThrow({ where: { sellerOrderId: id, type: "SALE" } });
    const month = new Date(created.createdAt.getTime() + 8 * HOUR).toISOString().slice(0, 7);
    const order = await h.db.prisma.sellerOrder.findUniqueOrThrow({ where: { id }, select: { order: { select: { orderNumber: true } } } });

    const res = await seller.browser.get(`${P}/statement?month=${month}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toBe(`attachment; filename=vendora-statement-${month}.csv`);
    const lines = res.text.slice(1).trimEnd().split("\r\n");
    expect(lines[0]).toBe("Date (PH time),Type,Order,Description,Amount (PHP),Available from (PH time),Payout,Payout status");
    const body = lines.slice(1).map((l) => l.split(","));
    expect(body.find((c) => c[1] === "Sale")?.slice(2, 5)).toEqual([`VD-${order.order.orderNumber}`, `Sale · VD-${order.order.orderNumber}`, "1500"]);
    expect(body.find((c) => c[1] === "Vendora fee")?.[4]).toBe("-75");
    expect(body.find((c) => c[1] === "Sale")?.[6]).toBe(ref);
    for (const bad of ["2026-13", "26-11", "nope", ""]) expect((await seller.browser.get(`${P}/statement?month=${bad}`)).status).toBe(400);
  });
});

describe("the demo stores' payout history", () => {
  it("gives each demo store a verified GCash account and a paid payout for every past Monday; again changes nothing", async () => {
    const key = testConfig().DATA_ENCRYPTION_KEY;
    const now = new Date();
    const result = await seedDemoPayouts(h.db.prisma, key, now);
    expect(result.stores).toBe(STORES.length);
    expect(result.payouts).toBeGreaterThan(50);
    expect(await seedDemoPayouts(h.db.prisma, key, now)).toEqual({ stores: 0, payouts: 0 });

    const lastMonday = lastPayoutTime(now);
    for (const s of STORES) {
      const store = await h.db.prisma.store.findUniqueOrThrow({ where: { slug: s.slug }, include: { payoutAccount: true } });
      const account = store.payoutAccount;
      expect(account?.verifiedAt).not.toBeNull();
      expect(createFieldCipher(key).decrypt(account?.accountNumberEncrypted ?? "", `store:${store.id}:payout`).slice(-4)).toBe(account?.last4);
      // Everything released by last Monday 9:00 AM was paid out; only this week's money is left.
      const left = await h.db.prisma.ledgerEntry.aggregate({ where: { storeId: store.id, payoutId: null, availableAt: { lte: lastMonday } }, _sum: { amountCentavos: true } });
      expect(left._sum.amountCentavos ?? 0).toBe(0);
      // Each payout equals its lines, and all are on Mondays 9:00 AM (Manila).
      const payouts = await h.db.prisma.payout.findMany({ where: { storeId: store.id }, include: { ledgerEntries: { select: { type: true, amountCentavos: true, availableAt: true } } } });
      for (const p of payouts) {
        expect(p.ledgerEntries.every((l) => l.availableAt <= p.createdAt)).toBe(true); // nothing paid before it was released
        const lines = p.ledgerEntries.filter((l) => l.type !== "PAYOUT").reduce((sum, l) => sum + l.amountCentavos, 0);
        expect([lines, -(p.ledgerEntries.find((l) => l.type === "PAYOUT")?.amountCentavos ?? 0)]).toEqual([p.amountCentavos, p.amountCentavos]);
        expect(lastPayoutTime(p.createdAt).getTime()).toBe(p.createdAt.getTime());
      }
      expect(payouts.filter((p) => p.status === "PROCESSING").length).toBeLessThanOrEqual(1);
    }
  });
});
