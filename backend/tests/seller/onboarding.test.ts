import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryKv } from "../../src/lib/kv.js";
import { DevOutbox } from "../../src/lib/email.js";
import { approveStore } from "../../src/modules/seller/approval.js";
import { OnboardingService } from "../../src/modules/seller/onboarding.service.js";
import { totpCode } from "../support/authHarness.js";
import type { Browser } from "../support/browser.js";
import { createCatalogHarness, type CatalogHarness } from "../support/catalogHarness.js";

let h: CatalogHarness;
beforeAll(async () => {
  h = await createCatalogHarness();
}, 120_000);
afterAll(() => h?.close());

const S = "/api/v1/seller";
type View = {
  twoFactorEnabled: boolean;
  store: {
    id: string;
    name: string;
    slug: string;
    status: string;
    category: { slug: string; name: string } | null;
    logoUrl: string | null;
    submittedAt: string | null;
    verification: { businessType: string; legalName: string | null; registrationNo: string | null; tinLast3: string | null };
    documents: { id: string; type: string; format: string | null; bytes: number | null; status: string }[];
    payoutAccount: { method: string; bankName: string | null; accountName: string; last4: string; verifiedAt: string | null } | null;
  } | null;
  steps: { storeDetails: boolean; verification: boolean; payoutAccount: boolean };
  missing: string[];
  canSubmit: boolean;
  refreshSession?: true;
};

let n = 0;
/** A shopper with two-step verification on (required before opening a store). */
async function owner(name = "Ana Reyes", { twoFactor = true } = {}) {
  const s = await h.signUp({ email: `seller-${randomUUID().slice(0, 8)}@example.com`, name });
  const manualKey = twoFactor ? (await h.enableTwoFactor(s.browser)).manualKey : "";
  return { ...s, manualKey };
}
const view = async (b: Browser) => (await b.get(`${S}/store`)).body as View;
const details = (name: string, extra: object = {}) => ({ name, category: "electronics", description: "Speakers tuned in Manila.", shipsFrom: "Manila", ...extra });
/** The browser's side of an upload: get a ticket, upload the file to the storage service. */
async function upload(b: Browser, purpose: "store_logo" | "store_document", file: { format?: string; bytes?: number } = {}) {
  const res = await b.post(`${S}/uploads`, { purpose });
  expect(res.status).toBe(200);
  const publicId = res.body.upload.publicId as string;
  h.media.upload(publicId, { format: purpose === "store_document" ? "pdf" : "jpg", ...file });
  return publicId;
}
/** Steps 1–3 for an individual seller, ready to submit. */
async function ready(s: { browser: Browser }, name = `Ana Audio ${++n}`) {
  expect((await s.browser.put(`${S}/store`, details(name))).status).toBe(200);
  expect((await s.browser.put(`${S}/store/verification`, { businessType: "INDIVIDUAL", legalName: "Ana Maria Reyes", tin: "123-456-789-000" })).status).toBe(200);
  expect((await s.browser.post(`${S}/store/documents`, { type: "GOV_ID", publicId: await upload(s.browser, "store_document") })).status).toBe(200);
  expect((await s.browser.put(`${S}/store/payout-account`, { method: "GCASH", accountName: "Ana Maria Reyes", accountNumber: "0917 123 4567" })).status).toBe(200);
  return name;
}

