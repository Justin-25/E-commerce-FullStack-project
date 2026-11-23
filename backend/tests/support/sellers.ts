import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { approveStore } from "../../src/modules/seller/approval.js";
import type { Browser } from "./browser.js";
import type { CatalogHarness } from "./catalogHarness.js";

const S = "/api/v1/seller";

/**
 * Seller steps for tests: a seller whose store was submitted for review (and optionally
 * approved), product photo uploads, and a valid "Publish" form to start from.
 */
export function sellers(h: CatalogHarness) {
  /** The browser's side of an upload: a ticket from us, then the file "uploaded" to the storage service. */
  async function upload(b: Browser, purpose: "store_logo" | "store_document" | "product_photo", file: { format?: string; bytes?: number } = {}) {
    const res = await b.post(`${S}/uploads`, { purpose });
    expect(res.status).toBe(200);
    const publicId = res.body.upload.publicId as string;
    h.media.upload(publicId, { format: purpose === "store_document" ? "pdf" : "jpg", ...file });
    return publicId;
  }

  /** A seller (2FA on) whose store is submitted for review; `approve` also approves it. */
  async function seller({ approve = false, name = "Ana Reyes" }: { approve?: boolean; name?: string } = {}) {
    const s = await h.signUp({ email: `seller-${randomUUID().slice(0, 8)}@example.com`, name });
    await h.enableTwoFactor(s.browser);
    const storeName = `Ana Audio ${randomUUID().slice(0, 8)}`;
    expect((await s.browser.put(`${S}/store`, { name: storeName, category: "electronics", shipsFrom: "Manila" })).status).toBe(200);
    expect((await s.browser.put(`${S}/store/verification`, { businessType: "INDIVIDUAL", legalName: "Ana Maria Reyes", tin: "123-456-789-000" })).status).toBe(200);
    expect((await s.browser.post(`${S}/store/documents`, { type: "GOV_ID", publicId: await upload(s.browser, "store_document") })).status).toBe(200);
    expect((await s.browser.put(`${S}/store/payout-account`, { method: "GCASH", accountName: "Ana Maria Reyes", accountNumber: "0917 123 4567" })).status).toBe(200);
    expect((await s.browser.post(`${S}/store/submit`)).status).toBe(200);
    const store = await h.db.prisma.store.findUniqueOrThrow({ where: { ownerId: s.user.id }, select: { id: true, slug: true, name: true } });
    if (approve) expect(await approveStore(h.db.prisma, store.slug, null)).toBe("approved");
    return { ...s, store };
  }

  /** A complete "Publish" form (one variant, one new photo), with changes on top. */
  async function form(b: Browser, overrides: Record<string, unknown> = {}) {
    return {
      intent: "publish",
      title: `AuraSound Pro Wireless Headphones ${randomUUID().slice(0, 6)}`,
      category: "headphones",
      description: "Noise-cancelling headphones with a 40-hour battery and memory-foam cushions.",
      variants: [{ name: "Midnight Black", sku: `SKU-${randomUUID().slice(0, 8)}`, priceCentavos: 749_900, stock: 42 }],
      photos: [{ publicId: await upload(b, "product_photo") }],
      ...overrides
    };
  }

  /** Publishes a product (201) and returns it as the Edit form shows it. */
  async function publish(b: Browser, overrides: Record<string, unknown> = {}) {
    const res = await b.post(`${S}/products`, await form(b, overrides));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.product as SellerProduct;
  }

  /** The Edit form's data sent back as-is (what "Save" with no changes sends), with changes on top. */
  function editForm(p: SellerProduct, overrides: Record<string, unknown> = {}) {
    return {
      intent: p.status === "draft" ? "draft" : "publish",
      version: p.version,
      title: p.title,
      category: p.category.slug,
      description: p.description,
      variantLabel: p.variantLabel,
      variants: p.variants.map((v) => ({ id: v.id, name: v.name, sku: v.sku, priceCentavos: v.priceCentavos, compareAtCentavos: v.compareAtCentavos, stock: v.stock, stockWas: v.stock })),
      photos: p.photos.map((ph) => ({ id: ph.id, alt: ph.alt })),
      specs: p.specs,
      dealEndsAt: p.dealEndsAt,
      weightGrams: p.weightGrams,
      active: p.active,
      expressAvailable: p.expressAvailable,
      lowStockAlert: p.lowStockAlert,
      ...overrides
    };
  }

  return { upload, seller, form, publish, editForm };
}

export interface SellerProduct {
  id: string;
  slug: string;
  status: "draft" | "active" | "inactive" | "removed";
  version: number;
  title: string;
  category: { slug: string; name: string; parent: { slug: string; name: string } | null };
  description: string;
  variantLabel: string;
  variants: { id: string; name: string; sku: string; priceCentavos: number; compareAtCentavos: number | null; stock: number }[];
  dealEndsAt: string | null;
  photos: { id: string; url: string; alt: string | null }[];
  specs: { label: string; value: string }[];
  weightGrams: number | null;
  shipsFrom: string | null;
  active: boolean;
  expressAvailable: boolean;
  lowStockAlert: boolean;
  visibleToShoppers: boolean;
  canDelete: boolean;
  publishedAt: string | null;
}
