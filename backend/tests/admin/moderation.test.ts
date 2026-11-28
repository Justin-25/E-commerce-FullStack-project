import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { admins } from "../support/admins.js";
import type { Browser } from "../support/browser.js";
import { createCatalogHarness, type CatalogHarness } from "../support/catalogHarness.js";
import { sellers } from "../support/sellers.js";
import { shopping } from "../support/shopping.js";

let h: CatalogHarness;
let sell: ReturnType<typeof sellers>;
let shop: ReturnType<typeof shopping>;
let adm: ReturnType<typeof admins>;
beforeAll(async () => {
  h = await createCatalogHarness();
  sell = sellers(h);
  shop = shopping(h);
  adm = admins(h);
}, 120_000);
beforeEach(() => {
  h.clock.offsetMs = 0;
});
afterAll(() => h?.close());

const A = "/api/v1/admin";
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const mail = (to: string, kind: string) => h.outbox.sent.filter((m) => m.to === to && m.kind === kind);
const auditOf = (targetId: string) => h.db.prisma.auditLog.findMany({ where: { targetId }, orderBy: { createdAt: "asc" }, select: { action: true, actorId: true, metadata: true } });
const report = (b: Browser, productId: string, body: Record<string, unknown> = { reason: "COUNTERFEIT" }) => b.post(`/api/v1/products/${productId}/report`, body);
const productPage = (id: string) => request(h.app).get(`/api/v1/products/${id}`);
const storeOf = (id: string) => h.db.prisma.store.findUniqueOrThrow({ where: { id } });

/** An approved seller with `n` published products. */
async function liveSeller(n = 1, name = "Ana Reyes") {
  const seller = await sell.seller({ approve: true, name });
  const products = [];
  for (let i = 0; i < n; i++) {
    products.push(await sell.publish(seller.browser, { title: `Listing ${i + 1} ${randomUUID().slice(0, 6)}`, variants: [{ name: "Blue", sku: `SKU-${randomUUID().slice(0, 8)}`, priceCentavos: 50_000, stock: 20 }] }));
  }
  return { ...seller, products };
}
const moderator = (name = "Mo Moderator") => adm.admin(["MODERATION"], { name });

