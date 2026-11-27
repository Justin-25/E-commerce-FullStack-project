import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DevOutbox } from "../../src/lib/email.js";
import { MemoryKv } from "../../src/lib/kv.js";
import { UserAdminService } from "../../src/modules/admin/users.service.js";
import { testConfig } from "../helpers.js";
import { admins } from "../support/admins.js";
import { AUTH, GOOD_PASSWORD } from "../support/authHarness.js";
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
const mail = (to: string, kind: string) => h.outbox.sent.filter((m) => m.to === to && m.kind === kind);
const auditOf = (targetId: string) => h.db.prisma.auditLog.findMany({ where: { targetId }, orderBy: { createdAt: "asc" }, select: { action: true, actorId: true, metadata: true } });
const login = async (email: string) => (await h.browser()).post(AUTH.login, { email, password: GOOD_PASSWORD });
const confirmReset = async (token: string) => (await h.browser()).post("/api/v1/auth/two-factor-reset", { token });
const tokenIn = (text: string | undefined) => text?.match(/#token=([A-Za-z0-9_-]{43})/)?.[1] ?? "";
type User = {
  id: string;
  status: string;
  role: string;
  suspended: { reason: string; by: string | null } | null;
  twoFactor: { enabled: boolean; backupCodesLeft: number };
  store: { slug: string; status: string; suspendedWithAccount: boolean } | null;
  twoFactorReset: { by: string | null; expiresAt: string } | null;
  canSuspend: boolean;
  canReactivate: boolean;
  canResetTwoFactor: boolean;
  securityActivity: { type: string }[];
  history: { action: string; by: string }[];
};
async function support(name = "Sam Support") {
  const s = await adm.admin(["SUPPORT"], { name });
  await adm.confirm(s);
  return s;
}

describe("Users list", () => {
  it("is Support's: newest first, tabs with counts, search; a locked account shows until when (no unlock button)", async () => {
    const fin = await adm.admin(["FINANCE"]);
    const refused = await fin.browser.get(`${A}/users`);
    expect([refused.status, refused.body.error?.details?.reason, refused.body.error?.details?.role]).toEqual([403, "missing_role", "SUPPORT"]);

    const seller = await sell.seller();
    const locked = await h.signUp({ email: `locked-${randomUUID().slice(0, 8)}@example.com`, name: "Lia Locke" });
    for (let i = 0; i < 5; i++) await (await h.browser()).post(AUTH.login, { email: locked.user.email, password: "wrong password here" });
    const s = await adm.admin(["SUPPORT"]);
    const res = await s.browser.get(`${A}/users`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body.items[0].id).toBe(s.user.id); // newest first
    expect(res.body.counts).toMatchObject({ all: expect.any(Number), lockedSuspended: expect.any(Number) });
    expect(res.body.counts.all).toBeGreaterThanOrEqual(res.body.counts.customers + res.body.counts.sellers + res.body.counts.admins);

    const lockedTab = await s.browser.get(`${A}/users?tab=locked_suspended`);
    const row = lockedTab.body.items.find((u: { id: string }) => u.id === locked.user.id);
    expect(row).toMatchObject({ name: "Lia Locke", role: "CUSTOMER", status: "ACTIVE", twoFactor: false, orders: 0 });
    expect(Date.parse(row.lockedUntil) - Date.now()).toBeGreaterThan(14 * 60_000);
    h.clock.offsetMs = 16 * 60_000; // the lock ends by itself
    expect((await s.browser.get(`${A}/users?tab=locked_suspended`)).body.items.some((u: { id: string }) => u.id === locked.user.id)).toBe(false);
    expect((await s.browser.get(`${A}/users?q=${encodeURIComponent(locked.user.email)}`)).body.items[0].lockedUntil).toBeNull();
    expect((await s.browser.get(`${A}/users/${locked.user.id}`)).body.user.lockedUntil).toBeNull();
    h.clock.offsetMs = 0;

    const sellersTab = await s.browser.get(`${A}/users?tab=sellers&q=${encodeURIComponent(seller.user.email)}`);
    expect(sellersTab.body.items.map((u: { id: string }) => u.id)).toEqual([seller.user.id]);
    expect(sellersTab.body.items[0]).toMatchObject({ role: "SELLER", twoFactor: true });
    expect((await s.browser.get(`${A}/users?tab=admins&q=${encodeURIComponent(seller.user.email)}`)).body.items).toEqual([]);
    expect((await s.browser.get(`${A}/users?q=lia%20LOCKE`)).body.items.map((u: { id: string }) => u.id)).toContain(locked.user.id);
    expect((await s.browser.get(`${A}/users?tab=nope`)).status).toBe(400);
  });

  it("Export CSV: the list's columns only, formula-safe, and every export is logged", async () => {
    const odd = await h.signUp({ email: `formula-${randomUUID().slice(0, 8)}@example.com`, name: '=HYPERLINK("http://evil.example")' });
    const s = await adm.admin(["SUPPORT"]);
    const res = await s.browser.post(`${A}/users/export`, { tab: "customers", q: odd.user.email });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="?vendora-users-customers-\d{4}-\d{2}-\d{2}\.csv"?/);
    const lines = res.text.replace(new RegExp(`^${String.fromCharCode(0xfeff)}`), "").trimEnd().split("\r\n");
    expect(lines[0]).toBe("Name,Email,Role,Two-step,Orders,Joined (PH time),Status");
    expect(lines).toHaveLength(2);
    expect(lines[1]?.startsWith(`"'=HYPERLINK(""http://evil.example"")"`)).toBe(true); // shown as text in Excel, never run
    expect(lines[1]).toContain(`${odd.user.email},Customer,Off,0,`);
    const log = await h.db.prisma.auditLog.findFirst({ where: { action: "user.export", actorId: s.user.id } });
    expect(log?.metadata).toEqual({ tab: "customers", q: odd.user.email, rows: 1 });
    expect((await (await adm.admin(["FINANCE"])).browser.post(`${A}/users/export`, {})).status).toBe(403);
  });
});

