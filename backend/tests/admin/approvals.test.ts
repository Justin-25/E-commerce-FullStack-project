import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DevOutbox } from "../../src/lib/email.js";
import { adminUser } from "../../src/modules/admin/access.js";
import { makeAdmin, parseRoles, removeAdmin } from "../../src/modules/admin/accounts.js";
import { ApplicationService } from "../../src/modules/admin/applications.service.js";
import { manilaMonth, manilaMonthStart } from "../../src/modules/orders/deadlines.js";
import { approveStore } from "../../src/modules/seller/approval.js";
import { admins } from "../support/admins.js";
import { totpCode } from "../support/authHarness.js";
import { createCatalogHarness, type CatalogHarness } from "../support/catalogHarness.js";
import { sellers } from "../support/sellers.js";
import { shopping } from "../support/shopping.js";
import { testConfig } from "../helpers.js";

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
const auditOf = (targetId: string) => h.db.prisma.auditLog.findMany({ where: { targetId }, orderBy: { createdAt: "asc" }, select: { action: true, actorId: true, ipAddress: true, metadata: true } });
type Application = {
  status: string;
  business: { tinMasked: string | null };
  documents: { id: string; type: string }[];
  payoutAccount: { last4: string; verified: boolean } | null;
  checks: { key: string; passed: boolean }[];
  review: { by: string | null; note: string | null } | null;
  canReview: boolean;
  history: { action: string; by: string }[];
};

describe("Admin access", () => {
  it("only admins with two-step verification; seller applications need the Support role; every admin sees the dashboard", async () => {
    expect((await request(h.app).get(`${A}/dashboard`)).status).toBe(401);
    const shopper = await shop.shopper();
    for (const path of [`${A}/dashboard`, `${A}/applications`, `${A}/payout-accounts`]) {
      const res = await shopper.browser.get(path);
      expect([res.status, res.body.error?.details?.reason]).toEqual([403, "not_an_admin"]);
    }
    const noTwoFactor = await adm.admin(["SUPPORT"], { twoFactor: false });
    expect((await noTwoFactor.browser.get(`${A}/applications`)).body.error?.details?.reason).toBe("two_factor_required");
    // A suspended admin is refused by the admin check itself, whatever happened to their sessions.
    const suspended = await adm.admin(["SUPPORT"]);
    await h.db.prisma.user.update({ where: { id: suspended.user.id }, data: { status: "SUSPENDED" } });
    await expect(adminUser(h.db.prisma, suspended.user.id, "SUPPORT")).rejects.toMatchObject({ status: 403, details: { reason: "not_an_admin" } });

    const finance = await adm.admin(["FINANCE"]);
    const dash = await finance.browser.get(`${A}/dashboard`);
    expect(dash.status).toBe(200);
    expect(dash.body.admin.roles).toEqual(["FINANCE"]);
    const refused = await finance.browser.get(`${A}/applications`);
    expect([refused.status, refused.body.error?.details?.reason, refused.body.error?.details?.role]).toEqual([403, "missing_role", "SUPPORT"]);

    // Removing an admin works at once, in the same session, and signs them out everywhere.
    const support = await adm.admin(["SUPPORT"]);
    expect((await support.browser.get(`${A}/applications`)).status).toBe(200);
    expect(await removeAdmin(h.db.prisma, support.user.email)).toBe("removed");
    expect((await support.browser.get(`${A}/applications`)).body.error?.details?.reason).toBe("not_an_admin");
    expect(await h.db.prisma.session.count({ where: { userId: support.user.id, revokedAt: null } })).toBe(0);
  });

  it("admins are made only by a command: an existing verified account, never a seller's; roles can change", async () => {
    expect(parseRoles("support, Finance")).toEqual(["SUPPORT", "FINANCE"]);
    for (const bad of ["", "boss", "support,boss"]) expect(parseRoles(bad)).toBeNull();
    expect(await makeAdmin(h.db.prisma, "nobody@example.com", ["SUPPORT"])).toBe("not_found");
    const seller = await sell.seller();
    expect(await makeAdmin(h.db.prisma, seller.user.email, ["SUPPORT"])).toBe("is_seller");
    // Also while the store is only a draft (the account is still a customer until it's submitted).
    const drafting = await h.signUp({ email: `drafting-${randomUUID().slice(0, 8)}@example.com`, name: "Dino Draft" });
    await h.enableTwoFactor(drafting.browser);
    expect((await drafting.browser.put("/api/v1/seller/store", { name: `Dino Shop ${randomUUID().slice(0, 6)}`, category: "electronics", shipsFrom: "Manila" })).status).toBe(200);
    expect(await makeAdmin(h.db.prisma, drafting.user.email, ["SUPPORT"])).toBe("is_seller");
    expect((await h.db.prisma.user.findUniqueOrThrow({ where: { id: drafting.user.id } })).role).toBe("CUSTOMER");
    const unverified = await h.db.prisma.user.create({ data: { email: "unverified-admin@example.com", name: "Not Yet", passwordHash: "x" } });
    expect(await makeAdmin(h.db.prisma, unverified.email, ["SUPPORT"])).toBe("not_verified");
    const a = await adm.admin(["SUPPORT"]);
    expect(await makeAdmin(h.db.prisma, a.user.email, ["SUPPORT", "MODERATION"])).toBe("roles_changed");
    expect((await h.db.prisma.user.findUniqueOrThrow({ where: { id: a.user.id } })).adminRoles).toEqual(["SUPPORT", "MODERATION"]);
    expect((await auditOf(a.user.id)).map((r) => [r.action, r.actorId])).toEqual([
      ["admin.create", null],
      ["admin.change_roles", null]
    ]);
  });
});