describe("Report this listing", () => {
  it("any signed-in shopper, with a reason from the form and maybe their own order; once per listing; never their own", async () => {
    const seller = await liveSeller();
    const [p] = seller.products;
    const pid = p?.id ?? "";
    expect((await (await h.browser()).post(`/api/v1/products/${pid}/report`, { reason: "COUNTERFEIT" })).status).toBe(401); // signed out
    const s = await shop.shopper();
    expect((await report(s.browser, pid, { reason: "I don't like it" })).status).toBe(400);
    expect((await report(s.browser, pid, { reason: "OTHER", message: "x".repeat(1001) })).status).toBe(400);
    const res = await report(s.browser, pid, { reason: "COUNTERFEIT", message: "The logo is printed wrong and the box says a different brand." });
    expect([res.status, res.body]).toEqual([201, { reported: true }]);
    const again = await report(s.browser, pid, { reason: "MISLEADING" });
    expect([again.status, again.body.error?.details?.reason]).toEqual([409, "already_reported"]);
    const own = await report(seller.browser, pid);
    expect([own.status, own.body.error?.details?.reason]).toEqual([409, "own_listing"]);

    // A buyer attaches their order; someone else's order is refused; two at the same moment make one report.
    const buyer = await shop.shopper();
    const sku = p?.variants[0]?.sku ?? "";
    const order = await shop.order(buyer, [[sku, 1]]);
    const someoneElse = await shop.order(await shop.shopper(), [[sku, 1]]);
    const wrong = await report(buyer.browser, pid, { reason: "COUNTERFEIT", orderId: someoneElse.id });
    expect([wrong.status, wrong.body.error?.fields?.[0]?.path]).toEqual([400, "orderId"]);
    const [x, y] = await Promise.all([report(buyer.browser, pid, { reason: "COUNTERFEIT", orderId: order.id }), report(buyer.browser, pid, { reason: "COUNTERFEIT", orderId: order.id })]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect(await h.db.prisma.productFlag.count({ where: { productId: pid, reporterId: buyer.user.id } })).toBe(1);
    expect((await h.db.prisma.productFlag.findFirstOrThrow({ where: { productId: pid, reporterId: buyer.user.id } })).orderId).toBe(order.id);

    const draft = await h.db.prisma.product.create({ data: { storeId: seller.store.id, categoryId: (await h.db.prisma.category.findFirstOrThrow({ where: { parentId: { not: null } } })).id, title: "Draft", slug: `draft-${randomUUID().slice(0, 6)}`, description: "d" } });
    expect((await report(s.browser, draft.id)).status).toBe(404); // shoppers can't see it
  });

  it("at most 10 reports a day per shopper", async () => {
    const listings = await h.db.prisma.product.findMany({ where: { status: "ACTIVE", store: { status: "APPROVED" } }, take: 11, orderBy: { id: "asc" }, select: { id: true } });
    const s = await shop.shopper();
    for (const l of listings.slice(0, 10)) expect((await report(s.browser, l.id, { reason: "OTHER" })).status).toBe(201);
    const eleventh = await report(s.browser, listings[10]?.id ?? "", { reason: "OTHER" });
    expect([eleventh.status, eleventh.body.error?.details?.reason]).toEqual([429, "too_many_reports"]);
    h.clock.offsetMs = DAY + MINUTE; // tomorrow
    expect((await report(s.browser, listings[10]?.id ?? "", { reason: "OTHER" })).status).toBe(201);
    await h.db.prisma.productFlag.updateMany({ where: { reporterId: s.user.id }, data: { status: "KEPT", resolvedAt: new Date() } }); // leave the shared queue as it was
  });
});

describe("Moderation queue and a listing's page", () => {
  it("is Moderation's: listings with the most reports first, with reasons and how many come from buyers; then everything about one listing", async () => {
    const seller = await liveSeller(2);
    const [busy, quiet] = seller.products;
    const buyer = await shop.shopper("Maria Santos");
    const order = await shop.order(buyer, [[busy?.variants[0]?.sku ?? "", 1]]);
    const fromBuyer0 = await report(buyer.browser, busy?.id ?? "", { reason: "COUNTERFEIT", message: "Not the watch in the photos.", orderId: order.id });
    expect(fromBuyer0.status, JSON.stringify(fromBuyer0.body)).toBe(201);
    for (const reason of ["COUNTERFEIT", "MISLEADING"]) await report((await shop.shopper()).browser, busy?.id ?? "", { reason });
    await report((await shop.shopper()).browser, quiet?.id ?? "", { reason: "OFFENSIVE" });

    const support = await adm.admin(["SUPPORT"]);
    expect((await support.browser.get(`${A}/moderation`)).body.error?.details?.role).toBe("MODERATION");
    const mod = await moderator();
    const res = await mod.browser.get(`${A}/moderation?q=${encodeURIComponent(seller.store.name)}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { product: { id: string } }) => i.product.id)).toEqual([busy?.id, quiet?.id]);
    expect(res.body.items[0]).toMatchObject({ reports: 3, fromBuyers: 1, store: { name: seller.store.name }, reasons: [{ reason: "COUNTERFEIT", count: 2, label: "Counterfeit or fake" }, { reason: "MISLEADING", count: 1 }] });
    expect(res.body.counts.open).toBeGreaterThanOrEqual(2);

    const page = await mod.browser.get(`${A}/moderation/${busy?.id}`);
    expect(page.body.listing).toMatchObject({ product: { id: busy?.id, status: "ACTIVE", removed: null }, store: { warningsIn90Days: 0 }, openReports: 3, canKeep: true, canRemove: true, canRestore: false });
    const fromBuyer = page.body.listing.reports.find((r: { order: string | null }) => r.order);
    expect(fromBuyer).toMatchObject({ reporter: "Maria S.", order: `VD-${order.number.replace("VD-", "")}`, message: "Not the watch in the photos.", status: "OPEN" });
    expect(JSON.stringify(page.body)).not.toContain(buyer.user.email); // reporters stay private
    expect((await mod.browser.get(`${A}/moderation?tab=resolved&q=${encodeURIComponent(seller.store.name)}`)).body.items).toEqual([]);
  });
});

describe("Keep, remove, restore", () => {
  it("Keep closes the open reports (audited); with a warning the seller is emailed; nothing open → 409", async () => {
    const seller = await liveSeller();
    const pid = seller.products[0]?.id ?? "";
    await report((await shop.shopper()).browser, pid);
    const mod = await moderator();
    const res = await mod.browser.post(`${A}/moderation/${pid}/keep`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.listing).toMatchObject({ openReports: 0, canKeep: false, reports: [{ status: "KEPT", decidedBy: "Mo Moderator" }] });
    expect((await productPage(pid)).status).toBe(200); // still for sale
    expect((await auditOf(pid)).map((r) => [r.action, r.actorId])).toEqual([["product.keep", mod.user.id]]);
    expect((await mod.browser.post(`${A}/moderation/${pid}/keep`, {})).body.error?.details?.reason).toBe("nothing_open");

    await report((await shop.shopper()).browser, pid, { reason: "MISSING_PERMIT" });
    expect((await mod.browser.post(`${A}/moderation/${pid}/keep`, { warning: "short" })).status).toBe(400);
    await mod.browser.post(`${A}/moderation/${pid}/keep`, { warning: "Add the FDA registration number to the description." });
    expect((await storeOf(seller.store.id)).warningCount).toBe(1);
    expect(mail(seller.user.email, "seller-warned").at(-1)?.text).toContain("This counts as a warning (1 in the last 90 days)");
    expect((await h.db.prisma.productFlag.findFirstOrThrow({ where: { productId: pid, reason: "MISSING_PERMIT" } })).resolutionNote).toBe("Add the FDA registration number to the description.");
  });

  it("Remove hides it; the seller sees why and can't change it; orders already placed stay; two moderators at once: one removes", async () => {
    const seller = await liveSeller(2);
    const [p, other] = seller.products;
    const pid = p?.id ?? "";
    const buyer = await shop.shopper();
    const order = await shop.order(buyer, [[p?.variants[0]?.sku ?? "", 1]]);
    await report(buyer.browser, pid, { reason: "COUNTERFEIT", orderId: order.id });
    const mod = await moderator();
    expect((await mod.browser.post(`${A}/moderation/${pid}/remove`, { reason: "fake" })).status).toBe(400);
    const res = await mod.browser.post(`${A}/moderation/${pid}/remove`, { reason: "Counterfeit: the brand owner confirmed it isn't theirs." });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.listing).toMatchObject({ product: { status: "REMOVED", removed: { reason: "Counterfeit: the brand owner confirmed it isn't theirs.", by: "Mo Moderator" } }, openReports: 0, canRestore: true });
    expect((await productPage(pid)).status).toBe(404);
    const mine = (await seller.browser.get(`/api/v1/seller/products/${pid}`)).body.product;
    expect(mine).toMatchObject({ status: "removed", removal: { reason: "Counterfeit: the brand owner confirmed it isn't theirs." } });
    const edit = await seller.browser.put(`/api/v1/seller/products/${pid}`, sell.editForm(p as never, { title: "Renamed to get around it" }));
    expect(edit.body.error?.details?.reason).toBe("removed_by_vendora");
    expect((await buyer.browser.get(`/api/v1/orders/${order.id}`)).body.order.packages[0].items[0].title).toBe(p?.title); // the order is untouched
    expect(mail(seller.user.email, "listing-removed").at(-1)?.text).toContain("Why: Counterfeit: the brand owner confirmed it isn't theirs.");
    expect((await storeOf(seller.store.id)).warningCount).toBe(0); // no warning asked for
    expect((await mod.browser.post(`${A}/moderation/${pid}/remove`, { reason: "Counterfeit, removing again." })).body.error?.details?.reason).toBe("already_removed");

    const second = await moderator("Second Moderator");
    const [a, b] = await Promise.all([
      mod.browser.post(`${A}/moderation/${other?.id}/remove`, { reason: "Prohibited: a replica of a branded item." }),
      second.browser.post(`${A}/moderation/${other?.id}/remove`, { reason: "Prohibited: a replica of a branded item." })
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await auditOf(other?.id ?? "")).filter((r) => r.action === "product.remove")).toHaveLength(1);
    const log = await mod.browser.get(`${A}/audit?area=listings&target=${pid}`);
    expect(log.body.items.map((r: { summary: string }) => r.summary)).toEqual([`Removed listing "${p?.title}" (${seller.store.name})`]);
  });

  it("Restore brings it back inactive; withdrawing its warning ends a 7-day suspension it caused; only removed listings", async () => {
    const seller = await liveSeller(2);
    const [p1, p2] = seller.products;
    const mod = await moderator();
    for (const p of [p1, p2]) await mod.browser.post(`${A}/moderation/${p?.id}/remove`, { reason: "Counterfeit listing (brand confirmed).", warn: true });
    expect((await storeOf(seller.store.id)).status).toBe("SUSPENDED");

    const notRemoved = await liveSeller();
    expect((await mod.browser.post(`${A}/moderation/${notRemoved.products[0]?.id}/restore`, {})).body.error?.details?.reason).toBe("not_removed");
    const res = await mod.browser.post(`${A}/moderation/${p2?.id}/restore`, { withdrawWarning: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.listing).toMatchObject({ product: { status: "ARCHIVED", removed: null }, store: { status: "APPROVED", warningsIn90Days: 1 } });
    expect((await seller.browser.get(`/api/v1/seller/products/${p2?.id}`)).body.product).toMatchObject({ status: "inactive", removal: null });
    expect((await storeOf(seller.store.id))).toMatchObject({ status: "APPROVED", warningCount: 1, suspendedCause: null });
    expect(mail(seller.user.email, "listing-restored").at(-1)?.text).toContain("Your store is live again.");
    expect((await auditOf(seller.store.id)).map((r) => r.action).slice(-1)).toEqual(["store.reactivate"]);

    await mod.browser.post(`${A}/moderation/${p1?.id}/restore`, {}); // its warning stays
    expect((await storeOf(seller.store.id)).warningCount).toBe(1);
  });
});

describe("Warnings", () => {
  it("a second warning within 90 days suspends the store for 7 days at once; the job ends it; an older warning doesn't count", async () => {
    const seller = await liveSeller(2);
    const [p1, p2] = seller.products;
    const mod = await moderator();
    await mod.browser.post(`${A}/moderation/${p1?.id}/remove`, { reason: "Misleading photos (not the item sold).", warn: true });
    expect((await storeOf(seller.store.id)).status).toBe("APPROVED");
    expect(mail(seller.user.email, "listing-removed").at(-1)?.text).toContain("This counts as a warning (1 in the last 90 days)");

    await mod.browser.post(`${A}/moderation/${p2?.id}/remove`, { reason: "Counterfeit listing (brand confirmed).", warn: true });
    const s = await storeOf(seller.store.id);
    expect(s).toMatchObject({ status: "SUSPENDED", suspendedCause: "WARNINGS", warningCount: 2 });
    expect((s.suspendedUntil?.getTime() ?? 0) - Date.now()).toBeGreaterThan(7 * DAY - MINUTE);
    expect((await request(h.app).get(`/api/v1/stores/${seller.store.slug}`)).status).toBe(404);
    expect((await seller.browser.get("/api/v1/seller/store")).body.store.suspension).toMatchObject({ reason: "A second warning within 90 days: suspended for 7 days." });
    expect(mail(seller.user.email, "listing-removed").at(-1)?.text).toContain("This is your second warning within 90 days, so your store is suspended until");
    expect((await auditOf(seller.store.id)).filter((r) => r.action === "store.suspend").map((r) => r.metadata)).toEqual([expect.objectContaining({ cause: "WARNINGS" })]);

    h.clock.offsetMs = 7 * DAY - MINUTE;
    expect(await h.moderation().liftEndedSuspensions()).toBe(0); // not yet
    h.clock.offsetMs = 7 * DAY + MINUTE;
    const [first, again] = await Promise.all([h.moderation().liftEndedSuspensions(), h.moderation().liftEndedSuspensions()]);
    expect(first + again).toBe(1); // two runs at once: once
    expect(await storeOf(seller.store.id)).toMatchObject({ status: "APPROVED", suspendedCause: null, suspendedUntil: null });
    expect(mail(seller.user.email, "store-reactivated")).toHaveLength(1);
    expect((await auditOf(seller.store.id)).filter((r) => r.action === "store.reactivate").map((r) => [r.actorId, r.metadata])).toEqual([[null, { cause: "WARNINGS", via: "automatic" }]]);

    // A warning older than 90 days doesn't count toward the next suspension.
    h.clock.offsetMs = 0;
    const older = await liveSeller();
    await h.db.prisma.storeWarning.create({ data: { storeId: older.store.id, reason: "An old warning.", createdAt: new Date(Date.now() - 91 * DAY) } });
    await mod.browser.post(`${A}/moderation/${older.products[0]?.id}/remove`, { reason: "Misleading photos (not the item sold).", warn: true });
    expect((await storeOf(older.store.id)).status).toBe("APPROVED");
  });

  it("Support can lift it early; a store Support already suspended keeps that suspension; two warnings at the same moment still suspend once", async () => {
    const seller = await liveSeller(2);
    const mod = await moderator();
    for (const p of seller.products) await mod.browser.post(`${A}/moderation/${p.id}/remove`, { reason: "Counterfeit listing (brand confirmed).", warn: true });
    const support = await adm.admin(["SUPPORT"]);
    await adm.confirm(support);
    const early = await support.browser.post(`${A}/stores/${seller.store.id}/reactivate`);
    expect(early.body.store).toMatchObject({ status: "APPROVED", suspension: null });

    const held = await liveSeller(2);
    await support.browser.post(`${A}/stores/${held.store.id}/suspend`, { reason: "Under investigation for fraud." });
    for (const p of held.products) await mod.browser.post(`${A}/moderation/${p.id}/remove`, { reason: "Counterfeit listing (brand confirmed).", warn: true });
    expect(await storeOf(held.store.id)).toMatchObject({ status: "SUSPENDED", suspendedCause: "ADMIN", suspendedUntil: null });

    const racing = await liveSeller(2);
    const other = await moderator("Second Moderator");
    const [p1, p2] = racing.products;
    await Promise.all([
      mod.browser.post(`${A}/moderation/${p1?.id}/remove`, { reason: "Counterfeit listing (brand confirmed).", warn: true }),
      other.browser.post(`${A}/moderation/${p2?.id}/remove`, { reason: "Counterfeit listing (brand confirmed).", warn: true })
    ]);
    expect(await storeOf(racing.store.id)).toMatchObject({ status: "SUSPENDED", suspendedCause: "WARNINGS", warningCount: 2 });
    expect((await auditOf(racing.store.id)).filter((r) => r.action === "store.suspend")).toHaveLength(1);
  });
});
