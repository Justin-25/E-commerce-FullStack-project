import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { formatPeso } from "../../src/lib/money.js";
import { SELLER_SYSTEM } from "../../src/modules/ai/prompts.js";
import { periodRange } from "../../src/modules/ai/periods.js";
import { manilaDay } from "../../src/modules/stores/visits.js";
import { ask, CHATS, newChat, resultJson, said, toolResults } from "../support/aiChat.js";
import type { Browser } from "../support/browser.js";
import { createCatalogHarness, type CatalogHarness } from "../support/catalogHarness.js";
import { answer, lookup, toolUse } from "../support/fakeClaude.js";
import { sellers } from "../support/sellers.js";
import { HOME_ADDRESS, shopping } from "../support/shopping.js";

let h: CatalogHarness;
let seller: Awaited<ReturnType<ReturnType<typeof sellers>["seller"]>>;
let rival: Awaited<ReturnType<ReturnType<typeof sellers>["seller"]>>;
let lampOrder: { id: string; number: string };
let mugOrder: { id: string; number: string };
const BUYERS = ["Liza Dela Cruz", "Ramon Bautista", "Joy Villanueva", "Carlo Mendoza"];
const SELLER_TOOLS = ["sales_summary", "best_sellers", "stock_forecast", "orders_to_ship", "payouts", "reviews", "store_visits"];

beforeAll(async () => {
  h = await createCatalogHarness();
  const sell = sellers(h);
  const shop = shopping(h);
  seller = await sell.seller({ approve: true });
  rival = await sell.seller({ approve: true, name: "Rico Ramos" });
  await sell.publish(seller.browser, {
    title: "Desk Lamp Aria",
    category: "lighting",
    variants: [
      { name: "Black", sku: "AI-LAMP-BLK", priceCentavos: 30_000, stock: 20 },
      { name: "White", sku: "AI-LAMP-WHT", priceCentavos: 30_000, stock: 5 }
    ]
  });
  await sell.publish(seller.browser, { title: "Ceramic Mug Bay", category: "kitchen", variants: [{ name: "Blue", sku: "AI-MUG-BLU", priceCentavos: 20_000, stock: 50 }] });
  await sell.publish(rival.browser, { title: "Rival Speaker Max", category: "speakers", variants: [{ name: "Red", sku: "AI-RIVAL-RED", priceCentavos: 25_000, stock: 10 }] });
  await h.db.prisma.productVariant.updateMany({ where: { sku: "AI-LAMP-WHT" }, data: { stock: 0 } }); // sold out

  const [a, b, c, d] = await Promise.all(BUYERS.map((n) => shop.shopper(n)));
  lampOrder = await shop.order(a!, [["AI-LAMP-BLK", 14]]); // ₱4,200 (cash on delivery is up to ₱5,000): 6 left, 1 a day
  mugOrder = await shop.order(b!, [["AI-MUG-BLU", 2]]);
  const cancelled = await shop.order(c!, [["AI-MUG-BLU", 1]]);
  expect((await seller.browser.post(`/api/v1/seller/orders/${cancelled.packages[0]?.id}/cancel`, { reason: "BUYER_ASKED" })).status).toBe(200);
  await shop.order(d!, [["AI-RIVAL-RED", 1]]);
}, 240_000);
afterAll(() => h.close());
beforeEach(() => h.claude.reset());
afterEach(() => {
  if (h.claude.stepErrors.length) throw h.claude.stepErrors[0];
  expect(h.claude.pending, "scripted replies left unused").toBe(0);
});

/** Nothing about buyers, nor the payout account's owner, may reach Claude. */
function expectNoPersonalData(sent: string) {
  for (const secret of [...BUYERS, HOME_ADDRESS.street, HOME_ADDRESS.phone, HOME_ADDRESS.barangay, "@example.com", "Ana Maria Reyes", "0917 123 4567"]) expect(sent).not.toContain(secret);
}

