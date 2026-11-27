import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DevOutbox } from "../../src/lib/email.js";
import { StoreAdminService } from "../../src/modules/admin/stores.service.js";
import { testConfig } from "../helpers.js";
import { admins } from "../support/admins.js";
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
const mail = (to: string, kind: string) => h.outbox.sent.filter((m) => m.to === to && m.kind === kind);
const auditOf = (targetId: string) => h.db.prisma.auditLog.findMany({ where: { targetId }, orderBy: { createdAt: "asc" }, select: { action: true, actorId: true, metadata: true } });
const storePage = (slug: string) => request(h.app).get(`/api/v1/stores/${slug}`);
async function support(name = "Sam Support") {
  const s = await adm.admin(["SUPPORT"], { name });
  await adm.confirm(s);
  return s;
}
/** An approved seller with one published product (stock 20). */
async function liveSeller(name = "Ana Reyes") {
  const seller = await sell.seller({ approve: true, name });
  const product = await sell.publish(seller.browser, { variants: [{ name: "Blue", sku: `SKU-${randomUUID().slice(0, 8)}`, priceCentavos: 50_000, stock: 20 }] });
  return { ...seller, product, sku: product.variants[0]?.sku ?? "" };
}

describe("Stores list and page", () => {
  it("are Support's: live and suspended stores (applications stay on Seller approvals), tabs with counts, search", async () => {
    const fin = await adm.admin(["FINANCE"]);
    const refused = await fin.browser.get(`${A}/stores`);
    expect([refused.status, refused.body.error?.details?.role]).toEqual([403, "SUPPORT"]);
    const live = await liveSeller();
    const pending = await sell.seller();
    const s = await adm.admin(["SUPPORT"]);
    const res = await s.browser.get(`${A}/stores?q=${encodeURIComponent(live.user.email)}`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ id: live.store.id, name: live.store.name, status: "APPROVED", products: 1, owner: { email: live.user.email }, category: "Electronics" });
    expect(res.body.counts.live).toBeGreaterThanOrEqual(8); // the 7 demo stores and this one
    expect((await s.browser.get(`${A}/stores?q=${encodeURIComponent(pending.user.email)}`)).body.items).toEqual([]);
    expect((await s.browser.get(`${A}/stores?q=soundcraft`)).body.items.map((x: { slug: string }) => x.slug)).toEqual(["soundcraft-audio"]);
    expect((await s.browser.get(`${A}/stores?tab=suspended&q=${encodeURIComponent(live.user.email)}`)).body.items).toEqual([]);

    const page = await s.browser.get(`${A}/stores/${live.store.id}`);
    expect(page.body.store).toMatchObject({ status: "APPROVED", owner: { id: live.user.id, status: "ACTIVE" }, products: 1, orders: 0, payoutAccount: { method: "GCASH", last4: "4567", verified: true }, previousAddresses: [], canSuspend: true, canReactivate: false, suspension: null });
    expect((await s.browser.get(`${A}/stores/${pending.store.id}`)).status).toBe(404);
    expect((await s.browser.get(`${A}/stores?tab=nope`)).status).toBe(400);
  });
});

