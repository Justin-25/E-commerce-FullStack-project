import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { Browser } from "./browser.js";
import type { CatalogHarness } from "./catalogHarness.js";

export const HOME_ADDRESS = { label: "Home", fullName: "Maria Santos", phone: "0917 123 4567", region: "NCR", city: "Manila", barangay: "Ermita", street: "1350 Taft Avenue", postalCode: "1000" };

/**
 * Shopping steps for tests: a shopper with an address, a cart, placed orders, and the
 * seller's and courier's steps for the demo stores (whose owners can't sign in): `ship` sets
 * the package as "Mark as shipped" would; `deliver` runs the real delivery step (the seller is
 * credited, cash on delivery is collected, the order completes). Seller Center tests use the API.
 */
export function shopping(h: CatalogHarness) {
  const variantId = async (sku: string) => (await h.db.prisma.productVariant.findFirstOrThrow({ where: { sku }, select: { id: true } })).id;

  /** A signed-in shopper with a saved address (in their name). */
  async function shopper(name = "Maria Santos") {
    const s = await h.signUp({ email: `shopper-${randomUUID().slice(0, 8)}@example.com`, name });
    const res = await s.browser.post("/api/v1/addresses", { ...HOME_ADDRESS, fullName: name });
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

  /** A demo store ships a package ("Mark as shipped": courier and a tracking number, unique per courier). */
  async function ship(packageId: string, opts: { courier?: string; trackingNumber?: string; at?: Date } = {}) {
    await h.db.prisma.sellerOrder.update({
      where: { id: packageId },
      data: { status: "SHIPPED", shippedAt: opts.at ?? new Date(), courier: opts.courier ?? "LBC", trackingNumber: opts.trackingNumber ?? trackingNumber() }
    });
  }

  /** Every package of an order arrives and the buyer taps "Order received" (packages not shipped yet are shipped first). */
  async function deliver(orderId: string, at = new Date()) {
    const packages = await h.db.prisma.sellerOrder.findMany({ where: { orderId }, select: { id: true, status: true } });
    for (const p of packages) {
      if (p.status === "PREPARING") await ship(p.id, { at: new Date(at.getTime() - 60_000) });
      expect(await h.delivery().deliver(p.id, at, "BUYER")).toBe(true);
    }
  }

  return { variantId, shopper, addToCart, order, ship, deliver };
}

/** A made-up tracking number ("LBC7F3K29QD10AB"), different every time. */
export const trackingNumber = (prefix = "LBC") => `${prefix}${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
