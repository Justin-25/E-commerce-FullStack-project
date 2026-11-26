import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { KeyValueStore } from "../../src/lib/kv.js";
import { manilaCutoff } from "../../src/modules/orders/deadlines.js";
import { VisitService, manilaDay } from "../../src/modules/stores/visits.js";
import type { Browser } from "../support/browser.js";
import { createCatalogHarness, type CatalogHarness } from "../support/catalogHarness.js";
import { sellers } from "../support/sellers.js";
import { shopping } from "../support/shopping.js";

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
  h.redis.down = false;
});
afterAll(() => h?.close());

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
type Dashboard = {
  period: { days: number };
  stats: {
    sales: { centavos: number; previousCentavos: number; change: number | null };
    orders: { count: number; previous: number; change: number | null; toShipToday: number };
    visits: { count: number; previous: number; change: number | null };
    rating: { average: number; count: number; change: number | null };
  };
  chart: { days: { day: string; salesCentavos: number }[]; totalCentavos: number; bestDay: string | null };
  recentOrders: { number: string; status: string }[];
  tasks: { kind: string; count: number; title: string }[];
};

async function store() {
  const seller = await sell.seller({ approve: true });
  const product = await sell.publish(seller.browser, { variants: [{ name: "Blue", sku: `SKU-${randomUUID().slice(0, 8)}`, priceCentavos: 150_000, stock: 30 }] });
  return { seller, product, sku: product.variants[0]?.sku ?? "" };
}
const dashboard = async (b: Browser, query = "") => {
  const res = await b.get(`/api/v1/seller/dashboard${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Dashboard;
};
/** A visit to a page, as a browser with this user agent. */
const visit = (path: string, userAgent: string) => request(h.app).get(path).set("User-Agent", userAgent);

describe("Seller dashboard", () => {
  it("sales and orders for the last 7 days against the 7 before (cancelled ones left out), sales per day, the latest orders", async () => {
    const { seller, sku } = await store();
    const today = [await shop.order(await shop.shopper(), [[sku, 1]]), await shop.order(await shop.shopper(), [[sku, 2]])];
    const cancelled = await shop.order(await shop.shopper(), [[sku, 1]]);
    expect((await seller.browser.post(`/api/v1/seller/orders/${cancelled.packages[0]?.id}/cancel`, { reason: "BUYER_ASKED" })).status).toBe(200);
    const older = await shop.order(await shop.shopper(), [[sku, 1]]);
    await h.db.prisma.order.update({ where: { id: older.id }, data: { placedAt: new Date(Date.now() - 10 * DAY) } }); // in the 7 days before

    const d = await dashboard(seller.browser);
    expect(d.period.days).toBe(7);
    expect(d.stats.sales).toEqual({ centavos: 450_000, previousCentavos: 150_000, change: 200 });
    expect(d.stats.orders).toMatchObject({ count: 2, previous: 1, change: 100 });
    expect(d.chart.days).toHaveLength(7);
    expect(d.chart.days.at(-1)).toEqual({ day: manilaDay(new Date()), salesCentavos: 450_000 });
    expect(d.chart).toMatchObject({ totalCentavos: 450_000, bestDay: manilaDay(new Date()) });
    expect(d.recentOrders.map((r) => r.number)).toEqual([older.number, cancelled.number, ...today.map((o) => o.number).reverse()]);
    expect(d.stats.rating).toEqual({ average: 0, count: 0, change: null });

    const month = await dashboard(seller.browser, "?period=30d");
    expect(month.period.days).toBe(30);
    expect(month.chart.days).toHaveLength(30);
    expect(month.stats.sales.centavos).toBe(600_000); // the older one is in the last 30 days
    expect((await seller.browser.get("/api/v1/seller/dashboard?period=90d")).status).toBe(400);
  });

  it("Needs attention: late orders, orders due today, out of stock, low stock, a payout account being checked", async () => {
    const { seller, product, sku } = await store();
    // Seen at 9:00 PM (Manila), after the day's 6:00 PM cutoff: a package due at 8:00 PM is late too.
    const evening = new Date(manilaCutoff(new Date()).getTime() + 3 * HOUR);
    const late = await shop.order(await shop.shopper(), [[sku, 1]]);
    await h.db.prisma.sellerOrder.update({ where: { id: late.packages[0]?.id ?? "" }, data: { shipBy: new Date(evening.getTime() - HOUR) } });
    const nearlyGone = await sell.publish(seller.browser, { variants: [{ name: "Red", sku: `SKU-${randomUUID().slice(0, 8)}`, priceCentavos: 50_000, stock: 1 }] });
    await shop.order(await shop.shopper(), [[nearlyGone.variants[0]?.sku ?? "", 1]]); // now 0 left
    await h.db.prisma.productVariant.update({ where: { id: product.variants[0]?.id ?? "" }, data: { stock: 4 } });
    await h.db.prisma.payoutAccount.update({ where: { storeId: seller.store.id }, data: { verifiedAt: null } });

    h.clock.offsetMs = evening.getTime() - Date.now();
    const d = await dashboard(seller.browser);
    expect(d.tasks.map((t) => [t.kind, t.count])).toEqual([
      ["late", 1],
      ["out_of_stock", 1],
      ["low_stock", 1],
      ["payout_account", 1]
    ]);
    expect(d.tasks[0]?.title).toBe("1 order is late");
    expect(d.stats.orders.toShipToday).toBe(1);
  });

  it("is only for sellers", async () => {
    expect((await request(h.app).get("/api/v1/seller/dashboard")).status).toBe(401);
    const shopper = await shop.shopper();
    expect((await shopper.browser.get("/api/v1/seller/dashboard")).status).toBe(403);
  });
});

describe("Store visits", () => {
  it("never keeps anything that identifies a person: the same visitor is a different hash every day and in every store", async () => {
    const members: string[] = [];
    const kv = { countUnique: async (_key: string, member: string) => void members.push(member) } as unknown as KeyValueStore;
    let now = new Date("2026-11-25T03:00:00.000Z");
    const visits = new VisitService({ prisma: h.db.prisma, kv, secret: "c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlY3JldA", now: () => now });
    const person = { ip: "203.0.113.7", userAgent: "Mozilla/5.0 (iPhone) Safari/604.1" };
    await visits.record("store-a", person);
    await visits.record("store-a", person);
    await visits.record("store-b", person);
    now = new Date(now.getTime() + DAY);
    await visits.record("store-a", person);
    const [today, again, otherStore, tomorrow] = members;
    expect(today).toBe(again); // counted once a day
    expect(otherStore).not.toBe(today); // stores can't be linked
    expect(tomorrow).not.toBe(today); // days can't be linked
    expect(members.join()).not.toContain("203.0.113.7");
  });

  it("counts unique visitors per day on the store page and its product pages, without cookies; bots don't count", async () => {
    const { seller, product } = await store();
    const page = `/api/v1/products/${product.id}`;
    const first = await visit(page, "Mozilla/5.0 (iPhone) Safari/604.1");
    expect(first.status).toBe(200);
    expect(first.headers["set-cookie"]).toBeUndefined(); // nothing stored on the visitor's device
    await visit(page, "Mozilla/5.0 (iPhone) Safari/604.1"); // the same visitor again
    await visit(page, "Mozilla/5.0 (Windows NT 10.0) Chrome/131.0");
    await visit(`/api/v1/stores/${seller.store.slug}`, "Mozilla/5.0 (Macintosh) Firefox/133.0");
    await visit(page, "Googlebot/2.1 (+http://www.google.com/bot.html)");
    await request(h.app).get(page); // no user agent: not a browser

    // The 7 days before had 10 visits a day for 3 days (copied there by the nightly job).
    for (const n of [8, 9, 10]) {
      await h.db.prisma.storeDailyVisit.create({ data: { storeId: seller.store.id, day: new Date(`${manilaDay(new Date(Date.now() - n * DAY))}T00:00:00.000Z`), visits: 10 } });
    }
    expect((await dashboard(seller.browser)).stats.visits).toEqual({ count: 3, previous: 30, change: -90 });
  });

  it("copies finished days into Postgres each night; while Redis is down, pages still work and the stored days still show", async () => {
    const { seller, product } = await store();
    const page = `/api/v1/products/${product.id}`;
    await visit(page, "Mozilla/5.0 (Linux; Android 14) Chrome/131.0");
    await visit(page, "Mozilla/5.0 (X11; Linux) Firefox/133.0");

    h.clock.offsetMs = DAY; // tomorrow: yesterday's count is copied
    expect(await h.visits().copyFinishedDays()).toBeGreaterThanOrEqual(1);
    await h.visits().copyFinishedDays(); // again: harmless
    const yesterday = manilaDay(new Date());
    expect(await h.db.prisma.storeDailyVisit.findMany({ where: { storeId: seller.store.id }, select: { visits: true } })).toEqual([{ visits: 2 }]);

    h.redis.down = true;
    expect((await visit(page, "Mozilla/5.0 (iPad) Safari/604.1")).status).toBe(200); // not counted, not broken
    const d = await dashboard(seller.browser);
    expect(d.stats.visits.count).toBe(2);
    expect(d.chart.days.some((x) => x.day === yesterday)).toBe(true);
  });
});