describe("One account", () => {
  it("shows role, two-step, orders, store, security activity and history; admin accounts are view-only here", async () => {
    const seller = await sell.seller({ approve: true });
    const s = await support();
    const res = await s.browser.get(`${A}/users/${seller.user.id}`);
    expect(res.status).toBe(200);
    const u = res.body.user as User;
    expect(u).toMatchObject({ role: "SELLER", status: "ACTIVE", twoFactor: { enabled: true, backupCodesLeft: 10 }, store: { slug: seller.store.slug, status: "APPROVED" }, canSuspend: true, canResetTwoFactor: true, canReactivate: false });
    expect(u.securityActivity.map((e) => e.type)).toContain("TWO_FA_ENABLED");

    const other = await adm.admin(["FINANCE"]);
    const adminView = (await s.browser.get(`${A}/users/${other.user.id}`)).body.user as User;
    expect(adminView).toMatchObject({ role: "ADMIN", canSuspend: false, canResetTwoFactor: false });
    for (const path of ["suspend", "two-factor-reset"]) {
      const body = path === "suspend" ? { reason: "Testing whether admins can be suspended." } : { identityCheck: "Matched the ID on file." };
      const refused = await s.browser.post(`${A}/users/${other.user.id}/${path}`, body);
      expect([refused.status, refused.body.error?.details?.reason]).toEqual([403, "admin_target"]);
    }
    expect((await s.browser.get(`${A}/users/${randomUUID()}`)).status).toBe(404);
  });
});