describe("Seller applications", () => {
  it("the queue: waiting applications oldest first, with their checks; tabs and search", async () => {
    const first = await sell.seller({ name: "Rina dela Paz" });
    const second = await sell.seller({ name: "Kalye Kicks" });
    const support = await adm.admin();
    const res = await support.browser.get(`${A}/applications`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const mine = res.body.items.filter((i: { storeId: string }) => [first.store.id, second.store.id].includes(i.storeId));
    expect(mine.map((i: { storeId: string }) => i.storeId)).toEqual([first.store.id, second.store.id]);
    expect(mine[0]).toMatchObject({ name: first.store.name, businessType: "INDIVIDUAL", status: "PENDING", owner: { name: "Rina dela Paz" }, checks: { passed: 4, total: 4 } });
    expect(res.body.counts.pending).toBeGreaterThanOrEqual(2);
    expect(res.body.counts.approved).toBeGreaterThanOrEqual(7); // the demo stores

    const found = await support.browser.get(`${A}/applications?q=${encodeURIComponent(second.user.email)}`);
    expect(found.body.items.map((i: { storeId: string }) => i.storeId)).toEqual([second.store.id]);
    expect((await support.browser.get(`${A}/applications?tab=approved&q=soundcraft`)).body.items.map((i: { slug: string }) => i.slug)).toEqual(["soundcraft-audio"]);
    expect((await support.browser.get(`${A}/applications?tab=nope`)).status).toBe(400);
  });

  it("an application: the TIN masked; Show TIN and Open document are recorded in the audit log", async () => {
    const seller = await sell.seller();
    const support = await adm.admin();
    let app = (await support.browser.get(`${A}/applications/${seller.store.id}`)).body.application as Application;
    expect(app).toMatchObject({ status: "PENDING", business: { tinMasked: "•••-•••-•••-000" }, payoutAccount: { last4: "4567", verified: false }, canReview: true, review: null, history: [] });
    expect(app.checks.every((c) => c.passed)).toBe(true);
    expect(JSON.stringify(app)).not.toContain("123-456-789");

    const tin = await support.browser.post(`${A}/applications/${seller.store.id}/tin`);
    expect(tin.body).toEqual({ tin: "123-456-789-000" });
    const [doc] = app.documents;
    const file = await h.db.prisma.storeDocument.findUniqueOrThrow({ where: { id: doc?.id ?? "" } });
    const link = await support.browser.post(`${A}/applications/${seller.store.id}/documents/${doc?.id}/link`);
    expect(link.status).toBe(200);
    expect(link.body.url).toBe(`https://media.test/private/${file.fileKey}.pdf?expires_in=300`);
    expect(Date.parse(link.body.expiresAt) - Date.now()).toBeGreaterThan(290_000);

    const log = await auditOf(seller.store.id);
    expect(log.map((r) => [r.action, r.actorId])).toEqual([
      ["store.view_tin", support.user.id],
      ["store.view_document", support.user.id]
    ]);
    expect(log[1]?.metadata).toEqual({ documentId: doc?.id, type: "GOV_ID" });
    expect(log[0]?.ipAddress).toMatch(/127\.0\.0\.1/);
    app = (await support.browser.get(`${A}/applications/${seller.store.id}`)).body.application;
    expect(app.history.map((x) => [x.action, x.by])).toEqual([
      ["store.view_document", "Ops Admin"],
      ["store.view_tin", "Ops Admin"]
    ]);

    const other = await sell.seller();
    expect((await support.browser.post(`${A}/applications/${other.store.id}/documents/${doc?.id}/link`)).status).toBe(404); // not that store's
    const finance = await adm.admin(["FINANCE"]);
    expect((await finance.browser.post(`${A}/applications/${seller.store.id}/tin`)).status).toBe(403);

    // A draft (not submitted yet) isn't an application: admins can't open it or its TIN.
    const draft = await h.signUp({ email: `draft-${randomUUID().slice(0, 8)}@example.com`, name: "Dina Draft" });
    await h.enableTwoFactor(draft.browser);
    expect((await draft.browser.put("/api/v1/seller/store", { name: `Draft Shop ${randomUUID().slice(0, 6)}`, category: "electronics", shipsFrom: "Manila" })).status).toBe(200);
    expect((await draft.browser.put("/api/v1/seller/store/verification", { businessType: "INDIVIDUAL", legalName: "Dina Draft", tin: "123-456-789-000" })).status).toBe(200);
    const draftStore = await h.db.prisma.store.findUniqueOrThrow({ where: { ownerId: draft.user.id } });
    expect((await support.browser.get(`${A}/applications/${draftStore.id}`)).status).toBe(404);
    expect((await support.browser.post(`${A}/applications/${draftStore.id}/tin`)).status).toBe(404);
  });

  it('Approve needs "Confirm it\'s you"; then the store is live, its account verified, the seller emailed', async () => {
    const seller = await sell.seller();
    const support = await adm.admin(["SUPPORT"], { name: "Rina Admin" });
    const path = `${A}/applications/${seller.store.id}/approve`;
    const unconfirmed = await support.browser.post(path, {});
    expect([unconfirmed.status, unconfirmed.body.error?.code]).toEqual([403, "REAUTH_REQUIRED"]);
    expect((await h.db.prisma.store.findUniqueOrThrow({ where: { id: seller.store.id } })).status).toBe("PENDING");

    await adm.confirm(support);
    const res = await support.browser.post(path, { note: "Welcome to Vendora!" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.application).toMatchObject({ status: "APPROVED", canReview: false, payoutAccount: { verified: true }, review: { by: "Rina Admin", note: "Welcome to Vendora!" } });
    expect((await request(h.app).get(`/api/v1/stores/${seller.store.slug}`)).status).toBe(200); // live
    expect(await h.db.prisma.storeDocument.count({ where: { storeId: seller.store.id, status: "VERIFIED" } })).toBe(1);
    expect(mail(seller.user.email, "store-approved").at(-1)?.text).toContain("A note from our team: Welcome to Vendora!");
    expect((await auditOf(seller.store.id)).map((r) => r.action)).toEqual(["store.approve"]);
    const again = await support.browser.post(path, {});
    expect([again.status, again.body.error?.details?.reason]).toEqual([409, "not_pending"]);
  });

  it("Ask for changes: back to the seller with the note; they edit and submit again", async () => {
    const seller = await sell.seller();
    const support = await adm.admin();
    const base = `${A}/applications/${seller.store.id}`;
    expect((await support.browser.post(`${base}/request-changes`, { note: "short" })).status).toBe(400);
    const note = "Please upload a clearer photo of your ID: the name is hard to read.";
    const res = await support.browser.post(`${base}/request-changes`, { note });
    expect(res.status).toBe(200);
    expect(res.body.application).toMatchObject({ status: "CHANGES_REQUESTED", canReview: false, review: { note } });
    expect(mail(seller.user.email, "store-changes-requested").at(-1)?.text).toContain(note);
    expect((await support.browser.post(`${base}/reject`, { note: "Not until it's submitted again." })).status).toBe(409);

    // The seller sees the note, can edit their details again, and submits again.
    let view = (await seller.browser.get("/api/v1/seller/store")).body;
    expect(view.store.review).toMatchObject({ status: "CHANGES_REQUESTED", note });
    expect(view.canSubmit).toBe(true);
    expect((await seller.browser.put("/api/v1/seller/store/verification", { businessType: "INDIVIDUAL", legalName: "Ana Maria Reyes Cruz", tin: "123-456-789-000" })).status).toBe(200);
    view = (await seller.browser.post("/api/v1/seller/store/submit")).body;
    expect(view.store.status).toBe("PENDING");
    const queue = await support.browser.get(`${A}/applications?q=${encodeURIComponent(seller.user.email)}`);
    expect(queue.body.items.map((i: { storeId: string }) => i.storeId)).toEqual([seller.store.id]);
  });

  it("Reject is final: the seller can't edit or submit again, nor change products; two admins at once: one decides", async () => {
    const seller = await sell.seller();
    const one = await adm.admin();
    const two = await adm.admin();
    const base = `${A}/applications/${seller.store.id}`;
    const [a, b] = await Promise.all([
      one.browser.post(`${base}/reject`, { note: "We couldn't verify this business with the DTI." }),
      two.browser.post(`${base}/request-changes`, { note: "Please upload your DTI certificate." })
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const status = (await h.db.prisma.store.findUniqueOrThrow({ where: { id: seller.store.id } })).status;
    expect(["REJECTED", "CHANGES_REQUESTED"]).toContain(status);
    expect(await h.db.prisma.auditLog.count({ where: { targetId: seller.store.id } })).toBe(1);

    const rejected = await sell.seller();
    await one.browser.post(`${A}/applications/${rejected.store.id}/reject`, { note: "We couldn't verify this business with the DTI." });
    expect(mail(rejected.user.email, "store-rejected").at(-1)?.text).toContain("We couldn't verify this business with the DTI.");
    expect((await rejected.browser.get("/api/v1/seller/store")).body.store.review).toMatchObject({ status: "REJECTED" });
    for (const res of [
      await rejected.browser.post("/api/v1/seller/store/submit"),
      await rejected.browser.put("/api/v1/seller/store/verification", { businessType: "INDIVIDUAL", legalName: "Ana Maria Reyes", tin: "123-456-789-000" }),
      await rejected.browser.post("/api/v1/seller/products", { intent: "draft", title: "Something", category: "headphones" })
    ]) {
      expect([res.status, res.body.error?.details?.reason]).toEqual([403, "store_rejected"]);
    }
  });
});

describe("Payout accounts changed after approval", () => {
  it('are listed for checking; Show number is logged; Verify needs "Confirm it\'s you", then payouts go there', async () => {
    const seller = await sell.seller();
    await approveStore(h.db.prisma, seller.store.slug, null);
    await h.allowCodeReuse(seller.user.id);
    expect((await seller.browser.post("/api/v1/auth/confirm", { code: totpCode(seller.manualKey) })).status).toBe(200);
    expect((await seller.browser.put("/api/v1/seller/store/payout-account", { method: "BANK", bankName: "BPI", accountName: "Ana Maria Reyes", accountNumber: "1234-5678-90" })).status).toBe(200);

    const support = await adm.admin();
    const underReview = await sell.seller(); // its account is checked with the application, not here
    let list = (await support.browser.get(`${A}/payout-accounts`)).body.items as { storeId: string; method: string; last4: string; bankName: string }[];
    expect(list.find((x) => x.storeId === seller.store.id)).toMatchObject({ method: "BANK", bankName: "BPI", last4: "7890" });
    expect(list.some((x) => x.storeId === underReview.store.id)).toBe(false);
    expect((await support.browser.post(`${A}/payout-accounts/${seller.store.id}/number`)).body).toEqual({ accountNumber: "1234567890" });

    const unconfirmed = await support.browser.post(`${A}/payout-accounts/${seller.store.id}/verify`);
    expect(unconfirmed.body.error?.code).toBe("REAUTH_REQUIRED");
    await adm.confirm(support);
    const res = await support.browser.post(`${A}/payout-accounts/${seller.store.id}/verify`);
    expect(res.status).toBe(200);
    list = res.body.items;
    expect(list.some((x) => x.storeId === seller.store.id)).toBe(false);
    expect((await h.db.prisma.payoutAccount.findUniqueOrThrow({ where: { storeId: seller.store.id } })).verifiedAt).not.toBeNull();
    expect(mail(seller.user.email, "payout-account-verified").at(-1)?.text).toContain("BPI •••• 7890");
    const account = await h.db.prisma.payoutAccount.findUniqueOrThrow({ where: { storeId: seller.store.id } });
    expect((await auditOf(account.id)).map((r) => r.action)).toEqual(["payout_account.view_number", "payout_account.verify"]);
    expect((await support.browser.post(`${A}/payout-accounts/${seller.store.id}/verify`)).body.error?.details?.reason).toBe("already_verified");
  });
});

describe("Payout accounts: changed again while being checked", () => {
  it("Verify only verifies the number that was checked; a newer one stays unverified", async () => {
    const seller = await sell.seller({ approve: true });
    await h.db.prisma.payoutAccount.update({ where: { storeId: seller.store.id }, data: { verifiedAt: null } }); // changed after approval
    const account = await h.db.prisma.payoutAccount.findUniqueOrThrow({ where: { storeId: seller.store.id } });
    const support = await adm.admin();
    const service = new ApplicationService({ prisma: h.db.prisma, media: null, email: new DevOutbox(), config: testConfig() });
    // The seller saves a new number while the admin is confirming it's them.
    const ensureConfirmed = async () => {
      await h.db.prisma.payoutAccount.update({ where: { id: account.id }, data: { accountNumberEncrypted: "a-newer-number", last4: "0000" } });
    };
    await expect(service.verifyPayoutAccount(support.user.id, seller.store.id, { ensureConfirmed, ip: null })).rejects.toMatchObject({ status: 409, details: { reason: "changed" } });
    expect((await h.db.prisma.payoutAccount.findUniqueOrThrow({ where: { id: account.id } })).verifiedAt).toBeNull();
    expect(await h.db.prisma.auditLog.count({ where: { targetId: account.id, action: "payout_account.verify" } })).toBe(0);
  });
});

describe("Admin dashboard", () => {
  it("this month's sales and orders, what's waiting, orders per day, the oldest applications first", async () => {
    const admin = await adm.admin(["MODERATION"]);
    const before = (await admin.browser.get(`${A}/dashboard`)).body;
    const s = await shop.shopper();
    await shop.order(s, [["SC-POCKET-BLK", 1]]); // ₱799 + ₱49 delivery, cash on delivery
    const waitingSeller = await sell.seller();
    const after = (await admin.browser.get(`${A}/dashboard`)).body;
    expect(after.sales.gmvCentavos - before.sales.gmvCentavos).toBe(79_900 + 4_900);
    expect(after.orders.count - before.orders.count).toBe(1);
    expect(after.waiting.applications - before.waiting.applications).toBe(1);
    expect(after.ordersPerDay).toHaveLength(14);
    expect(after.ordersPerDay.at(-1).orders - before.ordersPerDay.at(-1).orders).toBe(1);
    const oldest = await h.db.prisma.store.findFirstOrThrow({ where: { status: "PENDING" }, orderBy: { submittedAt: "asc" } });
    expect(after.queues.applications[0].storeId).toBe(oldest.id);
    expect(after.queues.applications.length).toBeLessThanOrEqual(4);
    expect(waitingSeller.store.id).toBeTruthy();
  });

  it("leaves cancelled orders out, and compares with the same days of last month only", async () => {
    const admin = await adm.admin(["FINANCE"]);
    const s = await shop.shopper();
    const before = (await admin.browser.get(`${A}/dashboard`)).body;
    const cancelled = await shop.order(s, [["SC-POCKET-BLK", 1]]);
    expect((await s.browser.post(`/api/v1/orders/${cancelled.id}/cancel`)).status).toBe(200); // the buyer, within the hour
    const after = (await admin.browser.get(`${A}/dashboard`)).body;
    expect([after.sales.gmvCentavos, after.orders.count, after.ordersPerDay.at(-1).orders]).toEqual([before.sales.gmvCentavos, before.orders.count, before.ordersPerDay.at(-1).orders]);

    // Seen from the 2nd of next month at noon (Manila), "last month" counts only up to its 2nd at noon.
    const DAY = 86_400_000;
    const thisMonth = manilaMonthStart(manilaMonth(new Date()));
    const nextMonth = manilaMonthStart(manilaMonth(new Date(thisMonth.getTime() + 40 * DAY)));
    const o = await shop.order(s, [["SC-POCKET-BLK", 1]]);
    h.clock.offsetMs = nextMonth.getTime() + 36 * 3_600_000 - Date.now();
    const previousWith = async (placedAt: Date) => {
      await h.db.prisma.order.update({ where: { id: o.id }, data: { placedAt } });
      const res = await admin.browser.get(`${A}/dashboard`);
      expect(res.status).toBe(200);
      return res.body.orders.previous as number;
    };
    const early = await previousWith(new Date(thisMonth.getTime() + 3_600_000)); // the 1st, 1 AM: inside the same days
    const late = await previousWith(new Date(thisMonth.getTime() + 20 * DAY)); // the 21st: after them
    expect(early - late).toBe(1);
  });
});
