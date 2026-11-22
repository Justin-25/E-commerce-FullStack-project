import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { Browser } from "./browser.js";
import type { CatalogHarness } from "./catalogHarness.js";

export const HOME_ADDRESS = { label: "Home", fullName: "Maria Santos", phone: "0917 123 4567", region: "NCR", city: "Manila", barangay: "Ermita", street: "1350 Taft Avenue", postalCode: "1000" };

/**
 * Shopping steps for tests: a shopper with an address, a cart, placed orders, and the
 * seller's and courier's steps (shipping and delivering come with the Seller Center in
 * milestone 6, so tests set them directly in the database, as the seller's actions will).
 */
export function shopping(h: CatalogHarness) {
  const variantId = async (sku: string) => (await h.db.prisma.productVariant.findFirstOrThrow({ where: { sku }, select: { id: true } })).id;

  /** A signed-in shopper with a saved address. */
  async function shopper(name = "Maria Santos") {
    const s = await h.signUp({ email: `shopper-${randomUUID().slice(0, 8)}@example.com`, name });
    const res = await s.browser.post("/api/v1/addresses", HOME_ADDRESS);
    expect(res.status).toBe(201);
    return { ...s, addressId: res.body.address.id as string };
  }

  async function addToCart(b: Browser, items: [sku: string, quantity: number][]) {
    for (const [sku, quantity] of items) expect((await b.post("/api/v1/cart/items", { variantId: await variantId(sku), quantity })).status).toBe(200);
  }

  /** Cart → checkout → "Place order", like the checkout page does. Returns the placed order. */
  async function order(
    s: { browser: Browser; addressId: string },
    items: [sku: string, quantity: number][],
    opts: { method?: "COD" | "GCASH" | "MAYA" | "CARD"; delivery?: Record<string, "STANDARD" | "EXPRESS"> } = {}
  ) {
    await addToCart(s.browser, items);
    const delivery = opts.delivery ?? {};
    const summary = await s.browser.post("/api/v1/checkout/summary", { addressId: s.addressId, delivery });
    const res = await s.browser.agent
      .post("/api/v1/orders")
      .set("X-CSRF-Token", s.browser.csrfToken)
      .set("Idempotency-Key", randomUUID())
      .send({ addressId: s.addressId, delivery, paymentMethod: opts.method ?? "COD", expectedTotalCentavos: summary.body.totals.totalCentavos });
    expect(res.status).toBe(201);
    return res.body.order as { id: string; number: string; packages: { id: string; store: { slug: string } }[] };
  }

  /** The seller ships a package (milestone 6: "Mark as shipped" with courier and tracking number). */
  async function ship(packageId: string, opts: { courier?: string; trackingNumber?: string; at?: Date } = {}) {
    await h.db.prisma.sellerOrder.update({
      where: { id: packageId },
      data: { status: "SHIPPED", shippedAt: opts.at ?? new Date(), courier: opts.courier ?? "LBC", trackingNumber: opts.trackingNumber ?? "8841 2201" }
    });
  }

  /** The courier delivers every package of an order: cash is collected, and the order is complete. */
  async function deliver(orderId: string, at = new Date()) {
    const { prisma } = h.db;
    const packages = await prisma.sellerOrder.findMany({ where: { orderId }, select: { id: true, shippedAt: true } });
    for (const p of packages) {
      await prisma.sellerOrder.update({ where: { id: p.id }, data: { status: "DELIVERED", shippedAt: p.shippedAt ?? new Date(at.getTime() - 60_000), deliveredAt: at, courier: "LBC", trackingNumber: "8841 2201" } });
    }
    await prisma.payment.updateMany({ where: { orderId, method: "COD", status: "PENDING" }, data: { status: "PAID", paidAt: at } });
    await prisma.order.update({ where: { id: orderId }, data: { status: "COMPLETED" } });
  }

  return { variantId, shopper, addToCart, order, ship, deliver };
}
