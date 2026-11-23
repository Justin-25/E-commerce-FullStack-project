-- Milestone 6b: sellers add and edit products; price-drop emails.

-- "Color", "Size", "Model": what a product's variants differ by (one option per product).
ALTER TABLE "products" ADD COLUMN "variantLabel" VARCHAR(30) NOT NULL DEFAULT 'Color';
ALTER TABLE "products" ADD CONSTRAINT "products_variant_label_chk" CHECK (length(btrim("variantLabel")) BETWEEN 1 AND 30);

-- "Offer Express delivery (+₱129)": a package can go Express only if every item in it allows it.
ALTER TABLE "products" ADD COLUMN "expressAvailable" BOOLEAN NOT NULL DEFAULT true;

-- "Alert me when a variant has fewer than 10 left" (the email itself comes with seller orders, 6c).
ALTER TABLE "products" ADD COLUMN "lowStockAlert" BOOLEAN NOT NULL DEFAULT true;

-- Raised by every seller edit, so an edit made from an out-of-date form is refused. Orders and
-- reviews also change the row (sold count, rating) but not this, so they never block an edit.
ALTER TABLE "products" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "products" ADD CONSTRAINT "products_version_chk" CHECK ("version" >= 1);

-- Up to 8 photos (0 = the cover), and one stored file is never used by two photos.
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_sort_chk" CHECK ("sortOrder" BETWEEN 0 AND 7);
CREATE UNIQUE INDEX "product_images_publicId_key" ON "product_images"("publicId");

-- Price-drop emails: the price we last emailed about (another email needs a lower price).
ALTER TABLE "wishlist_items" ADD COLUMN "notifiedPriceCentavos" INTEGER;
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_notified_chk" CHECK ("notifiedPriceCentavos" IS NULL OR "notifiedPriceCentavos" >= 0);

-- Shoppers can turn price-drop emails off (one-click unsubscribe); at most one such email a day.
ALTER TABLE "users" ADD COLUMN "priceDropEmails" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "users" ADD COLUMN "priceDropEmailedAt" TIMESTAMPTZ(3);

-- The logo's storage id, so a replaced or removed logo can be deleted from storage.
ALTER TABLE "stores" ADD COLUMN "logoPublicId" VARCHAR(255);
