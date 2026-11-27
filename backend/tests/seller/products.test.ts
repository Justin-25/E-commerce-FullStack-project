import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCatalogHarness, type CatalogHarness } from "../support/catalogHarness.js";
import { sellers, type SellerProduct } from "../support/sellers.js";
import { shopping } from "../support/shopping.js";

let h: CatalogHarness;
let sell: ReturnType<typeof sellers>;
let shop: ReturnType<typeof shopping>;
beforeAll(async () => {
  h = await createCatalogHarness();
  sell = sellers(h);
  shop = shopping(h);
}, 120_000);
afterAll(() => h?.close());

const P = "/api/v1/seller/products";
const fieldsOf = (res: { body: { error?: { fields?: { path: string; message: string }[] } } }) => Object.fromEntries((res.body.error?.fields ?? []).map((f) => [f.path, f.message]));
const days = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();

describe("Who can use Seller Center products", () => {
  it("only sellers: a shopper is refused, a suspended store can look but not change, admins can't sell", async () => {
    const shopper = await h.signUp({ email: `shopper-${randomUUID().slice(0, 8)}@example.com` });
    for (const res of [await shopper.browser.get(P), await shopper.browser.post(P, { intent: "draft", title: "Test", category: "headphones" }), await shopper.browser.post("/api/v1/seller/uploads", { purpose: "product_photo" })]) {
      expect(res.status).toBe(403);
      expect(res.body.error.details).toEqual({ reason: "not_a_seller" });
    }

    // A store that's still a draft (not submitted) can't sell yet.
    const drafting = await h.signUp({ email: `drafting-${randomUUID().slice(0, 8)}@example.com` });
    await h.enableTwoFactor(drafting.browser);
    expect((await drafting.browser.put("/api/v1/seller/store", { name: `Draft Shop ${randomUUID().slice(0, 8)}`, category: "electronics", shipsFrom: "Manila" })).status).toBe(200);
    await h.db.prisma.user.update({ where: { id: drafting.user.id }, data: { role: "SELLER" } }); // even if the role were wrong
    expect((await drafting.browser.get(P)).body.error?.details).toEqual({ reason: "not_a_seller" });

    const s = await sell.seller();
    const list = await s.browser.get(P);
    expect(list.status).toBe(200);
    expect(list.headers["cache-control"]).toBe("private, no-store");
    const product = await sell.publish(s.browser);

    // Sellers can't turn two-step verification off, but if it were missing, Seller Center refuses.
    await h.db.prisma.user.update({ where: { id: s.user.id }, data: { twoFactorEnabledAt: null } });
    expect((await s.browser.get(P)).body.error?.details).toEqual({ reason: "two_factor_required" });
    await h.db.prisma.user.update({ where: { id: s.user.id }, data: { twoFactorEnabledAt: new Date() } });

    await h.db.prisma.store.update({ where: { id: s.store.id }, data: { status: "SUSPENDED", suspendedAt: new Date(), suspendedCause: "ADMIN" } });
    expect((await s.browser.get(P)).status).toBe(200);
    expect((await s.browser.get(`${P}/${product.id}`)).status).toBe(200);
    for (const res of [await s.browser.post(P, { intent: "draft", title: "Another", category: "headphones" }), await s.browser.delete(`${P}/${product.id}`)]) {
      expect(res.status).toBe(403);
      expect(res.body.error.details).toEqual({ reason: "store_suspended" });
    }

    await h.db.prisma.user.update({ where: { id: s.user.id }, data: { role: "ADMIN", adminRoles: ["SUPPORT"] } });
    expect((await s.browser.get(P)).body.error.details).toEqual({ reason: "admin_account" });
  });

  it("other sellers' products don't exist for you", async () => {
    const a = await sell.seller();
    const b = await sell.seller();
    const product = await sell.publish(a.browser);
    expect((await b.browser.get(`${P}/${product.id}`)).status).toBe(404);
    expect((await b.browser.put(`${P}/${product.id}`, sell.editForm(product, { title: "Stolen headphones" }))).status).toBe(404);
    expect((await b.browser.delete(`${P}/${product.id}`)).status).toBe(404);
    expect((await a.browser.get(`${P}/${product.id}`)).body.product.title).toBe(product.title);
  });
});