describe("Becoming a seller", () => {
  it("starts with two-step verification: nothing can be set up without it", async () => {
    const s = await owner("Ben Cruz", { twoFactor: false });
    const res = await s.browser.get(`${S}/store`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body).toEqual({
      twoFactorEnabled: false,
      store: null,
      steps: { storeDetails: false, verification: false, payoutAccount: false },
      missing: ["two_factor", "store_details", "verification", "gov_id", "payout_account"],
      canSubmit: false
    });
    for (const r of [await s.browser.put(`${S}/store`, details(`Ben Shop ${++n}`)), await s.browser.post(`${S}/uploads`, { purpose: "store_logo" })]) {
      expect(r.status).toBe(403);
      expect(r.body.error.details).toEqual({ reason: "two_factor_required" });
    }
    await h.enableTwoFactor(s.browser);
    expect((await s.browser.put(`${S}/store`, details(`Ben Shop ${++n}`))).status).toBe(200);
  });

  it("goes from details to 'Submit for review': the store waits for approval, the account becomes a seller", async () => {
    const s = await owner();
    const name = `Ana Audio ${++n}`;
    let v = (await s.browser.put(`${S}/store`, details(name))).body as View;
    expect(v.store).toMatchObject({ name, slug: `ana-audio-${n}`, status: "DRAFT", category: { slug: "electronics", name: "Electronics" }, submittedAt: null });
    expect(v.steps).toEqual({ storeDetails: true, verification: false, payoutAccount: false });

    const logo = await upload(s.browser, "store_logo", { format: "png" });
    v = (await s.browser.put(`${S}/store/logo`, { publicId: logo })).body as View;
    expect(v.store?.logoUrl).toBe(`https://media.example.test/${logo}.png`); // the link comes from storage, not the browser

    v = (await s.browser.put(`${S}/store/verification`, { businessType: "INDIVIDUAL", legalName: "Ana Maria Reyes", tin: "123 456 789 000" })).body as View;
    expect(v.store?.verification).toEqual({ businessType: "INDIVIDUAL", legalName: "Ana Maria Reyes", registrationNo: null, tinLast3: "000" });
    expect(v.missing).toEqual(["gov_id", "payout_account"]);
    v = (await s.browser.post(`${S}/store/documents`, { type: "GOV_ID", publicId: await upload(s.browser, "store_document", { bytes: 860_000 }) })).body as View;
    expect(v.store?.documents).toEqual([expect.objectContaining({ type: "GOV_ID", format: "pdf", bytes: 860_000, status: "PENDING" })]);
    v = (await s.browser.put(`${S}/store/payout-account`, { method: "GCASH", accountName: "Ana Maria Reyes", accountNumber: "0917 123 4567" })).body as View;
    expect(v.store?.payoutAccount).toEqual({ method: "GCASH", bankName: null, accountName: "Ana Maria Reyes", last4: "4567", verifiedAt: null });
    expect(v).toMatchObject({ missing: [], canSubmit: true, steps: { storeDetails: true, verification: true, payoutAccount: true } });

    // Not visible to shoppers before approval.
    const guest = await h.browser();
    expect((await guest.get(`/api/v1/stores/ana-audio-${n}`)).status).toBe(404);

    const res = await s.browser.post(`${S}/store/submit`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ refreshSession: true, canSubmit: false, store: { status: "PENDING", submittedAt: expect.any(String) } });
    expect((await h.db.prisma.user.findUniqueOrThrow({ where: { id: s.user.id } })).role).toBe("SELLER");
    expect(h.outbox.lastTo(s.user.email)).toMatchObject({ kind: "store-submitted", subject: `We're reviewing ${name}` });
    expect((await guest.get(`/api/v1/stores/ana-audio-${n}`)).status).toBe(404); // still waiting

    // One session refresh puts the new role in the access pass.
    const refreshed = await s.browser.post("/api/v1/auth/refresh");
    expect(refreshed.status).toBe(200);
    expect(roleInAccessPass(refreshed.headers)).toBe("SELLER");

    // Approval (milestone 7's admin; a dev command until then).
    expect(await approveStore(h.db.prisma, `ana-audio-${n}`, null)).toBe("approved");
    expect((await guest.get(`/api/v1/stores/ana-audio-${n}`)).status).toBe(200);
    v = await view(s.browser);
    expect(v.store?.status).toBe("APPROVED");
    expect(v.store?.documents[0]?.status).toBe("VERIFIED");
    expect(v.store?.payoutAccount?.verifiedAt).toEqual(expect.any(String));
    expect(await approveStore(h.db.prisma, `ana-audio-${n}`, null)).toBe("not_pending");
    expect(await approveStore(h.db.prisma, "no-such-store", null)).toBe("not_found");
  });

  it("keeps the TIN and payout number encrypted; only their last digits are ever shown", async () => {
    const s = await owner();
    await ready(s);
    const store = await h.db.prisma.store.findUniqueOrThrow({ where: { ownerId: s.user.id }, include: { payoutAccount: true } });
    expect(store.tinEncrypted).toMatch(/^v1\./);
    expect(store.tinEncrypted).not.toContain("123456789");
    expect(store.payoutAccount?.accountNumberEncrypted).toMatch(/^v1\./);
    expect(store.payoutAccount?.accountNumberEncrypted).not.toContain("9171234567");
    const body = JSON.stringify(await view(s.browser));
    expect(body).not.toContain("123456789");
    expect(body).not.toContain("9171234567");
    expect(body).not.toContain(store.tinEncrypted ?? "none");
  });

  it("asks a registered business for its registration number and certificate", async () => {
    const s = await owner();
    await s.browser.put(`${S}/store`, details(`Reyes Trading ${++n}`));
    for (const tin of ["12345678", "1234567890", "1234567890123", "123-456-789-00000-1", "abc-def-ghi"]) {
      expect((await s.browser.put(`${S}/store/verification`, { businessType: "INDIVIDUAL", legalName: "Ana Reyes", tin })).status, tin).toBe(400);
    }
    const noNumber = await s.browser.put(`${S}/store/verification`, { businessType: "REGISTERED_BUSINESS", legalName: "Reyes Trading Co.", tin: "123456789" });
    expect(noNumber.status).toBe(400);
    expect(noNumber.body.error.fields.map((f: { path: string }) => f.path)).toEqual(["registrationNo"]);
    const individualWithNumber = await s.browser.put(`${S}/store/verification`, { businessType: "INDIVIDUAL", legalName: "Ana Reyes", registrationNo: "DTI-3810-2219", tin: "123456789" });
    expect(individualWithNumber.status).toBe(400);

    let v = (await s.browser.put(`${S}/store/verification`, { businessType: "REGISTERED_BUSINESS", legalName: "Reyes Trading Co.", registrationNo: "dti-3810-2219", tin: "123-456-789-00000" })).body as View;
    expect(v.store?.verification).toEqual({ businessType: "REGISTERED_BUSINESS", legalName: "Reyes Trading Co.", registrationNo: "DTI-3810-2219", tinLast3: "000" });
    await s.browser.post(`${S}/store/documents`, { type: "GOV_ID", publicId: await upload(s.browser, "store_document") });
    v = await view(s.browser);
    expect(v.missing).toEqual(["business_certificate", "payout_account"]);
    v = (await s.browser.post(`${S}/store/documents`, { type: "DTI_CERT", publicId: await upload(s.browser, "store_document", { format: "jpg" }) })).body as View;
    expect(v.missing).toEqual(["payout_account"]);
  });

  it("refuses incomplete submissions and says what's missing; submitting twice is harmless", async () => {
    const s = await owner();
    expect((await s.browser.post(`${S}/store/submit`)).status).toBe(404); // no store yet
    await s.browser.put(`${S}/store`, details(`Ana Audio ${++n}`));
    const early = await s.browser.post(`${S}/store/submit`);
    expect(early.status).toBe(409);
    expect(early.body.error.details).toEqual({ reason: "incomplete", missing: "verification,gov_id,payout_account" });

    await ready(s, `Ana Audio ${n}`);
    const both = await Promise.all([s.browser.post(`${S}/store/submit`), s.browser.post(`${S}/store/submit`)]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(h.outbox.sent.filter((m) => m.to === s.user.email && m.kind === "store-submitted")).toHaveLength(1);
  });
});

