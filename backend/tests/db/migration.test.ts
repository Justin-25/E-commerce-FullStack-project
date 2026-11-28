/**
 * Applies the real migration SQL to a real PostgreSQL engine (PGlite runs
 * Postgres inside Node — no install, no Docker) and checks that the tables,
 * indexes and safety rules actually exist and work.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "prisma", "migrations");
const migrationSql = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()
  .map((name) => readFileSync(join(MIGRATIONS_DIR, name, "migration.sql"), "utf8"));

let db: PGlite;
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0] as T;
const fails = (sql: string, params: unknown[] = [], pattern?: RegExp) => expect(db.query(sql, params)).rejects.toThrow(pattern);
const hash = (n: number) => n.toString(16).padStart(64, "0");

// --- tiny fixtures -------------------------------------------------------
let seq = 0;
const user = async (email = `user${++seq}@example.com`) =>
  (await one<{ id: string }>(`INSERT INTO users (id, email, name, "updatedAt") VALUES (gen_random_uuid(), $1, 'Test', now()) RETURNING id`, [email])).id;
const store = async (ownerId: string) =>
  (await one<{ id: string }>(`INSERT INTO stores (id, "ownerId", name, slug, "businessType", "updatedAt") VALUES (gen_random_uuid(), $1, 'Store', $2, 'INDIVIDUAL', now()) RETURNING id`, [ownerId, `store-${++seq}`])).id;
const category = async () =>
  (await one<{ id: string }>(`INSERT INTO categories (id, name, slug, "updatedAt") VALUES (gen_random_uuid(), 'Cat', $1, now()) RETURNING id`, [`cat-${++seq}`])).id;
const product = async (storeId: string) =>
  (await one<{ id: string }>(`INSERT INTO products (id, "storeId", "categoryId", title, slug, description, "updatedAt") VALUES (gen_random_uuid(), $1, $2, 'P', $3, 'd', now()) RETURNING id`, [storeId, await category(), `p-${++seq}`])).id;
const variant = async (productId: string, storeId: string, stock = 5, sku = `SKU-${++seq}`) =>
  (await one<{ id: string }>(`INSERT INTO product_variants (id, "productId", "storeId", sku, name, "priceCentavos", stock, "updatedAt") VALUES (gen_random_uuid(), $1, $2, $3, 'V', 749900, $4, now()) RETURNING id`, [productId, storeId, sku, stock])).id;
const order = async (userId: string, subtotal = 749_900, delivery = 0, total = 749_900) =>
  one<{ id: string; orderNumber: number }>(`INSERT INTO orders (id, "userId", "paymentMethod", "subtotalCentavos", "deliveryCentavos", "totalCentavos", "shippingAddress", "updatedAt") VALUES (gen_random_uuid(), $1, 'GCASH', $2, $3, $4, '{}', now()) RETURNING id, "orderNumber"`, [userId, subtotal, delivery, total]);

beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  for (const sql of migrationSql) await db.exec(sql);
}, 60_000);
afterAll(async () => db?.close());

describe("migration structure", () => {
  it("creates all 38 tables (30 from milestone 2 + trusted_devices, refunds, store_daily_visits, two_factor_resets, store_slug_redirects, store_warnings, ai_conversations, ai_messages)", async () => {
    const { n } = await one<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
    expect(n).toBe(38);
  });

  it("really builds every index the migration declares", async () => {
    const all = migrationSql.join("\n");
    // Created by any migration and not dropped by a later one (e.g. 3e replaced oauth_accounts_userId_idx).
    const dropped = new Set([...all.matchAll(/DROP INDEX "([^"]+)"/g)].flatMap((m) => (m[1] ? [m[1]] : [])));
    const declared = [...all.matchAll(/CREATE (?:UNIQUE )?INDEX "([^"]+)"/g)].flatMap((m) => (m[1] && !dropped.has(m[1]) ? [m[1]] : []));
    const { rows } = await db.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`);
    const built = new Set(rows.map((r) => r.indexname));
    expect(declared.length).toBeGreaterThanOrEqual(57);
    expect(declared.filter((name) => !built.has(name))).toEqual([]);
    for (const critical of ["users_email_key", "sessions_refreshTokenHash_key", "product_variants_storeId_sku_key", "payments_providerRef_key", "webhook_events_provider_providerEventId_key", "orders_orderNumber_key", "seller_orders_storeId_status_createdAt_idx"]) {
      expect(built).toContain(critical);
    }
  });

  it("has the 65 foreign keys and 66 safety (CHECK) rules", async () => {
    const fk = await one<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.table_constraints WHERE constraint_schema = 'public' AND constraint_type = 'FOREIGN KEY'`);
    const chk = await one<{ n: number }>(`SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'c' AND conname LIKE '%\\_chk'`);
    expect(fk.n).toBe(65);
    expect(chk.n).toBe(66);
  });
});

describe("accounts", () => {
  it("rejects duplicate and non-lowercase emails", async () => {
    await user("maria@example.com");
    await fails(`INSERT INTO users (id, email, name, "updatedAt") VALUES (gen_random_uuid(), 'maria@example.com', 'X', now())`, [], /unique/i);
    await fails(`INSERT INTO users (id, email, name, "updatedAt") VALUES (gen_random_uuid(), 'Maria2@Example.com', 'X', now())`, [], /users_email_lowercase_chk/);
  });

  it("only stores refresh tokens as SHA-256 hashes", async () => {
    const u = await user();
    await fails(`INSERT INTO sessions (id, "userId", "refreshTokenHash", "familyId", "expiresAt") VALUES (gen_random_uuid(), $1, 'plain-token', gen_random_uuid(), now())`, [u], /sessions_token_hash_chk/);
    await db.query(`INSERT INTO sessions (id, "userId", "refreshTokenHash", "familyId", "expiresAt") VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), now())`, [u, hash(1)]);
  });

  it("allows one store per seller account", async () => {
    const u = await user();
    await store(u);
    await fails(`INSERT INTO stores (id, "ownerId", name, slug, "businessType", "updatedAt") VALUES (gen_random_uuid(), $1, 'Second', 'second', 'INDIVIDUAL', now())`, [u], /unique/i);
  });
});

describe("catalog & stock", () => {
  it("never lets stock or prices go negative, and compare-at must be higher", async () => {
    const s = await store(await user());
    const p = await product(s);
    await fails(`INSERT INTO product_variants (id, "productId", "storeId", sku, name, "priceCentavos", stock, "updatedAt") VALUES (gen_random_uuid(), $1, $2, 'NEG', 'V', 100, -1, now())`, [p, s], /product_variants_stock_chk/);
    await fails(`INSERT INTO product_variants (id, "productId", "storeId", sku, name, "priceCentavos", "compareAtCentavos", "updatedAt") VALUES (gen_random_uuid(), $1, $2, 'CMP', 'V', 749900, 749900, now())`, [p, s], /compare_at_chk/);
  });

  it("keeps SKUs unique per store (but two stores may reuse one)", async () => {
    const s1 = await store(await user());
    const s2 = await store(await user());
    await variant(await product(s1), s1, 1, "SC-AURA-PRO-BLK");
    await expect(variant(await product(s1), s1, 1, "SC-AURA-PRO-BLK")).rejects.toThrow(/unique/i);
    await variant(await product(s2), s2, 1, "SC-AURA-PRO-BLK");
  });

  it("keeps seller product data sane: a variant label, up to 8 photos, one photo per stored file, an edit version", async () => {
    const s = await store(await user());
    const p = await product(s);
    for (const label of ["", "   "]) await fails(`UPDATE products SET "variantLabel" = $2 WHERE id = $1`, [p, label], /products_variant_label_chk/);
    await fails(`UPDATE products SET version = 0 WHERE id = $1`, [p], /products_version_chk/);
    const photo = (sortOrder: number, publicId: string | null) =>
      db.query(`INSERT INTO product_images (id, "productId", url, "publicId", "sortOrder") VALUES (gen_random_uuid(), $1, 'https://x.test/a.jpg', $2, $3)`, [p, publicId, sortOrder]);
    await expect(photo(8, null)).rejects.toThrow(/product_images_sort_chk/);
    await expect(photo(-1, null)).rejects.toThrow(/product_images_sort_chk/);
    await photo(0, "vendora/product-photos/u/aaaaaaaaaaaaaaaa");
    await expect(photo(1, "vendora/product-photos/u/aaaaaaaaaaaaaaaa")).rejects.toThrow(/unique/i);
    await photo(1, null);
    await photo(2, null); // the demo photos have no stored file
    const u = await user();
    await fails(`INSERT INTO wishlist_items ("userId", "productId", "priceAtSaveCentavos", "notifiedPriceCentavos") VALUES ($1, $2, 100, -1)`, [u, p], /wishlist_items_notified_chk/);
  });

  it("can't oversell: the stock update only succeeds while enough is left", async () => {
    const s = await store(await user());
    const v = await variant(await product(s), s, 5);
    const take = (qty: number) => db.query(`UPDATE product_variants SET stock = stock - $2 WHERE id = $1 AND stock >= $2 RETURNING stock`, [v, qty]);
    expect((await take(3)).rows).toEqual([{ stock: 2 }]);
    expect((await take(3)).rows).toEqual([]); // only 2 left → nothing taken
    expect((await one<{ stock: number }>(`SELECT stock FROM product_variants WHERE id = $1`, [v])).stock).toBe(2);
  });
});

describe("orders, reviews & money", () => {
  it("numbers orders from VD-21000 and checks the total adds up", async () => {
    const u = await user();
    const first = await order(u);
    expect(first.orderNumber).toBeGreaterThanOrEqual(21_000);
    await expect(order(u, 1_309_500, 4_900, 1_400_000)).rejects.toThrow(/orders_total_chk/);
    const ok = await order(u, 1_309_500, 4_900, 1_314_400); // ₱13,095 + ₱49 = ₱13,144
    // Unique and increasing — but not gap-free: Postgres doesn't reuse the number
    // a rejected insert already took, so this one is first + 2.
    expect(ok.orderNumber).toBeGreaterThan(first.orderNumber);
  });

  it("allows one 1–5 star review per purchased item", async () => {
    const buyer = await user();
    const s = await store(await user());
    const p = await product(s);
    const v = await variant(p, s);
    const o = await order(buyer);
    const so = await one<{ id: string }>(`INSERT INTO seller_orders (id, "orderId", "storeId", "subtotalCentavos", "deliveryCentavos", "updatedAt") VALUES (gen_random_uuid(), $1, $2, 749900, 0, now()) RETURNING id`, [o.id, s]);
    const item = await one<{ id: string }>(`INSERT INTO order_items (id, "sellerOrderId", "variantId", "productId", "productTitle", "variantName", "unitPriceCentavos", quantity) VALUES (gen_random_uuid(), $1, $2, $3, 'P', 'V', 749900, 1) RETURNING id`, [so.id, v, p]);
    const review = (rating: number) => db.query(`INSERT INTO reviews (id, "productId", "userId", "orderItemId", rating, "updatedAt") VALUES (gen_random_uuid(), $1, $2, $3, $4, now())`, [p, buyer, item.id, rating]);
    await expect(review(6)).rejects.toThrow(/reviews_rating_chk/);
    await review(5);
    await expect(review(4)).rejects.toThrow(/unique/i);
  });

  it("refuses to delete a user who has orders, but cleans up a user's sessions on delete", async () => {
    const buyer = await user();
    await order(buyer);
    await fails(`DELETE FROM users WHERE id = $1`, [buyer], /foreign key/i);
    const quiet = await user();
    await db.query(`INSERT INTO sessions (id, "userId", "refreshTokenHash", "familyId", "expiresAt") VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), now())`, [quiet, hash(2)]);
    await db.query(`DELETE FROM users WHERE id = $1`, [quiet]);
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM sessions WHERE "userId" = $1`, [quiet])).n).toBe(0);
  });

  it("stores each payment webhook only once", async () => {
    const insert = () => db.query(`INSERT INTO webhook_events (id, provider, "providerEventId", type, payload) VALUES (gen_random_uuid(), 'PAYMONGO', 'evt_123', 'payment.paid', '{}')`);
    await insert();
    await expect(insert()).rejects.toThrow(/unique/i);
  });

  it("rejects zero-amount ledger entries and cart quantities outside 1–99", async () => {
    const s = await store(await user());
    await fails(`INSERT INTO ledger_entries (id, "storeId", type, "amountCentavos", "availableAt") VALUES (gen_random_uuid(), $1, 'SALE', 0, now())`, [s], /ledger_entries_amount_chk/);
    const u = await user();
    const cart = await one<{ id: string }>(`INSERT INTO carts (id, "userId", "updatedAt") VALUES (gen_random_uuid(), $1, now()) RETURNING id`, [u]);
    const v = await variant(await product(s), s);
    for (const q of [0, 100]) await fails(`INSERT INTO cart_items ("cartId", "variantId", quantity) VALUES ($1, $2, $3)`, [cart.id, v, q], /cart_items_quantity_chk/);
    await fails(`INSERT INTO cart_items ("cartId", "variantId", quantity, "priceAtAddCentavos") VALUES ($1, $2, 1, -1)`, [cart.id, v], /cart_items_price_at_add_chk/);
  });

  it("admins hold at least one role and nobody else holds any; asking for changes or rejecting needs a note", async () => {
    const u = await user();
    await fails(`UPDATE users SET role = 'ADMIN' WHERE id = $1`, [u], /users_admin_roles_chk/); // an admin without a role
    await fails(`UPDATE users SET "adminRoles" = '{SUPPORT}' WHERE id = $1`, [u], /users_admin_roles_chk/); // a customer with one
    await db.query(`UPDATE users SET role = 'ADMIN', "adminRoles" = '{SUPPORT,FINANCE}' WHERE id = $1`, [u]);
    const s = await store(await user());
    await db.query(`UPDATE stores SET status = 'PENDING', "submittedAt" = now() WHERE id = $1`, [s]);
    for (const status of ["CHANGES_REQUESTED", "REJECTED"]) await fails(`UPDATE stores SET status = $2 WHERE id = $1`, [s, status], /stores_review_note_chk/);
    await db.query(`UPDATE stores SET status = 'CHANGES_REQUESTED', "reviewNote" = 'Please upload a clearer ID.', "reviewedById" = $2, "reviewedAt" = now() WHERE id = $1`, [s, u]);
  });

  it("a suspended account or store says when and why; a 2FA reset request is confirmed or cancelled, never both", async () => {
    const u = await user();
    await fails(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [u], /users_suspended_chk/);
    await fails(`UPDATE users SET status = 'SUSPENDED', "suspendedAt" = now() WHERE id = $1`, [u], /users_suspended_chk/); // no reason
    await db.query(`UPDATE users SET status = 'SUSPENDED', "suspendedAt" = now(), "suspendedReason" = 'Selling counterfeit goods.' WHERE id = $1`, [u]);
    const s = await store(await user());
    await db.query(`UPDATE stores SET status = 'APPROVED', "submittedAt" = now(), "approvedAt" = now() WHERE id = $1`, [s]);
    await fails(`UPDATE stores SET status = 'SUSPENDED', "suspendedAt" = now() WHERE id = $1`, [s], /stores_suspended_chk/); // no cause
    await db.query(`UPDATE stores SET status = 'SUSPENDED', "suspendedAt" = now(), "suspendedCause" = 'ACCOUNT' WHERE id = $1`, [s]);
    await fails(`UPDATE stores SET "suspendedCause" = 'ADMIN' WHERE id = $1`, [s], /stores_suspended_reason_chk/); // Support always says why (7c-2)
    await db.query(`UPDATE stores SET "suspendedCause" = 'ADMIN', "suspendedReason" = 'Counterfeit listings.' WHERE id = $1`, [s]);
    // An old address belongs to one store; it goes when the store goes.
    await db.query(`INSERT INTO store_slug_redirects (slug, "storeId") VALUES ('old-name', $1)`, [s]);
    await fails(`INSERT INTO store_slug_redirects (slug, "storeId") VALUES ('old-name', $1)`, [s], /duplicate key|unique/i);
    const reset = (done: string) =>
      db.query(`INSERT INTO two_factor_resets (id, "userId", "identityCheck", "tokenHash", "expiresAt", "confirmedAt", "cancelledAt") VALUES (gen_random_uuid(), $1, 'Matched the ID on file', md5(random()::text), now() + interval '1 day', ${done})`, [u]);
    await expect(reset("now(), now()")).rejects.toThrow(/two_factor_resets_done_chk/); // confirmed AND cancelled
    await reset("now(), NULL");
    await reset("NULL, now()");
  });

  it("a removed listing says why; a shopper's report has a form reason; one open report per listing per shopper", async () => {
    const s = await store(await user());
    const p = await product(s);
    await fails(`UPDATE products SET status = 'REMOVED' WHERE id = $1`, [p], /products_removed_chk/);
    await db.query(`UPDATE products SET status = 'REMOVED', "removedAt" = now(), "removedReason" = 'Counterfeit (3 buyer reports).' WHERE id = $1`, [p]);
    const shopper = await user();
    const report = (reason: string, extra = "") => db.query(`INSERT INTO product_flags (id, "productId", source, reason, "reporterId"${extra}) VALUES (gen_random_uuid(), $1, 'BUYER_REPORT', $2, $3${extra ? ", now(), 'KEPT'" : ""})`, [p, reason, shopper]);
    await fails(`INSERT INTO product_flags (id, "productId", source, reason, "reporterId") VALUES (gen_random_uuid(), $1, 'BUYER_REPORT', 'I just dislike it', $2)`, [p, shopper], /product_flags_reason_chk/);
    await report("COUNTERFEIT");
    await expect(report("MISLEADING")).rejects.toThrow(/product_flags_one_open_report|unique/i); // a second open one from the same shopper
    await report("MISLEADING", `, "resolvedAt", status`); // a decided one beside it is fine
    await fails(`UPDATE product_flags SET status = 'KEPT' WHERE "productId" = $1 AND status = 'OPEN'`, [p], /product_flags_resolved_chk/);
  });

  it("keeps payouts consistent: one in progress per store, paid has a date and a transfer reference, failed a reason, a payout line takes money out", async () => {
    const s = await store(await user());
    const payout = (reference: string, status = "PROCESSING", extra = "", values: unknown[] = []) =>
      db.query(`INSERT INTO payouts (id, "storeId", reference, "amountCentavos", method, "accountLast4", status, "updatedAt"${extra ? `, ${extra}` : ""}) VALUES (gen_random_uuid(), $1, $2, 10000, 'GCASH', '4567', $3, now()${values.map((_, i) => `, $${i + 4}`).join("")}) RETURNING id`, [s, reference, status, ...values]);
    const first = (await payout("PO-1")).rows[0] as { id: string };
    await expect(payout("PO-2")).rejects.toThrow(/unique/i); // a second one in progress
    await expect(payout("PO-3", "PAID", `"transferReference"`, ["BPI 0001"])).rejects.toThrow(/payouts_status_chk/); // paid without a date
    await expect(payout("PO-3B", "PAID", `"paidAt"`, [new Date()])).rejects.toThrow(/payouts_paid_reference_chk/); // paid without the transfer's reference
    await expect(payout("PO-4", "FAILED")).rejects.toThrow(/payouts_status_chk/); // failed without a reason
    await expect(payout("PO-5", "PAID", `"paidAt", "transferReference", "orderCount"`, [new Date(), "BPI 0001", -1])).rejects.toThrow(/payouts_breakdown_chk/);
    await payout("PO-6", "PAID", `"paidAt", "transferReference"`, [new Date(), "BPI 0002"]); // a paid one beside the one in progress is fine
    const line = (amount: number, payoutId: string | null) =>
      db.query(`INSERT INTO ledger_entries (id, "storeId", "payoutId", type, "amountCentavos", "availableAt") VALUES (gen_random_uuid(), $1, $2, 'PAYOUT', $3, now())`, [s, payoutId, amount]);
    await expect(line(-10_000, null)).rejects.toThrow(/ledger_entries_payout_chk/);
    await expect(line(10_000, first.id)).rejects.toThrow(/ledger_entries_payout_chk/);
    await line(-10_000, first.id);
    await fails(`INSERT INTO store_daily_visits ("storeId", day, visits) VALUES ($1, current_date, -1)`, [s], /store_daily_visits_visits_chk/);
  });

  it("keeps cancellations and refunds consistent: who and why together, one refund per package, a sent refund says how (PayMongo's id or a transfer's reference)", async () => {
    const s = await store(await user());
    const o = await order(await user());
    const pkg = (await one<{ id: string }>(`INSERT INTO seller_orders (id, "orderId", "storeId", "subtotalCentavos", "deliveryCentavos", "updatedAt") VALUES (gen_random_uuid(), $1, $2, 749900, 0, now()) RETURNING id`, [o.id, s])).id;
    await fails(`UPDATE seller_orders SET "cancelledBy" = 'SELLER' WHERE id = $1`, [pkg], /seller_orders_cancel_chk/); // a reason too
    await fails(`UPDATE seller_orders SET "cancelledBy" = 'SELLER', "cancelReason" = 'OUT_OF_STOCK' WHERE id = $1`, [pkg], /seller_orders_cancel_chk/); // only when cancelled
    await db.query(`UPDATE seller_orders SET status = 'CANCELLED', "cancelledAt" = now(), "cancelledBy" = 'SELLER', "cancelReason" = 'OUT_OF_STOCK' WHERE id = $1`, [pkg]);
    const payment = (await one<{ id: string }>(`INSERT INTO payments (id, "orderId", provider, method, "amountCentavos", status, "updatedAt") VALUES (gen_random_uuid(), $1, 'PAYMONGO', 'GCASH', 749900, 'PAID', now()) RETURNING id`, [o.id])).id;
    const refund = (amount: number, extra = "", values: unknown[] = []) =>
      db.query(`INSERT INTO refunds (id, "paymentId", "sellerOrderId", "amountCentavos", reason, "updatedAt"${extra ? `, ${extra}` : ""}) VALUES (gen_random_uuid(), $1, $2, $3, 'PACKAGE_CANCELLED', now()${values.map((_, i) => `, $${i + 4}`).join("")})`, [payment, pkg, amount, ...values]);
    await expect(refund(0)).rejects.toThrow(/refunds_amount_chk/);
    await expect(refund(749_900, `status, "sentAt"`, ["SENT", new Date()])).rejects.toThrow(/refunds_sent_chk/);
    await refund(749_900);
    await expect(refund(100)).rejects.toThrow(/unique/i); // one refund per package
    // Sent (7b): by our PayMongo call or a refund made in PayMongo's dashboard (PayMongo's id), or by another transfer (its reference).
    const r = (await one<{ id: string }>(`SELECT id FROM refunds WHERE "sellerOrderId" = $1`, [pkg])).id;
    const sent = (set: string) => db.query(`UPDATE refunds SET status = 'SENT', "sentAt" = now(), ${set} WHERE id = $1`, [r]);
    await expect(sent(`"providerRefundId" = 'ref_abc123'`)).rejects.toThrow(/refunds_sent_chk/); // how it was sent is missing
    await expect(sent(`"sentVia" = 'PAYMONGO_DASHBOARD'`)).rejects.toThrow(/refunds_sent_chk/); // no PayMongo id
    await expect(sent(`"sentVia" = 'OTHER_TRANSFER', "providerRefundId" = 'ref_abc123'`)).rejects.toThrow(/refunds_sent_chk/); // no transfer reference
    await sent(`"sentVia" = 'OTHER_TRANSFER', "manualReference" = 'GCASH 9012 3456'`);
  });

  it("keeps shipping and earnings consistent: tracking for shipped packages, one tracking number per package, one sale per package", async () => {
    const s = await store(await user());
    const o = await order(await user());
    const pkg = async () =>
      (await one<{ id: string }>(`INSERT INTO seller_orders (id, "orderId", "storeId", "subtotalCentavos", "deliveryCentavos", "updatedAt") VALUES (gen_random_uuid(), $1, $2, 749900, 0, now()) RETURNING id`, [o.id, s])).id;
    const a = await pkg();
    // Shipped without a courier or tracking number, or delivered without a delivery time: refused.
    await fails(`UPDATE seller_orders SET status = 'SHIPPED', "shippedAt" = now() WHERE id = $1`, [a], /seller_orders_shipped_chk/);
    await fails(`UPDATE seller_orders SET status = 'DELIVERED', "shippedAt" = now(), courier = 'LBC', "trackingNumber" = 'LBC123456' WHERE id = $1`, [a], /seller_orders_delivered_chk/);
    await fails(`UPDATE seller_orders SET "packageWeightGrams" = 0 WHERE id = $1`, [a], /seller_orders_weight_chk/);
    await db.query(`UPDATE seller_orders SET status = 'SHIPPED', "shippedAt" = now(), courier = 'LBC', "trackingNumber" = 'LBC123456', "packageWeightGrams" = 900 WHERE id = $1`, [a]);
    // Another package can't use the same courier's tracking number (another courier's is fine).
    const b = await (async () => {
      const otherStore = await store(await user());
      return (await one<{ id: string }>(`INSERT INTO seller_orders (id, "orderId", "storeId", "subtotalCentavos", "deliveryCentavos", "updatedAt") VALUES (gen_random_uuid(), $1, $2, 100, 0, now()) RETURNING id`, [o.id, otherStore])).id;
    })();
    await expect(db.query(`UPDATE seller_orders SET courier = 'LBC', "trackingNumber" = 'LBC123456' WHERE id = $1`, [b])).rejects.toThrow(/unique/i);
    await db.query(`UPDATE seller_orders SET courier = 'Ninja Van', "trackingNumber" = 'LBC123456' WHERE id = $1`, [b]);
    // One SALE and one FEE line per package; refunds and adjustments may repeat.
    const line = (type: string, amount: number) =>
      db.query(`INSERT INTO ledger_entries (id, "storeId", "sellerOrderId", type, "amountCentavos", "availableAt") VALUES (gen_random_uuid(), $1, $2, $3, $4, now())`, [s, a, type, amount]);
    await line("SALE", 749_900);
    await expect(line("SALE", 749_900)).rejects.toThrow(/unique/i);
    await line("FEE", -37_495);
    await expect(line("FEE", -37_495)).rejects.toThrow(/unique/i);
    await line("ADJUSTMENT", -100);
    await line("ADJUSTMENT", -100);
  });

  it("starts stores as drafts; a submitted store has a submit time; bank payouts name the bank", async () => {
    const s = await store(await user());
    expect((await one<{ status: string }>(`SELECT status FROM stores WHERE id = $1`, [s])).status).toBe("DRAFT");
    await fails(`UPDATE stores SET status = 'PENDING' WHERE id = $1`, [s], /stores_submitted_chk/);
    await db.query(`UPDATE stores SET status = 'PENDING', "submittedAt" = now() WHERE id = $1`, [s]);
    const payout = (method: string, bank: string | null) =>
      db.query(`INSERT INTO payout_accounts (id, "storeId", method, "bankName", "accountName", "accountNumberEncrypted", last4, "updatedAt") VALUES (gen_random_uuid(), $1, $2, $3, 'Ana', 'v1.x', '4567', now())`, [s, method, bank]);
    await expect(payout("BANK", null)).rejects.toThrow(/payout_accounts_bank_chk/);
    await expect(payout("GCASH", "BPI")).rejects.toThrow(/payout_accounts_bank_chk/);
    await payout("BANK", "BPI");
    await fails(`INSERT INTO store_documents (id, "storeId", type, "fileKey", bytes) VALUES (gen_random_uuid(), $1, 'GOV_ID', 'k', 0)`, [s], /store_documents_bytes_chk/);
  });

  it("allows one default address per shopper, stored in Philippine formats", async () => {
    const u = await user();
    const address = (isDefault: boolean, phone = "+639171234567", postalCode = "1101") =>
      db.query(`INSERT INTO addresses (id, "userId", "fullName", phone, region, city, barangay, street, "postalCode", "isDefault", "updatedAt") VALUES (gen_random_uuid(), $1, 'Maria Santos', $2, 'NCR', 'Quezon City', 'Diliman', '12 Maginhawa St.', $3, $4, now())`, [u, phone, postalCode, isDefault]);
    await address(true);
    await address(false);
    await expect(address(true)).rejects.toThrow(/addresses_one_default_per_user|unique/i);
    for (const phone of ["09171234567", "+63917123456", "+639171234567x"]) await expect(address(false, phone)).rejects.toThrow(/addresses_phone_chk/);
    for (const code of ["110", "11011", "A101"]) await expect(address(false, "+639171234567", code)).rejects.toThrow(/addresses_postal_code_chk/);
  });
});