describe("Add product", () => {
  it("Save draft needs only a title and a category; it's listed as a draft", async () => {
    const s = await sell.seller();
    const res = await s.browser.post(P, { intent: "draft", title: "Travel bundle", category: "headphones" });
    expect(res.status).toBe(201);
    expect(res.body.product).toMatchObject({ status: "draft", title: "Travel bundle", description: "", variantLabel: "Color", variants: [], photos: [], version: 1, canDelete: true, visibleToShoppers: false, publishedAt: null, shipsFrom: "Manila" });
    expect(res.body.product.category).toEqual({ slug: "headphones", name: "Headphones", parent: { slug: "electronics", name: "Electronics" } });

    const list = await s.browser.get(P);
    expect(list.body.items).toEqual([expect.objectContaining({ productId: res.body.product.id, variantId: null, title: "Travel bundle", status: "draft", sold30d: 0 })]);
    expect(list.body.counts).toEqual({ all: 1, active: 0, drafts: 1, out_of_stock: 0 });
  });

  it("Publish checks everything a shopper will see, each problem next to its field", async () => {
    const s = await sell.seller();
    const empty = await s.browser.post(P, { intent: "publish", title: "Headphones", category: "headphones", description: "Short" });
    expect(empty.status).toBe(400);
    expect(fieldsOf(empty)).toEqual({
      description: "Describe the product in at least 20 characters",
      photos: "Add at least one photo",
      variants: "Add at least one variant with a price and stock"
    });

    const ok = await sell.form(s.browser);
    const variant = (o: object) => [{ name: "Black", priceCentavos: 749_900, stock: 1, ...o }];
    const cases: [object, string, string][] = [
      [{ category: "electronics" }, "category", "Choose a more specific category, like Electronics › Headphones"],
      [{ category: "no-such-category" }, "category", "Choose a category"],
      [{ variants: variant({ compareAtCentavos: 749_900 }) }, "variants.0.compareAtCentavos", "Make the compare-at price higher than the price"],
      [{ variants: variant({ priceCentavos: 50 }) }, "variants.0.priceCentavos", "Use at least ₱1"],
      [{ variants: variant({ stock: -1 }) }, "variants.0.stock", "Stock can't be below 0"],
      [{ variants: [...variant({}), ...variant({ name: "BLACK" })] }, "variants.1.name", "Give each variant a different name"],
      [{ variants: [...variant({ sku: "AB-1" }), ...variant({ name: "Sand", sku: "ab-1" })] }, "variants.1.sku", "Give each variant a different SKU"],
      [{ dealEndsAt: days(2) }, "dealEndsAt", "Add a compare-at price to run a deal"],
      [{ variants: variant({ compareAtCentavos: 999_900 }), dealEndsAt: days(-1) }, "dealEndsAt", "Choose a time in the future"],
      [{ variants: variant({ compareAtCentavos: 999_900 }), dealEndsAt: days(91) }, "dealEndsAt", "A deal can run for up to 90 days"],
      [{ title: "Headphones\u0007" }, "title", "Remove special characters"],
      [{ specs: [{ label: "Battery", value: "40 h" }, { label: "battery", value: "30 h" }] }, "specs.1.label", "Use each label once"],
      [{ variants: variant({ id: randomUUID(), stockWas: 1 }) }, "variants.0.id", "This variant isn't part of the product. Reload and try again."],
      [{ weightGrams: 60_000 }, "weightGrams", "Use at most 50 kg"]
    ];
    for (const [change, path, message] of cases) {
      const res = await s.browser.post(P, { ...ok, ...change });
      expect(res.status, JSON.stringify(change)).toBe(400);
      expect(fieldsOf(res)[path], JSON.stringify(change)).toBe(message);
    }
    expect((await s.browser.post(P, { ...ok, price: 100 })).status).toBe(400); // unknown fields are refused
    expect((await s.browser.post(P, { ...ok, photos: Array.from({ length: 9 }, () => ({ publicId: "vendora/product-photos/x/aaaaaaaaaaaaaaaa" })) })).status).toBe(400);
    expect((await s.browser.get(P)).body.counts.all).toBe(0); // nothing was saved
  });

  it("publishes with photos and variants: hidden while the store is reviewed, then on sale everywhere", async () => {
    const s = await sell.seller();
    const [front, side] = [await sell.upload(s.browser, "product_photo", { format: "png" }), await sell.upload(s.browser, "product_photo", { format: "webp" })];
    const title = `Trailrunner Waterproof Shoes ${randomUUID().slice(0, 6)}`;
    const res = await s.browser.post(P, {
      ...(await sell.form(s.browser)),
      title,
      category: "shoes",
      variantLabel: "Size",
      variants: [
        { name: "US 9", sku: null, priceCentavos: 459_900, stock: 12 },
        { name: "US 10", sku: "trail-10", priceCentavos: 469_900, compareAtCentavos: 529_900, stock: 3 }
      ],
      photos: [{ publicId: front, alt: "Front view" }, { publicId: side }],
      specs: [{ label: "Material", value: "Ripstop nylon" }],
      dealEndsAt: days(2),
      weightGrams: 900,
      expressAvailable: false
    });
    expect(res.status).toBe(201);
    const p = res.body.product as SellerProduct;
    expect(p).toMatchObject({ status: "active", version: 1, variantLabel: "Size", weightGrams: 900, expressAvailable: false, lowStockAlert: true, visibleToShoppers: false, specs: [{ label: "Material", value: "Ripstop nylon" }] });
    expect(p.slug).toBe(title.toLowerCase().replace(/ /g, "-"));
    expect(p.publishedAt).not.toBeNull();
    expect(p.photos.map((ph) => [ph.url, ph.alt])).toEqual([[`https://media.example.test/${front}.png`, "Front view"], [`https://media.example.test/${side}.webp`, null]]);
    expect(p.variants.map((v) => [v.name, v.priceCentavos, v.compareAtCentavos, v.stock])).toEqual([["US 9", 459_900, null, 12], ["US 10", 469_900, 529_900, 3]]);
    expect(p.variants[0]?.sku).toMatch(/^TRAI-WATE-[A-Z0-9]{6}$/); // made up from the title
    expect(p.variants[1]?.sku).toBe("TRAIL-10");
    expect(p.dealEndsAt).not.toBeNull();

    // Shoppers can't see it while the store is under review.
    expect((await (await h.browser()).get(`/api/v1/products/${p.id}`)).status).toBe(404);
    expect((await h.db.prisma.store.update({ where: { id: s.store.id }, data: { status: "APPROVED", approvedAt: new Date() } })).status).toBe("APPROVED");

    const visitor = await h.browser();
    const page = await visitor.get(`/api/v1/products/${p.id}`);
    expect(page.status).toBe(200);
    expect(page.body.product).toMatchObject({ title, variantLabel: "Size", delivery: { expressAvailable: false }, price: { fromCentavos: 459_900 } });
    expect(page.body.product.images[0]).toEqual({ url: `https://media.example.test/${front}.png`, alt: "Front view" });
    expect(page.body.product.images[1].alt).toBe(title); // no description: the title is used
    expect(page.body.product.variants[1]).toMatchObject({ name: "US 10", stock: { status: "low_stock", left: 3 }, savingsPercent: 11 });
    const search = await visitor.get(`/api/v1/products?q=${encodeURIComponent("trailrunner waterproof")}`);
    expect(search.body.items.map((c: { id: string }) => c.id)).toContain(p.id); // the search index fills itself
    expect((await h.db.prisma.productImage.count({ where: { productId: p.id } }))).toBe(2);
  });

  it("photos must be this seller's own uploads, there, and of an allowed type and size", async () => {
    const s = await sell.seller();
    const other = await sell.seller();
    const base = await sell.form(s.browser);
    const theirs = await sell.upload(other.browser, "product_photo");
    const logo = await sell.upload(s.browser, "store_logo");
    const notUploaded = (await s.browser.post("/api/v1/seller/uploads", { purpose: "product_photo" })).body.upload.publicId as string;
    const tooBig = (await s.browser.post("/api/v1/seller/uploads", { purpose: "product_photo" })).body.upload.publicId as string;
    h.media.put({ publicId: tooBig, access: "public", format: "jpg", bytes: 6 * 1024 * 1024, url: "https://media.example.test/big.jpg" });

    const cases: [string, string][] = [
      [theirs, "This upload doesn't belong to your account. Please upload the file again."],
      [logo, "This upload doesn't belong to your account. Please upload the file again."],
      [notUploaded, "We couldn't find that upload. Please upload the file again."],
      [tooBig, "Use JPG, PNG, WEBP up to 5 MB."]
    ];
    for (const [publicId, message] of cases) {
      const res = await s.browser.post(P, { ...base, photos: [...base.photos, { publicId }] });
      expect(res.status).toBe(400);
      expect(fieldsOf(res)).toEqual({ "photos.1.publicId": message });
    }
    expect(h.media.removed).toContain(tooBig); // a file that breaks the rules is deleted

    // One stored file is one photo: the same upload can't be used by a second product.
    const first = await s.browser.post(P, base);
    expect(first.status).toBe(201);
    const again = await s.browser.post(P, { ...(await sell.form(s.browser)), photos: base.photos });
    expect(again.status).toBe(400);
    expect(fieldsOf(again)).toEqual({ "photos.0.publicId": "This photo is already used. Upload it again." });
  });

  it("SKUs are unique in the store (another store may reuse one), and an empty one is made up", async () => {
    const s = await sell.seller();
    await sell.publish(s.browser, { variants: [{ name: "Black", sku: "AURA-1", priceCentavos: 100_000, stock: 1 }] });
    const dup = await s.browser.post(P, await sell.form(s.browser, { variants: [{ name: "Sand", sku: "aura-1", priceCentavos: 100_000, stock: 1 }] }));
    expect(dup.status).toBe(400);
    expect(fieldsOf(dup)).toEqual({ "variants.0.sku": "This SKU is already used in your store" });
    // A demo store's SKU is fine in a different store.
    expect((await s.browser.post(P, await sell.form(s.browser, { variants: [{ name: "Toner", sku: "GL-TONER-150", priceCentavos: 100_000, stock: 1 }] }))).status).toBe(201);
  });

  it("product photos have their own allowance: 120 upload tickets an hour, apart from logos and documents", async () => {
    const s = await sell.seller();
    const ticket = await s.browser.post("/api/v1/seller/uploads", { purpose: "product_photo" });
    expect(ticket.body.upload).toMatchObject({ allowedFormats: ["jpg", "png", "webp"], maxBytes: 5 * 1024 * 1024, fields: expect.objectContaining({ type: "upload" }) });
    expect(ticket.body.upload.publicId).toMatch(new RegExp(`^vendora/product-photos/${s.user.id}/[A-Za-z0-9_-]{16}$`));
    for (let i = 1; i < 120; i++) expect((await s.browser.post("/api/v1/seller/uploads", { purpose: "product_photo" })).status).toBe(200);
    expect((await s.browser.post("/api/v1/seller/uploads", { purpose: "product_photo" })).status).toBe(429);
    expect((await s.browser.post("/api/v1/seller/uploads", { purpose: "store_logo" })).status).toBe(200); // a separate allowance
  });

  it("the product form may be large (64 KB); more is refused", async () => {
    const s = await sell.seller();
    const big = await sell.form(s.browser, {
      description: "Malinis at matibay na headphones — ".repeat(140).slice(0, 5000),
      specs: Array.from({ length: 30 }, (_, i) => ({ label: `Spec ${i} ✓`, value: "Ñ".repeat(200) })),
      variants: Array.from({ length: 30 }, (_, i) => ({ name: `Variant ${i}`, sku: `BIG-${randomUUID().slice(0, 8)}-${i}`, priceCentavos: 100_000 + i, stock: i }))
    });
    expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(20_000);
    const res = await s.browser.post(P, big);
    expect(res.status).toBe(201);
    expect(res.body.product.variants).toHaveLength(30);
    const huge = await s.browser.post(P, { ...big, description: "x".repeat(70_000) });
    expect(huge.status).toBe(413);
    // Other routes keep the 10 KB limit.
    expect((await s.browser.put("/api/v1/seller/store", { name: "x".repeat(11_000), category: "electronics", shipsFrom: "Manila" })).status).toBe(413);
  });
});