describe("Suspend and reactivate", () => {
  it('needs "Confirm it\'s you" and a reason; ends every sign-in at once and refuses new ones; the seller\'s store goes down with it', async () => {
    const seller = await sell.seller({ approve: true, name: "Sel Seller" });
    expect((await request(h.app).get(`/api/v1/stores/${seller.store.slug}`)).status).toBe(200);
    const s = await adm.admin(["SUPPORT"], { name: "Sam Support" });
    const path = `${A}/users/${seller.user.id}/suspend`;
    expect((await s.browser.post(path, { reason: "spam" })).status).toBe(400);
    const unconfirmed = await s.browser.post(path, { reason: "Selling counterfeit headphones (3 reports)." });
    expect([unconfirmed.status, unconfirmed.body.error?.code]).toEqual([403, "REAUTH_REQUIRED"]);
    expect((await seller.browser.get("/api/v1/seller/store")).status).toBe(200);

    await adm.confirm(s);
    const res = await s.browser.post(path, { reason: "Selling counterfeit headphones (3 reports)." });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.user).toMatchObject({ status: "SUSPENDED", suspended: { reason: "Selling counterfeit headphones (3 reports).", by: "Sam Support" }, store: { status: "SUSPENDED", suspendedWithAccount: true }, canReactivate: true });
    expect((await seller.browser.get("/api/v1/seller/store")).status).toBe(401); // the open session ends at once
    expect((await login(seller.user.email)).body.error?.code).toBe("ACCOUNT_SUSPENDED");
    expect(await h.db.prisma.session.count({ where: { userId: seller.user.id, revokedAt: null } })).toBe(0);
    expect((await request(h.app).get(`/api/v1/stores/${seller.store.slug}`)).status).toBe(404); // hidden from shoppers
    expect(mail(seller.user.email, "account-suspended").at(-1)?.text).toContain("Why: Selling counterfeit headphones (3 reports).");
    const log = await auditOf(seller.user.id);
    expect(log.map((r) => [r.action, r.actorId])).toEqual([["user.suspend", s.user.id]]);
    expect(log[0]?.metadata).toEqual({ reason: "Selling counterfeit headphones (3 reports).", storeSuspended: true });
    const again = await s.browser.post(path, { reason: "Selling counterfeit headphones (3 reports)." });
    expect([again.status, again.body.error?.details?.reason]).toEqual([409, "already_suspended"]);

    const unconfirmed2 = await (await adm.admin(["SUPPORT"])).browser.post(`${A}/users/${seller.user.id}/reactivate`);
    expect([unconfirmed2.status, unconfirmed2.body.error?.code]).toEqual([403, "REAUTH_REQUIRED"]);
    const back = await s.browser.post(`${A}/users/${seller.user.id}/reactivate`);
    expect(back.status).toBe(200);
    expect(back.body.user).toMatchObject({ status: "ACTIVE", suspended: null, store: { status: "APPROVED", suspendedWithAccount: false } });
    expect((await request(h.app).get(`/api/v1/stores/${seller.store.slug}`)).status).toBe(200);
    expect((await login(seller.user.email)).status).toBe(200); // signs in again (then its app code)
    expect(mail(seller.user.email, "account-reactivated")).toHaveLength(1);
    expect((await auditOf(seller.user.id)).map((r) => r.action)).toEqual(["user.suspend", "user.reactivate"]);
    expect((await s.browser.post(`${A}/users/${seller.user.id}/reactivate`)).body.error?.details?.reason).toBe("not_suspended");
  });

  it("a store Support suspended on its own stays suspended; a suspended owner's application can't be approved; two admins at once: one suspends", async () => {
    const seller = await sell.seller({ approve: true });
    await h.db.prisma.store.update({ where: { id: seller.store.id }, data: { status: "SUSPENDED", suspendedAt: new Date(), suspendedCause: "ADMIN" } });
    const s = await support();
    await s.browser.post(`${A}/users/${seller.user.id}/suspend`, { reason: "Chargebacks on several orders." });
    await s.browser.post(`${A}/users/${seller.user.id}/reactivate`);
    expect(await h.db.prisma.store.findUniqueOrThrow({ where: { id: seller.store.id } })).toMatchObject({ status: "SUSPENDED", suspendedCause: "ADMIN" });

    const applicant = await sell.seller();
    expect((await s.browser.post(`${A}/users/${applicant.user.id}/suspend`, { reason: "A fake business (duplicate account)." })).status).toBe(200);
    expect((await h.db.prisma.store.findUniqueOrThrow({ where: { id: applicant.store.id } })).status).toBe("PENDING"); // not live: left as it is
    const approve = await s.browser.post(`${A}/applications/${applicant.store.id}/approve`, {});
    expect([approve.status, approve.body.error?.details?.reason]).toEqual([409, "owner_suspended"]);

    const shopper = await shop.shopper();
    const other = await support("Second Support");
    const [x, y] = await Promise.all([
      s.browser.post(`${A}/users/${shopper.user.id}/suspend`, { reason: "Abusive messages to sellers." }),
      other.browser.post(`${A}/users/${shopper.user.id}/suspend`, { reason: "Abusive messages to sellers." })
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect((await auditOf(shopper.user.id)).filter((r) => r.action === "user.suspend")).toHaveLength(1);
    expect(mail(shopper.user.email, "account-suspended")).toHaveLength(1);
  });
});

describe("Suspend: two admins at the same moment (forced)", () => {
  it("if another admin suspends the account while this one confirms it's them, this one gets 409 and nothing is written twice", async () => {
    const shopper = await shop.shopper();
    const s = await adm.admin(["SUPPORT"]);
    const other = await adm.admin(["SUPPORT"]);
    const service = new UserAdminService({ prisma: h.db.prisma, kv: new MemoryKv(), email: new DevOutbox(), config: testConfig() });
    const ensureConfirmed = async () => {
      await service.suspend(other.user.id, shopper.user.id, "Abusive messages to sellers (first admin).", { ensureConfirmed: async () => undefined, ip: null });
    };
    await expect(service.suspend(s.user.id, shopper.user.id, "Abusive messages to sellers (second admin).", { ensureConfirmed, ip: null })).rejects.toMatchObject({ status: 409, details: { reason: "already_suspended" } });
    expect((await h.db.prisma.user.findUniqueOrThrow({ where: { id: shopper.user.id } })).suspendedReason).toBe("Abusive messages to sellers (first admin).");
    expect((await auditOf(shopper.user.id)).filter((r) => r.action === "user.suspend")).toHaveLength(1);
  });
});

describe("Reset two-step verification", () => {
  it("Support writes how they checked identity; only the owner's emailed link turns it off (once), and they must set it up again", async () => {
    const seller = await sell.seller({ approve: true });
    const s = await adm.admin(["SUPPORT"], { name: "Sam Support" });
    const path = `${A}/users/${seller.user.id}/two-factor-reset`;
    expect((await s.browser.post(path, { identityCheck: "ok" })).status).toBe(400);
    expect((await s.browser.post(path, { identityCheck: "Matched a selfie with the ID on file (video call)." })).body.error?.code).toBe("REAUTH_REQUIRED");
    await adm.confirm(s);
    const first = await s.browser.post(path, { identityCheck: "Matched a selfie with the ID on file (video call)." });
    expect(first.status).toBe(200);
    expect((first.body.user as User).twoFactorReset).toMatchObject({ by: "Sam Support" });
    expect((await h.db.prisma.user.findUniqueOrThrow({ where: { id: seller.user.id } })).twoFactorEnabledAt).not.toBeNull(); // nothing yet
    const oldToken = tokenIn(mail(seller.user.email, "two-factor-reset-request").at(-1)?.text);

    // A newer request cancels the older link; an expired link doesn't work either.
    await s.browser.post(path, { identityCheck: "Matched a selfie with the ID on file (second call)." });
    const token = tokenIn(mail(seller.user.email, "two-factor-reset-request").at(-1)?.text);
    expect(token).not.toBe(oldToken);
    expect((await confirmReset(oldToken)).body.error?.code).toBe("INVALID_LINK");
    expect((await confirmReset("x".repeat(43))).body.error?.code).toBe("INVALID_LINK");
    const open = await h.db.prisma.twoFactorReset.findFirstOrThrow({ where: { userId: seller.user.id, confirmedAt: null, cancelledAt: null } });
    await h.db.prisma.twoFactorReset.update({ where: { id: open.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await confirmReset(token)).body.error?.code).toBe("INVALID_LINK");
    await h.db.prisma.twoFactorReset.update({ where: { id: open.id }, data: { expiresAt: new Date(Date.now() + 3_600_000) } });

    const res = await confirmReset(token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await h.db.prisma.user.findUniqueOrThrow({ where: { id: seller.user.id } });
    expect([after.twoFactorEnabledAt, after.twoFactorSecret]).toEqual([null, null]);
    expect(await h.db.prisma.backupCode.count({ where: { userId: seller.user.id } })).toBe(0);
    expect(await h.db.prisma.session.count({ where: { userId: seller.user.id, revokedAt: null } })).toBe(0);
    expect((await seller.browser.get("/api/v1/seller/store")).status).toBe(401); // signed out everywhere, at once
    expect(mail(seller.user.email, "two-factor-reset")).toHaveLength(1);
    expect((await confirmReset(token)).body.error?.code).toBe("INVALID_LINK"); // once only
    const log = await auditOf(seller.user.id);
    expect(log.map((r) => [r.action, r.actorId])).toEqual([
      ["user.two_factor_reset_requested", s.user.id],
      ["user.two_factor_reset_requested", s.user.id],
      ["user.two_factor_reset", seller.user.id]
    ]);
    expect(log[0]?.metadata).toMatchObject({ identityCheck: "Matched a selfie with the ID on file (video call)." });

    // The password works again, and a seller must set two-step verification up again before getting in (milestone 3's rule).
    const b = await h.browser();
    expect((await b.post(AUTH.login, { email: seller.user.email, password: GOOD_PASSWORD })).body.status).toBe("two_factor_setup_required");
    expect((await b.get("/api/v1/seller/store")).status).toBe(401);
  });

  it("isn't for accounts without two-step verification or suspended ones; suspending cancels an open link", async () => {
    const s = await support();
    const shopper = await shop.shopper();
    const off = await s.browser.post(`${A}/users/${shopper.user.id}/two-factor-reset`, { identityCheck: "Checked their last order number." });
    expect([off.status, off.body.error?.details?.reason]).toEqual([409, "two_factor_off"]);

    const seller = await sell.seller({ approve: true });
    await s.browser.post(`${A}/users/${seller.user.id}/two-factor-reset`, { identityCheck: "Matched the ID on file." });
    const token = tokenIn(mail(seller.user.email, "two-factor-reset-request").at(-1)?.text);
    await s.browser.post(`${A}/users/${seller.user.id}/suspend`, { reason: "Account under investigation for fraud." });
    expect((await confirmReset(token)).body.error?.code).toBe("INVALID_LINK");
    expect((await h.db.prisma.user.findUniqueOrThrow({ where: { id: seller.user.id } })).twoFactorEnabledAt).not.toBeNull();
    const refused = await s.browser.post(`${A}/users/${seller.user.id}/two-factor-reset`, { identityCheck: "Matched the ID on file." });
    expect([refused.status, refused.body.error?.details?.reason]).toEqual([409, "suspended"]);
  });
});

export type { Browser };