describe("Ask your data in Seller Center: who can use it", () => {
  it("seller chats need Seller Center access; they get the seller's own instructions, lookups and 50 questions a day", async () => {
    const visitor = await h.browser();
    expect((await visitor.post(CHATS, { scope: "seller" })).status).toBe(401);
    const shopper = (await shopping(h).shopper()).browser;
    const refused = await shopper.post(CHATS, { scope: "seller" });
    expect(refused.status).toBe(403);
    expect(refused.body.error.details).toMatchObject({ reason: "not_a_seller" });
    expect((await shopper.get("/api/v1/ai/status?scope=seller")).status).toBe(403);
    expect((await seller.browser.post(CHATS, { scope: "seller", productId: await h.idOf("aurasound-pro") })).status).toBe(400);

    const created = await seller.browser.post(CHATS, { scope: "seller" });
    expect(created.status).toBe(201);
    expect(created.body.conversation).toMatchObject({ scope: "seller", signedIn: true, productId: null });
    expect((await seller.browser.get("/api/v1/ai/status?scope=seller")).body).toMatchObject({ scope: "seller", available: true, questionsPerDay: 50 });
    expect((await seller.browser.get("/api/v1/ai/status")).body).toMatchObject({ scope: "shopper", questionsPerDay: 30 });

    h.claude.reply(answer("Hi! Ask me about your sales, stock, orders, payouts, reviews or visits."));
    const { events } = await ask(seller.browser, created.body.conversation.id, "Hi");
    const req = h.claude.requests[0]!;
    expect(req.system).toBe(SELLER_SYSTEM);
    expect(req.tools.map((t) => t.name)).toEqual(SELLER_TOOLS);
    expect((req.messages[0]!.content as { text: string }[])[0]!.text).toContain(`Seller Center chat for the store "${seller.store.name}"`);
    expect(events.at(-1)).toMatchObject({ type: "done", questionsLeftToday: 49, suggestions: ["Best sellers this month?", "What's running low?", "Compare with last week"] });
  });

  it("lists show one kind of chat at a time", async () => {
    const shopperChat = await newChat(seller.browser);
    const sellerChat = await newChat(seller.browser, { scope: "seller" });
    const ids = async (q: string) => ((await seller.browser.get(`${CHATS}${q}`)).body.conversations as { id: string }[]).map((c) => c.id);
    expect(await ids("?scope=seller")).toContain(sellerChat);
    expect(await ids("?scope=seller")).not.toContain(shopperChat);
    expect(await ids("")).toContain(shopperChat);
    expect(await ids("")).not.toContain(sellerChat);
    expect((await seller.browser.get(`${CHATS}?scope=nope`)).status).toBe(400);
  });

  it("a seller who loses Seller Center access can't keep asking or read the chat (checked on every question)", async () => {
    const id = await newChat(seller.browser, { scope: "seller" });
    const was = await h.db.prisma.user.findUniqueOrThrow({ where: { id: seller.user.id }, select: { twoFactorEnabledAt: true } });
    await h.db.prisma.user.update({ where: { id: seller.user.id }, data: { twoFactorEnabledAt: null } });
    try {
      const refused = await ask(seller.browser, id, "How are sales?");
      expect(refused.res.status).toBe(403);
      expect(refused.res.body.error.details).toMatchObject({ reason: "two_factor_required" });
      expect((await seller.browser.get(`${CHATS}/${id}`)).status).toBe(403);
      expect(h.claude.requests).toHaveLength(0);
    } finally {
      await h.db.prisma.user.update({ where: { id: seller.user.id }, data: { twoFactorEnabledAt: was.twoFactorEnabledAt } });
    }
  });

  it("seller questions have their own 50 a day, apart from the same person's shopping questions", async () => {
    const key = `ai:q:u:${seller.user.id}:staff:${manilaDay(new Date())}`;
    const before = await h.kv.get(key);
    await h.kv.set(key, "50", 3600);
    try {
      const refused = await ask(seller.browser, await newChat(seller.browser, { scope: "seller" }), "Sales?");
      expect(refused.res.status).toBe(429);
      expect(refused.res.body.error.details).toMatchObject({ reason: "ai_daily_limit", limit: 50 });
      expect((await seller.browser.get("/api/v1/ai/status")).body.questionsLeftToday).toBe(30);
    } finally {
      await h.kv.set(key, before ?? "0", 3600);
    }
  });
});