describe("Store names", () => {
  it("are unique (however they're written) and some are reserved", async () => {
    const a = await owner();
    const b = await owner("Ben Cruz");
    const name = `Island Sounds ${++n}`;
    expect((await a.browser.put(`${S}/store`, details(name))).status).toBe(200);
    for (const copy of [name, name.toUpperCase(), `${name}!`.replace("!", ""), name.replace(" ", "-")]) {
      const res = await b.browser.put(`${S}/store`, details(copy));
      expect(res.status, copy).toBe(409);
      expect(res.body.error.details).toEqual({ reason: "name_taken" });
      expect(res.body.error.fields).toEqual([{ path: "name", message: "This store name is taken. Please choose another." }]);
    }
    expect((await b.browser.put(`${S}/store`, details("Glow-Lab"))).body.error.details).toEqual({ reason: "name_taken" }); // a demo store
    for (const reserved of ["Vendora Official", "Admin", "Support", "My Vendora Deals"]) {
      const res = await b.browser.put(`${S}/store`, details(reserved));
      expect(res.status, reserved).toBe(409);
      expect(res.body.error.details).toEqual({ reason: "name_reserved" });
    }
    for (const bad of ["Ab", "!!!", "<script>", "a".repeat(41)]) expect((await b.browser.put(`${S}/store`, details(bad))).status, bad).toBe(400);
  });

  it("can change while a draft, but are locked once submitted", async () => {
    const s = await owner();
    await s.browser.put(`${S}/store`, details(`First Name ${++n}`));
    const renamed = (await s.browser.put(`${S}/store`, details(`Second Name ${n}`))).body as View;
    expect(renamed.store).toMatchObject({ name: `Second Name ${n}`, slug: `second-name-${n}` });
    await ready(s, `Second Name ${n}`);
    await s.browser.post(`${S}/store/submit`);
    const res = await s.browser.put(`${S}/store`, details(`Third Name ${n}`));
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ reason: "name_locked" });
    // Everything else stays editable.
    const ok = await s.browser.put(`${S}/store`, details(`Second Name ${n}`, { category: "fashion", shipsFrom: "Cebu City", description: "" }));
    expect(ok.status).toBe(200);
    expect(ok.body.store).toMatchObject({ category: { slug: "fashion" }, shipsFrom: "Cebu City", description: null });
  });

  it("go to one store when two sellers claim a name at the same moment", async () => {
    const [a, b] = await Promise.all([owner(), owner("Ben Cruz")]);
    const name = `Same Moment ${++n}`;
    const both = await Promise.all([a.browser.put(`${S}/store`, details(name)), b.browser.put(`${S}/store`, details(name))]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await h.db.prisma.store.count({ where: { slug: `same-moment-${n}` } })).toBe(1);
  });
});