describe("Edit product", () => {
  it("saves the form, raises the version and refuses an out-of-date form", async () => {
    const s = await sell.seller();
    const p = await sell.publish(s.browser);
    const res = await s.browser.put(`${P}/${p.id}`, sell.editForm(p, { title: "AuraSound Pro 2", specs: [{ label: "Battery", value: "40 hours" }] }));
    expect(res.status).toBe(200);
    expect(res.body.product).toMatchObject({ title: "AuraSound Pro 2", slug: "aurasound-pro-2", version: 2, specs: [{ label: "Battery", value: "40 hours" }], publishedAt: p.publishedAt });

    const stale = await s.browser.put(`${P}/${p.id}`, sell.editForm(p, { title: "From an old tab" }));
    expect(stale.status).toBe(409);
    expect(stale.body.error.details).toEqual({ reason: "stale" });
    expect((await s.browser.put(`${P}/${p.id}`, { ...sell.editForm(p), version: undefined })).status).toBe(400);
    expect((await s.browser.get(`${P}/${p.id}`)).body.product.title).toBe("AuraSound Pro 2");

    // A sale changes the product row (sold count) but not its version, so it never blocks an edit.
    await h.db.prisma.product.update({ where: { id: p.id }, data: { soldCount: { increment: 1 } } });
    expect((await s.browser.put(`${P}/${p.id}`, sell.editForm(res.body.product, { title: "AuraSound Pro 3" }))).status).toBe(200);
  });

  it("applies a stock change as a difference, so units sold while editing still count", async () => {
    const s = await sell.seller({ approve: true });
    const sku = `STK-${randomUUID().slice(0, 8)}`;
    const p = await sell.publish(s.browser, { variants: [{ name: "Black", sku, priceCentavos: 100_000, stock: 9 }] });
    const form = sell.editForm(p); // the seller opens the form: 9 in stock

    const buyer = await shop.shopper();
    await shop.order(buyer, [[sku.toUpperCase(), 2]]); // meanwhile, 2 are sold
    const v = form.variants[0] as Record<string, unknown>;
    const res = await s.browser.put(`${P}/${p.id}`, { ...form, variants: [{ ...v, stock: 42 }] }); // "9 → 42" = 33 more
    expect(res.status).toBe(200);
    expect(res.body.product.variants[0].stock).toBe(40);

    // Lowering past what's left now is refused, with the real number.
    const next = sell.editForm(res.body.product);
    await shop.order(await shop.shopper(), [[sku.toUpperCase(), 2]]); // 38 left
    const low = await s.browser.put(`${P}/${p.id}`, { ...next, variants: [{ ...(next.variants[0] as object), stock: 1 }] }); // "40 → 1" = 39 fewer
    expect(low.status).toBe(409);
    expect(low.body.error.details).toEqual({ reason: "stock_changed" });
    expect(fieldsOf(low)).toEqual({ "variants.0.stock": "Only 38 left now (some sold while you were editing). Check the stock and save again." });
    expect((await h.db.prisma.productVariant.findFirstOrThrow({ where: { sku: sku.toUpperCase() } })).stock).toBe(38);
  });

  it("variants: add, rename, remove; one that sold is hidden (not deleted) and its order still shows it", async () => {
    const s = await sell.seller({ approve: true });
    const id = randomUUID().slice(0, 6).toUpperCase();
    const p = await sell.publish(s.browser, {
      variants: ["Black", "Sand", "Silver"].map((name, i) => ({ name, sku: `V${i}-${id}`, priceCentavos: 100_000, stock: 5 }))
    });
    const buyer = await shop.shopper();
    const order = await shop.order(buyer, [[`V1-${id}`, 1]]); // Sand sold once
    const [black] = sell.editForm(p).variants;

    const res = await s.browser.put(`${P}/${p.id}`, sell.editForm(p, { variants: [{ ...(black as object), name: "Midnight Black" }, { name: "Coral", sku: `V3-${id}`, priceCentavos: 110_000, stock: 7 }] }));
    expect(res.status).toBe(200);
    expect(res.body.product.variants.map((v: { name: string }) => v.name)).toEqual(["Midnight Black", "Coral"]);
    const sand = await h.db.prisma.productVariant.findFirst({ where: { sku: `V1-${id}` } });
    expect(sand?.isActive).toBe(false); // hidden: an order points at it
    expect(await h.db.prisma.productVariant.findFirst({ where: { sku: `V2-${id}` } })).toBeNull(); // never sold: deleted
    expect((await buyer.browser.get(`/api/v1/orders/${order.id}`)).body.order.packages[0].items[0].variantName).toBe("Sand");
    const page = await (await h.browser()).get(`/api/v1/products/${p.id}`);
    expect(page.body.product.variants.map((v: { name: string }) => v.name)).toEqual(["Midnight Black", "Coral"]);
    expect((await s.browser.get(P)).body.items.map((r: { variantName: string }) => r.variantName)).toEqual(["Midnight Black", "Coral"]);
  });

  it("photos: reorder, add, remove; a removed file is deleted unless a past order shows it", async () => {
    const s = await sell.seller({ approve: true });
    const sku = `PH-${randomUUID().slice(0, 8)}`.toUpperCase();
    const [one, two] = [await sell.upload(s.browser, "product_photo"), await sell.upload(s.browser, "product_photo")];
    const p = await sell.publish(s.browser, { variants: [{ name: "Black", sku, priceCentavos: 100_000, stock: 5 }], photos: [{ publicId: one }, { publicId: two }] });
    await shop.order(await shop.shopper(), [[sku, 1]]); // the order keeps the cover photo (one)

    const three = await sell.upload(s.browser, "product_photo");
    const [, second] = p.photos;
    const res = await s.browser.put(`${P}/${p.id}`, sell.editForm(p, { photos: [{ id: second?.id, alt: "Side" }, { publicId: three }] }));
    expect(res.status).toBe(200);
    expect(res.body.product.photos.map((ph: { url: string; alt: string | null }) => [ph.url, ph.alt])).toEqual([[`https://media.example.test/${two}.jpg`, "Side"], [`https://media.example.test/${three}.jpg`, null]]);
    expect(h.media.removed).not.toContain(one); // a past order still shows it

    const res2 = await s.browser.put(`${P}/${p.id}`, sell.editForm(res.body.product, { photos: [{ publicId: await sell.upload(s.browser, "product_photo") }] }));
    expect(res2.status).toBe(200);
    expect(h.media.removed).toEqual(expect.arrayContaining([two, three]));
    const unknown = await s.browser.put(`${P}/${p.id}`, sell.editForm(res2.body.product, { photos: [{ id: second?.id }] }));
    expect(fieldsOf(unknown)).toEqual({ "photos.0.id": "This photo was removed meanwhile. Reload and try again." });
  });

  it("the Active toggle hides a published product (carts too); it can't go back to being a draft", async () => {
    const s = await sell.seller({ approve: true });
    const sku = `ACT-${randomUUID().slice(0, 8)}`.toUpperCase();
    const p = await sell.publish(s.browser, { variants: [{ name: "Black", sku, priceCentavos: 100_000, stock: 5 }] });
    const buyer = await shop.shopper();
    await shop.addToCart(buyer.browser, [[sku, 1]]);

    const off = await s.browser.put(`${P}/${p.id}`, sell.editForm(p, { active: false }));
    expect(off.body.product).toMatchObject({ status: "inactive", active: false, visibleToShoppers: false });
    expect((await (await h.browser()).get(`/api/v1/products/${p.id}`)).status).toBe(404);
    expect((await buyer.browser.get("/api/v1/cart")).body.cart.groups[0].items[0].issue).toBe("unavailable");
    expect((await s.browser.get(P)).body.items[0].status).toBe("inactive");

    const draft = await s.browser.put(`${P}/${p.id}`, sell.editForm(off.body.product, { intent: "draft" }));
    expect(draft.status).toBe(409);
    expect(draft.body.error.details).toEqual({ reason: "already_published" });

    const on = await s.browser.put(`${P}/${p.id}`, sell.editForm(off.body.product, { active: true }));
    expect(on.body.product).toMatchObject({ status: "active", visibleToShoppers: true, publishedAt: p.publishedAt });
    expect((await (await h.browser()).get(`/api/v1/products/${p.id}`)).status).toBe(200);
  });

  it("a deal shows its countdown; once it's over, the form shows the regular price", async () => {
    const s = await sell.seller({ approve: true });
    const ends = days(2);
    const p = await sell.publish(s.browser, { variants: [{ name: "Black", priceCentavos: 599_900, compareAtCentavos: 799_900, stock: 5 }], dealEndsAt: ends });
    const page = await (await h.browser()).get(`/api/v1/products/${p.id}`);
    expect(page.body.product.price).toMatchObject({ fromCentavos: 599_900, compareAtCentavos: 799_900, savingsPercent: 25, dealEndsAt: ends });
    const deals = await (await h.browser()).get(`/api/v1/products?deal=true&store=${s.store.slug}`);
    expect(deals.body.items.map((c: { id: string; saleEndsAt: string }) => [c.id, c.saleEndsAt])).toEqual([[p.id, new Date(ends).toISOString()]]);

    await h.db.prisma.productVariant.updateMany({ where: { productId: p.id }, data: { saleEndsAt: new Date(Date.now() - 60_000) } });
    const form = (await s.browser.get(`${P}/${p.id}`)).body.product;
    expect(form).toMatchObject({ dealEndsAt: null, variants: [expect.objectContaining({ priceCentavos: 799_900, compareAtCentavos: null })] });
    expect((await s.browser.put(`${P}/${p.id}`, sell.editForm(form))).status).toBe(200); // saving it as shown is valid
  });

  it("a product Vendora removed can't be changed or deleted", async () => {
    const s = await sell.seller();
    const p = await sell.publish(s.browser);
    await h.db.prisma.product.update({ where: { id: p.id }, data: { status: "REMOVED" } });
    expect((await s.browser.get(`${P}/${p.id}`)).body.product).toMatchObject({ status: "removed", canDelete: false });
    for (const res of [await s.browser.put(`${P}/${p.id}`, sell.editForm(p)), await s.browser.delete(`${P}/${p.id}`)]) {
      expect(res.status).toBe(403);
      expect(res.body.error.details).toEqual({ reason: "removed_by_vendora" });
    }
  });
});