describe("Suspend and reactivate a store", () => {
  it('"Confirm it\'s you" and a reason; hidden from shoppers; the seller sees why, can\'t change products, still ships paid orders, can\'t be paid out', async () => {
    const seller = await liveSeller();
    const buyer = await shop.shopper();
    const order = await shop.order(buyer, [[seller.sku, 1]]); // cash on delivery: to ship
    const s = await adm.admin(["SUPPORT"], { name: "Sam Support" });
    const path = `${A}/stores/${seller.store.id}/suspend`;
    expect((await s.browser.post(path, { reason: "spam" })).status).toBe(400);
    const unconfirmed = await s.browser.post(path, { reason: "Counterfeit listings reported by 3 buyers." });
    expect([unconfirmed.status, unconfirmed.body.error?.code]).toEqual([403, "REAUTH_REQUIRED"]);
    await adm.confirm(s);
    const res = await s.browser.post(path, { reason: "Counterfeit listings reported by 3 buyers." });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.store).toMatchObject({ status: "SUSPENDED", suspension: { cause: "ADMIN", reason: "Counterfeit listings reported by 3 buyers." }, canSuspend: false, canReactivate: true });
    expect((await storePage(seller.store.slug)).status).toBe(404);
    expect((await seller.browser.get("/api/v1/seller/store")).body.store.suspension).toMatchObject({ reason: "Counterfeit listings reported by 3 buyers." });
    const edit = await seller.browser.put(`/api/v1/seller/products/${seller.product.id}`, sell.editForm(seller.product, { title: "A new title" }));
    expect([edit.status, edit.body.error?.details?.reason]).toEqual([403, "store_suspended"]);
    const pkg = order.packages[0]?.id ?? "";
    expect((await seller.browser.put(`/api/v1/seller/orders/${pkg}/shipment`, { courier: "LBC", trackingNumber: `LBC${randomUUID().replace(/-/g, "").slice(0, 12)}` })).status).toBe(200);
    expect((await seller.browser.post("/api/v1/seller/payouts")).body.error?.details?.reason).toBe("store_suspended"); // no payouts while suspended
    expect(mail(seller.user.email, "store-suspended").at(-1)?.text).toContain("Why: Counterfeit listings reported by 3 buyers.");
    expect((await auditOf(seller.store.id)).filter((r) => r.action === "store.suspend").map((r) => [r.actorId, r.metadata])).toEqual([[s.user.id, { reason: "Counterfeit listings reported by 3 buyers." }]]);
    expect((await s.browser.post(path, { reason: "Counterfeit listings reported by 3 buyers." })).body.error?.details?.reason).toBe("not_live");

    const fresh = await adm.admin(["SUPPORT"]);
    expect((await fresh.browser.post(`${A}/stores/${seller.store.id}/reactivate`)).body.error?.code).toBe("REAUTH_REQUIRED");
    const back = await s.browser.post(`${A}/stores/${seller.store.id}/reactivate`);
    expect(back.body.store).toMatchObject({ status: "APPROVED", suspension: null });
    expect((await storePage(seller.store.slug)).status).toBe(200);
    expect((await seller.browser.get("/api/v1/seller/store")).body.store.suspension).toBeNull();
    expect(mail(seller.user.email, "store-reactivated")).toHaveLength(1);
    expect((await s.browser.post(`${A}/stores/${seller.store.id}/reactivate`)).body.error?.details?.reason).toBe("not_suspended");
  });

  it("a store that went down with its owner's account comes back only with the account; two admins at once: one suspends (forced)", async () => {
    const seller = await liveSeller();
    const s = await support();
    await s.browser.post(`${A}/users/${seller.user.id}/suspend`, { reason: "Account under investigation for fraud." });
    const refused = await s.browser.post(`${A}/stores/${seller.store.id}/reactivate`);
    expect([refused.status, refused.body.error?.details?.reason]).toEqual([409, "suspended_with_account"]);
    expect((await s.browser.get(`${A}/stores/${seller.store.id}`)).body.store).toMatchObject({ suspension: { cause: "ACCOUNT" }, canReactivate: false });

    const other = await liveSeller();
    const one = await adm.admin(["SUPPORT"]);
    const two = await adm.admin(["SUPPORT"]);
    const service = new StoreAdminService({ prisma: h.db.prisma, email: new DevOutbox(), config: testConfig() });
    const ensureConfirmed = async () => {
      await service.suspend(two.user.id, other.store.id, "Suspended by the other admin first.", { ensureConfirmed: async () => undefined, ip: null });
    };
    await expect(service.suspend(one.user.id, other.store.id, "Suspended by this admin second.", { ensureConfirmed, ip: null })).rejects.toMatchObject({ status: 409, details: { reason: "not_live" } });
    expect((await h.db.prisma.store.findUniqueOrThrow({ where: { id: other.store.id } })).suspendedReason).toBe("Suspended by the other admin first.");
    expect((await auditOf(other.store.id)).filter((r) => r.action === "store.suspend")).toHaveLength(1);
  });
});