describe("Store details", () => {
  it("need a top-level category and accept only the listed fields", async () => {
    const s = await owner();
    for (const category of ["headphones", "no-such-category"]) {
      const res = await s.browser.put(`${S}/store`, details(`Cat Test ${++n}`, { category }));
      expect(res.status, category).toBe(400);
      expect(res.body.error.fields).toEqual([{ path: "category", message: "Choose what your store sells" }]);
    }
    for (const sneaky of [{ status: "APPROVED" }, { ownerId: randomUUID() }, { slug: "x" }, { ratingAvg: 5 }]) {
      expect((await s.browser.put(`${S}/store`, details(`Sneaky ${++n}`, sneaky))).status, JSON.stringify(sneaky)).toBe(400);
    }
    expect(await h.db.prisma.store.count({ where: { ownerId: s.user.id } })).toBe(0);
  });

  it("can't be changed by a suspended store (milestone 7 suspends)", async () => {
    const s = await owner();
    const name = await ready(s);
    await s.browser.post(`${S}/store/submit`);
    await h.db.prisma.store.update({ where: { ownerId: s.user.id }, data: { status: "SUSPENDED" } });
    for (const res of [
      await s.browser.put(`${S}/store`, details(name)),
      await s.browser.put(`${S}/store/payout-account`, { method: "GCASH", accountName: "Ana Reyes", accountNumber: "09181112222" }),
      await s.browser.post(`${S}/uploads`, { purpose: "store_logo" })
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error.details).toEqual({ reason: "store_suspended" });
    }
    expect((await s.browser.get(`${S}/store`)).body.store.status).toBe("SUSPENDED");
  });

  it("aren't for admin accounts, and need sign-in", async () => {
    const s = await owner("Ada Admin");
    await h.db.prisma.user.update({ where: { id: s.user.id }, data: { role: "ADMIN" } });
    const res = await s.browser.put(`${S}/store`, details(`Admin Shop ${++n}`));
    expect(res.status).toBe(403);
    expect(res.body.error.details).toEqual({ reason: "admin_account" });
    const guest = await h.browser();
    for (const r of [await guest.get(`${S}/store`), await guest.put(`${S}/store`, details("Guest Shop")), await guest.post(`${S}/uploads`, { purpose: "store_logo" }), await guest.post(`${S}/store/submit`)]) {
      expect(r.status).toBe(401);
    }
  });
});