describe("Delete product", () => {
  it("deletes a product that never sold, with its photos and saves; one with orders can't be deleted", async () => {
    const s = await sell.seller({ approve: true });
    const p = await sell.publish(s.browser);
    const fan = await shop.shopper();
    expect((await fan.browser.put(`/api/v1/wishlist/${p.id}`)).status).toBe(200);
    const res = await s.browser.delete(`${P}/${p.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: p.id, deleted: true });
    expect(h.media.removed).toContain(p.photos[0]?.url.replace("https://media.example.test/", "").replace(/\.jpg$/, ""));
    expect((await s.browser.get(`${P}/${p.id}`)).status).toBe(404);
    expect((await fan.browser.get("/api/v1/wishlist")).body.count).toBe(0);

    const sku = `DEL-${randomUUID().slice(0, 8)}`.toUpperCase();
    const sold = await sell.publish(s.browser, { variants: [{ name: "Black", sku, priceCentavos: 100_000, stock: 5 }] });
    await shop.order(await shop.shopper(), [[sku, 1]]);
    expect((await s.browser.get(`${P}/${sold.id}`)).body.product.canDelete).toBe(false);
    const refused = await s.browser.delete(`${P}/${sold.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.details).toEqual({ reason: "has_orders" });
  });
});

describe("Products list", () => {
  it("one row per variant: tabs that add up, search by name or SKU, category, sold in 30 days, low stock", async () => {
    const s = await sell.seller({ approve: true });
    const id = randomUUID().slice(0, 6).toUpperCase();
    await s.browser.post(P, { intent: "draft", title: "Bundle draft", category: "speakers" });
    const live = await sell.publish(s.browser, {
      title: "Boom Mini Portable Speaker",
      category: "speakers",
      variants: [
        { name: "Blue", sku: `BOOM-BLU-${id}`, priceCentavos: 249_900, stock: 9 },
        { name: "Coral", sku: `BOOM-CRL-${id}`, priceCentavos: 249_900, stock: 0 }
      ]
    });
    const hidden = await sell.publish(s.browser, { title: "QuietWave Travel ANC", active: false, variants: [{ name: "Black", sku: `QW_${id}`, priceCentavos: 599_900, stock: 4 }] });
    await shop.order(await shop.shopper(), [[`BOOM-BLU-${id}`, 2]]);

    const all = (await s.browser.get(P)).body;
    expect(all.counts).toEqual({ all: 4, active: 1, drafts: 1, out_of_stock: 1 });
    expect(all.items.map((r: { title: string; variantName: string | null; status: string; stockLeft: number | null; sold30d: number }) => [r.title, r.variantName, r.status, r.stockLeft, r.sold30d])).toEqual([
      ["QuietWave Travel ANC", "Black", "inactive", 4, 0],
      ["Boom Mini Portable Speaker", "Blue", "active", 7, 2],
      ["Boom Mini Portable Speaker", "Coral", "out_of_stock", null, 0],
      ["Bundle draft", null, "draft", null, 0]
    ]);
    expect(all.items[1]).toMatchObject({ productId: live.id, sku: `BOOM-BLU-${id}`, priceCentavos: 249_900, stock: 7, image: { url: live.photos[0]?.url, alt: null } });

    const rows = async (query: string) => (await s.browser.get(`${P}?${query}`)).body.items.map((r: { variantName: string | null }) => r.variantName);
    expect(await rows("tab=active")).toEqual(["Blue"]);
    expect(await rows("tab=out_of_stock")).toEqual(["Coral"]);
    expect(await rows("tab=drafts")).toEqual([null]);
    expect(await rows(`q=${encodeURIComponent(`boom-crl-${id}`)}`)).toEqual(["Coral"]); // SKU, any case
    expect(await rows("q=portable")).toEqual(["Blue", "Coral"]); // name
    expect(await rows("q=%25")).toEqual([]); // "%" is a character, not "anything"
    expect(await rows(`q=${encodeURIComponent(`QW_${id}`)}`)).toEqual(["Black"]);
    expect(await rows("category=speakers")).toEqual(["Blue", "Coral", null]);
    expect(await rows("category=electronics")).toHaveLength(4); // a top-level category includes its sub-categories
    expect(await rows("category=fashion")).toEqual([]);
    expect(await rows("category=fashion&category=speakers")).toEqual(["Blue", "Coral", null]);
    expect((await s.browser.get(`${P}?tab=everything`)).status).toBe(400);
    expect((await s.browser.get(`${P}/${hidden.id}`)).body.product.status).toBe("inactive");
  });

  it("pages of 20", async () => {
    const s = await sell.seller();
    for (let i = 0; i < 21; i++) expect((await s.browser.post(P, { intent: "draft", title: `Draft ${i}`, category: "headphones" })).status).toBe(201);
    const first = (await s.browser.get(P)).body;
    expect(first).toMatchObject({ page: 1, pageSize: 20, totalItems: 21, totalPages: 2 });
    expect(first.items[0].title).toBe("Draft 20"); // newest first
    const second = (await s.browser.get(`${P}?page=2`)).body;
    expect(second.items.map((r: { title: string }) => r.title)).toEqual(["Draft 0"]);
  });
});

describe("Express delivery", () => {
  it("is offered only when every item in a store's package allows it", async () => {
    const s = await sell.seller({ approve: true });
    const id = randomUUID().slice(0, 6).toUpperCase();
    await sell.publish(s.browser, { variants: [{ name: "Black", sku: `EXP-${id}`, priceCentavos: 100_000, stock: 5 }] });
    await sell.publish(s.browser, { expressAvailable: false, variants: [{ name: "Black", sku: `NOEXP-${id}`, priceCentavos: 100_000, stock: 5 }] });
    const buyer = await shop.shopper();
    await shop.addToCart(buyer.browser, [[`EXP-${id}`, 1], ["GL-TONER-150", 1]]);

    const express = (summary: { body: { packages: { store: { slug: string }; delivery: { option: string; options: { option: string; available: boolean }[] } }[] } }, slug: string) =>
      summary.body.packages.find((p) => p.store.slug === slug)?.delivery;
    let summary = await buyer.browser.post("/api/v1/checkout/summary", { addressId: buyer.addressId, delivery: { [s.store.slug]: "EXPRESS" } });
    expect(express(summary, s.store.slug)).toMatchObject({ option: "EXPRESS", options: [{ option: "STANDARD", available: true }, { option: "EXPRESS", available: true }] });

    await shop.addToCart(buyer.browser, [[`NOEXP-${id}`, 1]]); // one item that can't go Express
    expect((await buyer.browser.get("/api/v1/cart")).body.cart.groups.find((g: { store: { slug: string } }) => g.store.slug === s.store.slug).expressAvailable).toBe(false);
    summary = await buyer.browser.post("/api/v1/checkout/summary", { addressId: buyer.addressId, delivery: { [s.store.slug]: "EXPRESS", "glow-lab": "EXPRESS" } });
    expect(express(summary, s.store.slug)).toMatchObject({ option: "STANDARD", options: [{ option: "STANDARD", available: true }, { option: "EXPRESS", available: false }] });
    expect(express(summary, "glow-lab")?.option).toBe("EXPRESS"); // other stores' packages aren't affected

    const place = (delivery: object) =>
      buyer.browser.agent
        .post("/api/v1/orders")
        .set("X-CSRF-Token", buyer.browser.csrfToken)
        .set("Idempotency-Key", randomUUID())
        .send({ addressId: buyer.addressId, delivery, paymentMethod: "COD", expectedTotalCentavos: summary.body.totals.totalCentavos });
    const refused = await place({ [s.store.slug]: "EXPRESS", "glow-lab": "EXPRESS" });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details).toEqual({ reason: "express_unavailable", store: s.store.slug });
    expect(fieldsOf(refused)).toEqual({ [`delivery.${s.store.slug}`]: "Express delivery isn't available for these items" });
    expect((await place({ [s.store.slug]: "STANDARD", "glow-lab": "EXPRESS" })).status).toBe(201);
  });
});
