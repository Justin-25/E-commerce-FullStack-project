import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AUTO_CONFIRM_DAYS } from "../../src/modules/orders/deadlines.js";
import { Browser } from "../support/browser.js";
import { createCatalogHarness, type CatalogHarness } from "../support/catalogHarness.js";
import { shopping } from "../support/shopping.js";

let h: CatalogHarness;
let shop: ReturnType<typeof shopping>;
beforeAll(async () => {
  h = await createCatalogHarness();
  shop = shopping(h);
}, 120_000);
beforeEach(() => {
  h.clock.offsetMs = 0;
});
afterAll(() => h?.close());

const DAY = 24 * 60 * 60 * 1000;
const received = (b: Browser, orderId: string, packageId: string) =>
  b.post(`/api/v1/orders/${orderId}/packages/${packageId}/received`);
const ledgerOf = (packageId: string) =>
  h.db.prisma.ledgerEntry.findMany({ where: { sellerOrderId: packageId }, orderBy: { type: "asc" }, select: { type: true, amountCentavos: true, availableAt: true, description: true } });

describe('"Order received"', () => {
  it("delivers the package, credits the seller (sale and 5% fee, available 7 days later), and completes the order once nothing's on its way", async () => {
    const s = await shop.shopper();
    const o = await shop.order(s, [["SC-POCKET-BLK", 1], ["NW-TINY-PNK", 1]]); // two stores, cash on delivery
    const [p1, p2] = o.packages;
    for (const p of o.packages) await shop.ship(p.id);

    const res = await received(s.browser, o.id, p1?.id ?? "");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    let pkg = res.body.order.packages.find((p: { id: string }) => p.id === p1?.id);
    expect(pkg).toMatchObject({ status: "DELIVERED", deliveryConfirmedBy: "buyer", canConfirmReceived: false, autoConfirmAt: null });
    expect(pkg.events[0]).toMatchObject({ type: "delivered", message: "Delivered · you confirmed you received it" });
    expect(pkg.items[0].canReview).toBe(true);
    // The other package is still on its way: the order isn't complete, the cash isn't collected yet.
    expect(res.body.order.status).toBe("PLACED");
    expect(res.body.order.payment.status).toBe("PENDING");

    const so = await h.db.prisma.sellerOrder.findUniqueOrThrow({ where: { id: p1?.id ?? "" } });
    const availableAt = new Date((so.deliveredAt?.getTime() ?? 0) + 7 * DAY);
    expect(await ledgerOf(so.id)).toEqual([
      { type: "SALE", amountCentavos: so.subtotalCentavos, availableAt, description: `Sale · ${o.number}` },
      { type: "FEE", amountCentavos: -so.platformFeeCentavos, availableAt, description: `Vendora fee · ${o.number}` }
    ]);
    expect(so.platformFeeCentavos).toBe(Math.round(so.subtotalCentavos * 0.05)); // demo stores are past their 30 fee-free days

    // Pressing it again changes nothing (and isn't an error).
    expect((await received(s.browser, o.id, p1?.id ?? "")).status).toBe(200);
    expect(await ledgerOf(so.id)).toHaveLength(2);

    const last = await received(s.browser, o.id, p2?.id ?? "");
    expect(last.body.order.status).toBe("COMPLETED");
    expect(last.body.order.payment.status).toBe("PAID"); // the courier collected the cash
    pkg = last.body.order.packages.find((p: { id: string }) => p.id === p2?.id);
    expect(last.body.order.payment.paidAt).toBe(pkg.deliveredAt);
    expect((await s.browser.get("/api/v1/orders?tab=delivered")).body.items.map((x: { id: string }) => x.id)).toContain(o.id);
  });

  it("refuses before the seller ships (409 not_shipped); someone else's order or package is 404", async () => {
    const s = await shop.shopper();
    const o = await shop.order(s, [["SC-POCKET-MNT", 1]]);
    const p = o.packages[0]?.id ?? "";
    const early = await received(s.browser, o.id, p);
    expect([early.status, early.body.error?.details?.reason]).toEqual([409, "not_shipped"]);

    await shop.ship(p);
    const other = await shop.shopper("Jose Rizal");
    const theirs = await shop.order(other, [["SC-POCKET-LIL", 1]]);
    expect((await received(other.browser, o.id, p)).status).toBe(404); // not their order
    expect((await received(s.browser, o.id, theirs.packages[0]?.id ?? "")).status).toBe(404); // a package of another order
    expect((await received(s.browser, o.id, "not-a-uuid")).status).toBe(400);
    expect((await received(await Browser.open(h.app), o.id, p)).status).toBe(401); // signed out (with a CSRF token)
    expect((await request(h.app).post(`/api/v1/orders/${o.id}/packages/${p}/received`)).status).toBe(403); // no CSRF token
    expect((await s.browser.agent.post(`/api/v1/orders/${o.id}/packages/${p}/received`)).status).toBe(403); // signed in, no CSRF token
    expect((await h.db.prisma.sellerOrder.findUniqueOrThrow({ where: { id: p } })).status).toBe("SHIPPED");
  });
});