describe("Uploads", () => {
  it("hand out a one-time place in the account's own folder, with the allowed formats and size", async () => {
    const s = await owner();
    const logo = (await s.browser.post(`${S}/uploads`, { purpose: "store_logo" })).body.upload;
    expect(logo).toMatchObject({ allowedFormats: ["jpg", "png", "webp"], maxBytes: 5 * 1024 * 1024, fields: expect.objectContaining({ type: "upload" }) });
    expect(logo.publicId).toMatch(new RegExp(`^vendora/store-logos/${s.user.id}/[A-Za-z0-9_-]{16}$`));
    const doc = (await s.browser.post(`${S}/uploads`, { purpose: "store_document" })).body.upload;
    expect(doc).toMatchObject({ allowedFormats: ["jpg", "png", "pdf"], maxBytes: 10 * 1024 * 1024, fields: expect.objectContaining({ type: "authenticated" }) });
    expect(doc.publicId).toMatch(new RegExp(`^vendora/store-documents/${s.user.id}/`));
    expect((await s.browser.post(`${S}/uploads`, { purpose: "avatar" })).status).toBe(400);
  });

  it("only accept a file that's really there, in the account's folder, with an allowed type and size", async () => {
    const s = await owner();
    const other = await owner("Ben Cruz");
    await s.browser.put(`${S}/store`, details(`Upload Checks ${++n}`));
    // Someone else's document, even a real one, can't be attached.
    const theirs = await upload(other.browser, "store_document");
    let res = await s.browser.post(`${S}/store/documents`, { type: "GOV_ID", publicId: theirs });
    expect(res.status).toBe(400);
    expect(res.body.error.fields[0].message).toBe("This upload doesn't belong to your account. Please upload the file again.");
    // Ticket taken, nothing uploaded.
    const empty = (await s.browser.post(`${S}/uploads`, { purpose: "store_document" })).body.upload.publicId as string;
    res = await s.browser.post(`${S}/store/documents`, { type: "GOV_ID", publicId: empty });
    expect(res.body.error.fields[0].message).toBe("We couldn't find that upload. Please upload the file again.");
    // Too big: refused and deleted from storage.
    const big = await upload(s.browser, "store_document", { bytes: 11 * 1024 * 1024 });
    res = await s.browser.post(`${S}/store/documents`, { type: "GOV_ID", publicId: big });
    expect(res.status).toBe(400);
    expect(res.body.error.fields[0].message).toBe("Use JPG, PNG, PDF up to 10 MB.");
    expect(h.media.removed).toContain(big);
    // A file of another type in the right folder (not via a ticket): refused and deleted.
    const odd = `vendora/store-documents/${s.user.id}/aaaaaaaaaaaaaaaa`;
    h.media.put({ publicId: odd, access: "private", format: "gif", bytes: 1000, url: null });
    expect((await s.browser.post(`${S}/store/documents`, { type: "GOV_ID", publicId: odd })).status).toBe(400);
    expect(h.media.removed).toContain(odd);
    // A logo must be a public image, not a private document.
    const docAsLogo = await upload(s.browser, "store_document", { format: "jpg" });
    expect((await s.browser.put(`${S}/store/logo`, { publicId: docAsLogo })).status).toBe(400);
    // The same file can't be added twice.
    const id = await upload(s.browser, "store_document");
    expect((await s.browser.post(`${S}/store/documents`, { type: "GOV_ID", publicId: id })).status).toBe(200);
    res = await s.browser.post(`${S}/store/documents`, { type: "BIR_2303", publicId: id });
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ reason: "already_added" });
    expect((await view(s.browser)).store?.documents).toHaveLength(1);
  });

  it("allow at most 10 documents and 30 upload tickets an hour", async () => {
    const s = await owner();
    await s.browser.put(`${S}/store`, details(`Limits ${++n}`));
    for (let i = 0; i < 10; i++) expect((await s.browser.post(`${S}/store/documents`, { type: "BIR_2303", publicId: await upload(s.browser, "store_document") })).status).toBe(200);
    const res = await s.browser.post(`${S}/store/documents`, { type: "BIR_2303", publicId: await upload(s.browser, "store_document") });
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ reason: "too_many_documents" });
    for (let i = 11; i < 30; i++) await s.browser.post(`${S}/uploads`, { purpose: "store_logo" });
    const tooMany = await s.browser.post(`${S}/uploads`, { purpose: "store_logo" });
    expect(tooMany.status).toBe(429);
  });

  it("deletes a replaced or removed logo from storage", async () => {
    const s = await owner();
    await s.browser.put(`${S}/store`, details(`Logo Swap ${++n}`));
    const first = await upload(s.browser, "store_logo");
    const second = await upload(s.browser, "store_logo");
    expect((await s.browser.put(`${S}/store/logo`, { publicId: first })).status).toBe(200);
    expect((await s.browser.put(`${S}/store/logo`, { publicId: first })).status).toBe(200); // the same logo again: kept
    expect(h.media.removed).not.toContain(first);
    const v = (await s.browser.put(`${S}/store/logo`, { publicId: second })).body as View;
    expect(v.store?.logoUrl).toBe(`https://media.example.test/${second}.jpg`);
    expect(h.media.removed).toContain(first);
    expect(((await s.browser.delete(`${S}/store/logo`)).body as View).store?.logoUrl).toBeNull();
    expect(h.media.removed).toContain(second);
    expect(await h.db.prisma.store.findUniqueOrThrow({ where: { ownerId: s.user.id }, select: { logoUrl: true, logoPublicId: true } })).toEqual({ logoUrl: null, logoPublicId: null });
  });

  it("removing a document deletes its private file; other stores' documents can't be touched", async () => {
    const s = await owner();
    const other = await owner("Ben Cruz");
    await s.browser.put(`${S}/store`, details(`Remove Doc ${++n}`));
    await other.browser.put(`${S}/store`, details(`Other Doc ${n}`));
    const file = await upload(s.browser, "store_document");
    const docId = ((await s.browser.post(`${S}/store/documents`, { type: "GOV_ID", publicId: file })).body as View).store?.documents[0]?.id;
    expect((await other.browser.delete(`${S}/store/documents/${docId}`)).status).toBe(404);
    const res = await s.browser.delete(`${S}/store/documents/${docId}`);
    expect(res.status).toBe(200);
    expect(res.body.store.documents).toEqual([]);
    expect(h.media.removed).toContain(file);
  });

  it("answer 503 while the storage service is down, and the upload can be retried", async () => {
    const s = await owner();
    await s.browser.put(`${S}/store`, details(`Outage ${++n}`));
    const file = await upload(s.browser, "store_document");
    h.media.down = true;
    try {
      expect((await s.browser.post(`${S}/store/documents`, { type: "GOV_ID", publicId: file })).status).toBe(503);
    } finally {
      h.media.down = false;
    }
    expect((await s.browser.post(`${S}/store/documents`, { type: "GOV_ID", publicId: file })).status).toBe(200);
  });

  it("are off without a storage service (no CLOUDINARY_URL)", async () => {
    const service = new OnboardingService({ prisma: h.db.prisma, kv: new MemoryKv(), media: null, email: new DevOutbox(), config: { DATA_ENCRYPTION_KEY: "k".repeat(43), APP_URL: "http://localhost" } });
    const s = await owner();
    await expect(service.uploadTicket(s.user.id, "store_logo")).rejects.toMatchObject({ status: 503 });
  });
});

