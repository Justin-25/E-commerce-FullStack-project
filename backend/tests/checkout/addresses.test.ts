import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_ADDRESSES, normalizePhone } from "../../src/modules/addresses/addresses.schemas.js";
import { createCatalogHarness, type CatalogHarness } from "../support/catalogHarness.js";

let h: CatalogHarness;
beforeAll(async () => {
  h = await createCatalogHarness();
}, 120_000);
afterAll(() => h?.close());

const A = "/api/v1/addresses";
let emails = 0;
const shopper = () => h.signUp({ email: `addr${++emails}@example.com` });
type Address = { id: string; label: string | null; fullName: string; phone: string; region: string; province: string | null; city: string; barangay: string; street: string; postalCode: string; isDefault: boolean };

const home = {
  label: "Home",
  fullName: "Maria Santos",
  phone: "0917 123 4567",
  region: "NCR",
  city: "Manila",
  barangay: "Brgy. 669, Ermita",
  street: "Unit 12B, 1350 Taft Avenue",
  postalCode: "1000"
};
const cebu = { ...home, label: "Parents", region: "Central Visayas", province: "Cebu", city: "Cebu City", barangay: "Lahug", street: "21 Salinas Drive", postalCode: "6000" };

describe("Addresses", () => {
  it("need you to be signed in, and a CSRF token to change anything", async () => {
    const anonymous = await h.browser();
    for (const res of [await anonymous.get(A), await anonymous.post(A, home)]) expect(res.status).toBe(401);
    const { browser } = await shopper();
    expect((await browser.agent.post(A).send(home)).status).toBe(403);
    const list = await browser.get(A);
    expect(list.headers["cache-control"]).toBe("private, no-store");
    expect(list.body).toEqual({ addresses: [] });
  });

  it("save the first address as the default, in one phone format, with no province in Metro Manila", async () => {
    const { browser } = await shopper();
    const res = await browser.post(A, { ...home, province: "Metro Manila", isDefault: false });
    expect(res.status).toBe(201);
    expect(res.body.address).toMatchObject({ ...home, phone: "+639171234567", province: null, isDefault: true });
    expect(Object.keys(res.body.address).sort()).toEqual(["barangay", "city", "createdAt", "fullName", "id", "isDefault", "label", "phone", "postalCode", "province", "region", "street"]);
  });

  it("check every field and refuse unknown ones", async () => {
    const { browser } = await shopper();
    const cases: [object, string][] = [
      [{ ...home, phone: "1234" }, "phone"],
      [{ ...home, phone: "+1 415 555 0100" }, "phone"],
      [{ ...home, postalCode: "100" }, "postalCode"],
      [{ ...cebu, province: "" }, "province"],
      [{ ...home, region: "Metro Manila" }, "region"],
      [{ ...home, fullName: "M" }, "fullName"],
      [{ ...home, label: "x".repeat(31) }, "label"],
      [{ ...home, street: "" }, "street"]
    ];
    for (const [body, field] of cases) {
      const res = await browser.post(A, body);
      expect(res.status, field).toBe(400);
      expect((res.body.error.fields as { path: string }[]).map((f) => f.path), field).toContain(field);
    }
    const sneaky = await browser.post(A, { ...home, userId: "someone-else", isDefault: true });
    expect(sneaky.status).toBe(400);
    expect((await browser.get(A)).body.addresses).toEqual([]);
  });

  it("keep exactly one default: a new default replaces the old, and 'Set as default' moves it", async () => {
    const { browser, user } = await shopper();
    const first = (await browser.post(A, home)).body.address as Address;
    const second = (await browser.post(A, { ...cebu, isDefault: true })).body.address as Address;
    let list = (await browser.get(A)).body.addresses as Address[];
    expect(list.map((a) => [a.id, a.isDefault])).toEqual([[second.id, true], [first.id, false]]);

    expect((await browser.post(`${A}/${first.id}/default`)).body.address.isDefault).toBe(true);
    list = (await browser.get(A)).body.addresses as Address[];
    expect(list[0]?.id).toBe(first.id);
    expect(await h.db.prisma.address.count({ where: { userId: user.id, isDefault: true } })).toBe(1);
  });

  it("edit with the whole form, and deleting the default passes it to the newest one left", async () => {
    const { browser } = await shopper();
    const a = (await browser.post(A, home)).body.address as Address;
    const b = (await browser.post(A, cebu)).body.address as Address;
    const c = (await browser.post(A, { ...cebu, label: "Office", street: "Cebu IT Park, Tower 2" })).body.address as Address;

    const edited = await browser.put(`${A}/${b.id}`, { ...cebu, label: "Lola's house", phone: "+63 918 765 4321" });
    expect(edited.body.address).toMatchObject({ id: b.id, label: "Lola's house", phone: "+639187654321", isDefault: false });
    expect((await browser.put(`${A}/${b.id}`, { label: "only one field" })).status).toBe(400); // the whole form is required

    expect((await browser.delete(`${A}/${a.id}`)).body).toEqual({ deleted: true });
    const list = (await browser.get(A)).body.addresses as Address[];
    expect(list.map((x) => x.id)).toEqual([c.id, b.id]); // c is the newest, so it's the default now
    expect(list[0]?.isDefault).toBe(true);
    expect((await browser.delete(`${A}/${a.id}`)).status).toBe(404);
  });

  it("are private: someone else's address answers 404 and stays untouched", async () => {
    const owner = await shopper();
    const other = await shopper();
    const mine = (await owner.browser.post(A, home)).body.address as Address;
    expect((await other.browser.put(`${A}/${mine.id}`, cebu)).status).toBe(404);
    expect((await other.browser.delete(`${A}/${mine.id}`)).status).toBe(404);
    expect((await other.browser.post(`${A}/${mine.id}/default`)).status).toBe(404);
    expect((await other.browser.get(A)).body.addresses).toEqual([]);
    expect((await owner.browser.get(A)).body.addresses[0]).toMatchObject({ id: mine.id, city: "Manila" });
    expect((await owner.browser.put(`${A}/not-a-uuid`, home)).status).toBe(400);
  });

  it(`stop at ${MAX_ADDRESSES}, and two simultaneous first addresses still give one default`, async () => {
    const { browser, user } = await shopper();
    const results = await Promise.all([browser.post(A, home), browser.post(A, cebu)]);
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await h.db.prisma.address.count({ where: { userId: user.id, isDefault: true } })).toBe(1);
    for (let i = 2; i < MAX_ADDRESSES; i++) expect((await browser.post(A, { ...home, label: `Place ${i}` })).status).toBe(201);
    const over = await browser.post(A, home);
    expect(over.status).toBe(409);
    expect(await h.db.prisma.address.count({ where: { userId: user.id } })).toBe(MAX_ADDRESSES);
  });
});

describe("normalizePhone", () => {
  it("accepts the ways people type Philippine mobile numbers", () => {
    for (const raw of ["09171234567", "0917 123 4567", "0917-123-4567", "+639171234567", "+63 917 123 4567", "639171234567", "(0917) 123 4567", "9171234567"]) {
      expect(normalizePhone(raw), raw).toBe("+639171234567");
    }
    for (const raw of ["0817 123 4567", "0917123456", "091712345678", "+1 917 123 4567", "hello"]) expect(normalizePhone(raw), raw).toBeNull();
  });
});
