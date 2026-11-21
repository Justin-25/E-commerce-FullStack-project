-- Milestone 5a: cart and addresses.

-- "Price changed since you added it": the price the shopper last saw on this cart line
-- (set when added or when the quantity changes). NULL = unknown, so no note is shown.
ALTER TABLE "cart_items" ADD COLUMN "priceAtAddCentavos" INTEGER;
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_price_at_add_chk" CHECK ("priceAtAddCentavos" IS NULL OR "priceAtAddCentavos" >= 0);

-- At most one default address per shopper (a partial unique index; Prisma can't describe it).
CREATE UNIQUE INDEX "addresses_one_default_per_user" ON "addresses"("userId") WHERE "isDefault";

-- Philippine formats, stored normalized: mobile +639XXXXXXXXX and a 4-digit postal code.
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_phone_chk" CHECK ("phone" ~ '^\+639[0-9]{9}$');
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_postal_code_chk" CHECK ("postalCode" ~ '^[0-9]{4}$');