describe("Rename a store", () => {
  it("uses the sellers' name rules; the old address redirects forever and stays reserved; renaming back takes it back", async () => {
    const seller = await liveSeller();
    const oldSlug = seller.store.slug;
    const s = await support();
    const path = `${A}/stores/${seller.store.id}/rename`;
    expect((await s.browser.post(path, { name: "x" })).status).toBe(400);
    expect((await s.browser.post(path, { name: "Vendora Deals" })).body.error?.details?.reason).toBe("name_reserved");
    expect((await s.browser.post(path, { name: "SoundCraft Audio" })).body.error?.details?.reason).toBe("name_taken");
    expect((await s.browser.post(path, { name: seller.store.name })).body.error?.details?.reason).toBe("same_name");
    const unconfirmed = await (await adm.admin(["SUPPORT"])).browser.post(path, { name: `Fresh Name ${randomUUID().slice(0, 6)}` });
    expect([unconfirmed.status, unconfirmed.body.error?.code]).toEqual([403, "REAUTH_REQUIRED"]);

    const newName = `Kalye Sound ${randomUUID().slice(0, 6)}`;
    const res = await s.browser.post(path, { name: newName });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const newSlug = res.body.store.slug as string;
    expect(res.body.store).toMatchObject({ name: newName, previousAddresses: [{ slug: oldSlug }] });
    const moved = await storePage(oldSlug);
    expect([moved.status, moved.headers.location]).toEqual([301, `/api/v1/stores/${newSlug}`]);
    expect((await storePage(newSlug)).body.store.name).toBe(newName);
    expect(mail(seller.user.email, "store-renamed").at(-1)?.text).toContain(`/stores/${newSlug}; links to the old one still lead there`);
    const log = (await auditOf(seller.store.id)).filter((r) => r.action === "store.rename");
    expect(log[0]?.metadata).toEqual({ from: { name: seller.store.name, slug: oldSlug }, to: { name: newName, slug: newSlug } });

    // The old name stays reserved: not for a new seller, not for another store's rename.
    const newcomer = await h.signUp({ email: `newcomer-${randomUUID().slice(0, 8)}@example.com`, name: "Nico Newcomer" });
    await h.enableTwoFactor(newcomer.browser);
    const claim = await newcomer.browser.put("/api/v1/seller/store", { name: seller.store.name, category: "electronics", shipsFrom: "Manila" });
    expect([claim.status, claim.body.error?.details?.reason]).toEqual([409, "name_taken"]);
    const otherStore = await liveSeller();
    expect((await s.browser.post(`${A}/stores/${otherStore.store.id}/rename`, { name: seller.store.name })).body.error?.details?.reason).toBe("name_taken");

    // Renaming back takes the old name back; the middle name now redirects; a spelling change keeps the address.
    const again = await s.browser.post(path, { name: seller.store.name });
    expect(again.body.store).toMatchObject({ slug: oldSlug, previousAddresses: [{ slug: newSlug }] });
    expect((await storePage(oldSlug)).status).toBe(200);
    expect((await storePage(newSlug)).headers.location).toBe(`/api/v1/stores/${oldSlug}`);
    const respelled = await s.browser.post(path, { name: seller.store.name.toUpperCase() });
    expect(respelled.body.store).toMatchObject({ slug: oldSlug, name: seller.store.name.toUpperCase(), previousAddresses: [{ slug: newSlug }] });
  });
});

describe("Audit log", () => {
  it("is for every admin: newest first, in plain words, with filters by area, admin, record and date", async () => {
    const seller = await liveSeller();
    const s = await adm.admin(["SUPPORT"], { name: "Aud Support" });
    await adm.confirm(s);
    await s.browser.post(`${A}/stores/${seller.store.id}/suspend`, { reason: "Counterfeit listings reported by 3 buyers." });
    const renamed = `Audit Shop ${randomUUID().slice(0, 6)}`;
    await s.browser.post(`${A}/stores/${seller.store.id}/rename`, { name: renamed });

    const shopper = await shop.shopper();
    expect((await shopper.browser.get(`${A}/audit`)).status).toBe(403);
    const mod = await adm.admin(["MODERATION"]); // any admin role
    const res = await mod.browser.get(`${A}/audit?target=${seller.store.id}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((r: { summary: string }) => r.summary)).toEqual([
      `Renamed store ${seller.store.name} to ${renamed}`,
      `Suspended store ${renamed}`,
      `Approved store ${renamed}`
    ]);
    expect(res.body.items[0]).toMatchObject({ action: "store.rename", actor: { id: s.user.id, name: "Aud Support" }, target: { type: "store", id: seller.store.id, label: renamed } });
    expect(res.body.items[2].actor).toBeNull(); // approved by the command on the server
    expect(res.body.admins.map((a: { id: string }) => a.id)).toEqual(expect.arrayContaining([s.user.id, mod.user.id]));

    const byActor = await mod.browser.get(`${A}/audit?actor=${s.user.id}`);
    expect(byActor.body.items.every((r: { actor: { id: string } }) => r.actor.id === s.user.id)).toBe(true);
    expect(byActor.body.items).toHaveLength(2);
    const stores = await mod.browser.get(`${A}/audit?area=stores&target=${seller.store.id}`);
    expect(stores.body.totalItems).toBe(3);
    expect((await mod.browser.get(`${A}/audit?area=payouts&target=${seller.store.id}`)).body.totalItems).toBe(0);
    const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 32 * 3_600_000).toISOString().slice(0, 10);
    expect((await mod.browser.get(`${A}/audit?target=${seller.store.id}&from=${today}&to=${today}`)).body.totalItems).toBe(3);
    expect((await mod.browser.get(`${A}/audit?target=${seller.store.id}&from=${tomorrow}`)).body.totalItems).toBe(0);
    expect((await mod.browser.get(`${A}/audit?from=${tomorrow}&to=${today}`)).status).toBe(400);
    expect((await mod.browser.get(`${A}/audit?area=nope`)).status).toBe(400);
  });
});