describe("After submitting", () => {
  it("business details and documents are locked", async () => {
    const s = await owner();
    await ready(s);
    const docId = (await view(s.browser)).store?.documents[0]?.id;
    await s.browser.post(`${S}/store/submit`);
    for (const res of [
      await s.browser.put(`${S}/store/verification`, { businessType: "INDIVIDUAL", legalName: "Someone Else", tin: "999999999" }),
      await s.browser.post(`${S}/store/documents`, { type: "GOV_ID", publicId: await upload(s.browser, "store_document") }),
      await s.browser.delete(`${S}/store/documents/${docId}`)
    ]) {
      expect(res.status).toBe(409);
      expect(res.body.error.details).toEqual({ reason: "store_submitted" });
    }
  });

  it("changing the payout account needs 'Confirm it's you', is recorded, and emails the owner", async () => {
    const s = await owner();
    await ready(s);
    // While a draft, the account can be replaced freely (no email).
    expect((await s.browser.put(`${S}/store/payout-account`, { method: "GCASH", accountName: "Ana Reyes", accountNumber: "09181112222" })).status).toBe(200);
    await s.browser.post(`${S}/store/submit`);
    await approveStore(h.db.prisma, (await view(s.browser)).store?.slug ?? "", null); // the account gets verified at review
    const bank = { method: "BANK", bankName: "BPI", accountName: "Ana Maria Reyes", accountNumber: "1234-5678-90" };

    const unconfirmed = await s.browser.put(`${S}/store/payout-account`, bank);
    expect(unconfirmed.status).toBe(403);
    expect(unconfirmed.body.error.code).toBe("REAUTH_REQUIRED");
    expect((await view(s.browser)).store?.payoutAccount).toMatchObject({ method: "GCASH", last4: "2222", verifiedAt: expect.any(String) });

    await h.allowCodeReuse(s.user.id);
    expect((await s.browser.post("/api/v1/auth/confirm", { code: totpCode(s.manualKey) })).status).toBe(200);
    const res = await s.browser.put(`${S}/store/payout-account`, bank);
    expect(res.status).toBe(200);
    expect(res.body.store.payoutAccount).toEqual({ method: "BANK", bankName: "BPI", accountName: "Ana Maria Reyes", last4: "7890", verifiedAt: null });
    const sent = h.outbox.sent.filter((m) => m.to === s.user.email && m.kind === "payout-account-changed");
    expect(sent).toHaveLength(1); // only the change after submitting, not the draft one
    expect(sent[0]?.text).toContain("BPI •••• 7890");
    expect(await h.db.prisma.securityEvent.count({ where: { userId: s.user.id, type: "PAYOUT_ACCOUNT_CHANGED" } })).toBe(1);
  });

  it("checks payout details: a real mobile number, a listed bank, digits only", async () => {
    const s = await owner();
    await s.browser.put(`${S}/store`, details(`Payout Rules ${++n}`));
    for (const bad of [
      { method: "GCASH", accountName: "Ana", accountNumber: "1234" },
      { method: "BANK", bankName: "Bank of Nowhere", accountName: "Ana Reyes", accountNumber: "1234567890" },
      { method: "BANK", bankName: "BPI", accountName: "Ana Reyes", accountNumber: "12345abcde" },
      { method: "BANK", accountName: "Ana Reyes", accountNumber: "1234567890" },
      { method: "PAYPAL", accountName: "Ana Reyes", accountNumber: "1234567890" },
      { method: "GCASH", accountName: "Ana Reyes", accountNumber: "09171234567", bankName: "BPI" }
    ]) {
      expect((await s.browser.put(`${S}/store/payout-account`, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await view(s.browser)).store?.payoutAccount).toBeNull();
  });
});

/** The role inside the new access pass (a JWT in a cookie): what Seller Center's guards will read. */
function roleInAccessPass(headers: Record<string, unknown>): string | undefined {
  const cookies = ([] as string[]).concat((headers["set-cookie"] as string[] | undefined) ?? []);
  for (const c of cookies) {
    const value = c.split(";")[0]?.split("=")[1] ?? "";
    const parts = value.split(".");
    if (parts.length !== 3) continue;
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as { role?: string };
    if (payload.role) return payload.role;
  }
  return undefined;
}