describe("Ask your data in Seller Center: the lookups", () => {
  let chat: string;
  beforeAll(async () => {
    chat = await newChat(seller.browser, { scope: "seller" });
  });
  const dashboard = async (b: Browser) => (await b.get("/api/v1/seller/dashboard")).body as { stats: { sales: { centavos: number } } };

  it("sales, best sellers and orders to ship come from this store only, match the dashboard, and name no buyer", async () => {
    const dash = await dashboard(seller.browser);
    h.claude.reply(lookup(toolUse("sales_summary", { period: "last_7_days" }), toolUse("best_sellers", {}), toolUse("orders_to_ship", {})), (req) => {
      const [sales, best, toShip] = toolResults(req).map((r) => resultJson(r));
      expect(sales).toMatchObject({ sales: formatPeso(dash.stats.sales.centavos), orders: 2, items_sold: 16, cancelled_packages: 1, average_order: "₱2,300" });
      expect(formatPeso(dash.stats.sales.centavos)).toBe("₱4,600");
      expect((best as { products: { title: string; units_sold: number }[] }).products.map((p) => [p.title, p.units_sold])).toEqual([
        ["Desk Lamp Aria", 14],
        ["Ceramic Mug Bay", 2]
      ]);
      expect((toShip as { packages: { order: string }[] }).packages.map((p) => p.order).sort()).toEqual([lampOrder.number, mugOrder.number].sort());
      const sent = JSON.stringify(toolResults(req));
      expect(sent).not.toContain("Rival Speaker");
      expectNoPersonalData(sent);
      return answer("You sold **₱4,600** in the last 7 days.");
    });
    expect(said((await ask(seller.browser, chat, "How did my store do this week?")).events)).toBe("You sold **₱4,600** in the last 7 days.");
  });

  it("Claude can't point a lookup at another store: lookups take no store, and extra fields are refused", async () => {
    h.claude.reply(lookup(toolUse("sales_summary", { period: "last_7_days", store_id: rival.store.id })), (req) => {
      expect(toolResults(req)[0]).toMatchObject({ is_error: true, content: expect.stringMatching(/^Invalid input: .*store_id/) });
      return answer("I can only see your store.");
    });
    await ask(seller.browser, chat, "Show me Rico's sales");
  });

  it("the stock forecast lists sold out and running out at the recent pace, and the answer can show it as a table", async () => {
    let tableId = "";
    h.claude.reply(lookup(toolUse("stock_forecast", {})), (req) => {
      const r = resultJson<{ table_id: string; sold_out: number; variants: { variant: string; stock: number; sold_last_14_days: number; runs_out: string }[] }>(toolResults(req)[0]!);
      expect(r.sold_out).toBe(1);
      expect(r.variants.map((v) => [v.variant, v.stock, v.runs_out])).toEqual([
        ["White", 0, "sold out"],
        ["Black", 6, "about 6 days"]
      ]);
      tableId = r.table_id;
      expect(tableId).toMatch(/^t\d+-1$/);
      return answer(`Two items need restocking:\n[[table:${tableId}]]\n[[table:t999-9]]`);
    });
    const { events } = await ask(seller.browser, chat, "What's running low?");
    const cards = events.find((e) => e.type === "cards") as unknown as { tables: { id: string; title: string; rows: unknown[] }[] };
    expect(cards.tables).toEqual([
      {
        id: tableId,
        title: "Running low",
        rows: [
          { title: "Desk Lamp Aria · White", detail: "Sold out", badge: { label: "Sold out", tone: "danger" }, href: expect.stringMatching(/^\/seller\/products\//) },
          { title: "Desk Lamp Aria · Black", detail: "6 left · about 6 days", badge: { label: "Low", tone: "warning" }, href: expect.stringMatching(/^\/seller\/products\//) }
        ]
      }
    ]);
    // Kept with the answer as it was, and shown again when the chat is reopened.
    const view = await seller.browser.get(`${CHATS}/${chat}`);
    expect(view.body.messages.at(-1).cards.tables).toEqual(cards.tables);

    // A lookup's table the answer doesn't mark isn't sent.
    h.claude.reply(lookup(toolUse("stock_forecast", {})), answer("Restock the white lamp first."));
    const plain = await ask(seller.browser, chat, "Which first?");
    expect(plain.events.find((e) => e.type === "cards")).toBeUndefined();
  });

  it("payouts show the store's own money as Seller Center does, without the account owner's name or number", async () => {
    const page = (await seller.browser.get("/api/v1/seller/payouts")).body as { available: { centavos: number }; waiting: { centavos: number; orders: number } };
    h.claude.reply(lookup(toolUse("payouts", {})), (req) => {
      const r = resultJson(toolResults(req)[0]!);
      expect(r).toMatchObject({ available_now: formatPeso(page.available.centavos), waiting: { amount: formatPeso(page.waiting.centavos), orders: page.waiting.orders }, payout_account: { method: "GCASH" } });
      expectNoPersonalData(JSON.stringify(r));
      return answer("Nothing to pay out yet.");
    });
    await ask(seller.browser, chat, "When do I get paid?");
  });

  it("reviews and store visits: ratings, the lowest-rated products and visits per day, with no reviewer named", async () => {
    const shop = shopping(h);
    const reviewer = await shop.shopper(BUYERS[0]);
    const order = await shop.order(reviewer, [["AI-MUG-BLU", 1]]);
    await shop.deliver(order.id);
    const item = (await reviewer.browser.get(`/api/v1/orders/${order.id}`)).body.order.packages[0].items[0].id as string;
    expect((await reviewer.browser.post("/api/v1/reviews", { orderItemId: item, rating: 2, title: "Chipped", body: "Arrived chipped on the rim." })).status).toBe(201);
    for (const ip of ["198.51.100.1", "198.51.100.2", "198.51.100.3"]) await h.visits().record(seller.store.id, { ip, userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/130" });

    h.claude.reply(lookup(toolUse("reviews", { period: "last_7_days" }), toolUse("store_visits", { period: "today" })), (req) => {
      const [reviews, visits] = toolResults(req).map((r) => resultJson(r));
      expect(reviews).toMatchObject({ new_reviews: { count: 1, average: 2, stars: { "2_stars": 1 } }, lowest_rated_products: [{ title: "Ceramic Mug Bay", average: 2, reviews: 1 }] });
      expect(JSON.stringify(reviews)).toContain("Arrived chipped on the rim.");
      expect(visits).toMatchObject({ visits: 3, orders: 3, orders_per_100_visits: 100 });
      expectNoPersonalData(JSON.stringify(toolResults(req)));
      return answer("One new review: 2 stars for the mug.");
    });
    await ask(seller.browser, chat, "Any new reviews, and how many visitors today?");
  });
});

describe("periods", () => {
  it("are Philippine days and months, each with the period before it", () => {
    const now = new Date("2026-11-28T16:30:00.000Z"); // 12:30 AM on Sunday, Nov 29 in Manila
    expect(periodRange("today", now)).toMatchObject({ from: new Date("2026-11-28T16:00:00.000Z"), to: now, previousFrom: new Date("2026-11-27T16:00:00.000Z"), days: 1 });
    expect(periodRange("last_7_days", now)).toMatchObject({ label: "Last 7 days (Nov 23 – Nov 29)", from: new Date("2026-11-22T16:00:00.000Z"), previousFrom: new Date("2026-11-15T16:00:00.000Z"), previousTo: new Date("2026-11-22T16:00:00.000Z"), days: 7 });
    expect(periodRange("this_month", now)).toMatchObject({ from: new Date("2026-10-31T16:00:00.000Z"), previousFrom: new Date("2026-09-30T16:00:00.000Z"), previousTo: new Date("2026-10-28T16:30:00.000Z"), days: 29 });
    expect(periodRange("last_month", now)).toMatchObject({ label: "Last month (Oct 1 – Oct 31)", from: new Date("2026-09-30T16:00:00.000Z"), to: new Date("2026-10-31T16:00:00.000Z"), days: 31 });
    expect(periodRange("yesterday", now)).toMatchObject({ label: "Yesterday (Nov 28)", from: new Date("2026-11-27T16:00:00.000Z"), to: new Date("2026-11-28T16:00:00.000Z") });
  });
});