describe("the earnings ledger", () => {
  it("every delivered package (the demo stores' history included) has exactly one sale line, and one fee line when there's a fee", async () => {
    const [check] = await h.db.prisma.$queryRaw<{ delivered: number; wrong: number }[]>`
      SELECT count(*)::int AS delivered,
             count(*) FILTER (WHERE
               (SELECT count(*) FROM ledger_entries l WHERE l."sellerOrderId" = so.id AND l.type = 'SALE' AND l."amountCentavos" = so."subtotalCentavos" AND l."availableAt" = so."deliveredAt" + interval '7 days') <> 1
               OR (SELECT count(*) FROM ledger_entries l WHERE l."sellerOrderId" = so.id AND l.type = 'FEE' AND l."amountCentavos" = -so."platformFeeCentavos") <> (CASE WHEN so."platformFeeCentavos" > 0 THEN 1 ELSE 0 END)
             )::int AS wrong
      FROM seller_orders so WHERE so.status = 'DELIVERED'`;
    expect(check?.delivered).toBeGreaterThan(500); // the demo shoppers' delivered orders
    expect(check?.wrong).toBe(0);
  });
});

describe("automatic confirmation", () => {
  it("confirms packages shipped 7+ days ago, dated at the end of the 7 days; younger ones wait", async () => {
    const s = await shop.shopper();
    const old = await shop.order(s, [["NW-TINY-BLU", 1]]);
    const recent = await shop.order(s, [["NW-TINY-PNK", 1]]);
    const shippedAt = new Date(Date.now() - 8 * DAY);
    await shop.ship(old.packages[0]?.id ?? "", { at: shippedAt });
    await shop.ship(recent.packages[0]?.id ?? "", { at: new Date(Date.now() - 6 * DAY) });

    expect(await h.delivery().confirmDue()).toBeGreaterThanOrEqual(1);
    const done = await h.db.prisma.sellerOrder.findUniqueOrThrow({ where: { id: old.packages[0]?.id ?? "" } });
    const deliveredAt = new Date(shippedAt.getTime() + AUTO_CONFIRM_DAYS * DAY);
    expect(done).toMatchObject({ status: "DELIVERED", deliveryConfirmedBy: "AUTO", deliveredAt });
    expect((await ledgerOf(done.id)).map((l) => l.availableAt)).toEqual([new Date(deliveredAt.getTime() + 7 * DAY), new Date(deliveredAt.getTime() + 7 * DAY)]);
    expect((await h.db.prisma.sellerOrder.findUniqueOrThrow({ where: { id: recent.packages[0]?.id ?? "" } })).status).toBe("SHIPPED");

    const view = (await s.browser.get(`/api/v1/orders/${old.id}`)).body.order;
    expect(view.status).toBe("COMPLETED");
    expect(view.packages[0].events.find((e: { type: string }) => e.type === "delivered")).toMatchObject({ message: "Delivered · confirmed automatically 7 days after shipping", at: deliveredAt.toISOString() });

    // A day later, the younger one is due too.
    h.clock.offsetMs = DAY + 60_000;
    await h.delivery().confirmDue();
    expect((await h.db.prisma.sellerOrder.findUniqueOrThrow({ where: { id: recent.packages[0]?.id ?? "" } })).status).toBe("DELIVERED");
  });

  it("the buyer's tap and the job at the same moment credit the seller once; two packages at once complete the order once", async () => {
    const s = await shop.shopper();
    const o = await shop.order(s, [["SC-BOOM-MINI-CRL", 1]]);
    const p = o.packages[0]?.id ?? "";
    await shop.ship(p, { at: new Date(Date.now() - 8 * DAY) });
    const [tap] = await Promise.all([received(s.browser, o.id, p), h.delivery().confirmDue()]);
    expect(tap.status).toBe(200);
    expect((await ledgerOf(p)).map((l) => l.type)).toEqual(["SALE", "FEE"]); // one of each

    const two = await shop.order(s, [["SC-POCKET-BLK", 1], ["GL-TONER-150", 1]]);
    for (const pkg of two.packages) await shop.ship(pkg.id);
    const at = new Date();
    const results = await Promise.all(two.packages.map((pkg) => h.delivery().deliver(pkg.id, at, "BUYER")));
    expect(results).toEqual([true, true]);
    expect((await h.db.prisma.order.findUniqueOrThrow({ where: { id: two.id } })).status).toBe("COMPLETED");
    expect(await h.delivery().deliver(two.packages[0]?.id ?? "", at, "AUTO")).toBe(false); // already delivered
  });
});
