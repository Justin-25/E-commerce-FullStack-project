-- Milestone 6c: sellers ship their orders, buyers confirm delivery, sellers earn (the ledger),
-- and low-stock emails.

-- Who confirmed the delivery: the buyer ("Order received") or the automatic confirmation 7 days
-- after shipping. Empty for packages delivered before this milestone.
CREATE TYPE "DeliveryConfirmation" AS ENUM ('BUYER', 'AUTO');
ALTER TABLE "seller_orders" ADD COLUMN "deliveryConfirmedBy" "DeliveryConfirmation";

-- "Package weight" from Mark as shipped (optional; printed on the packing slip).
ALTER TABLE "seller_orders" ADD COLUMN "packageWeightGrams" INTEGER;
ALTER TABLE "seller_orders" ADD CONSTRAINT "seller_orders_weight_chk" CHECK ("packageWeightGrams" IS NULL OR "packageWeightGrams" BETWEEN 1 AND 100000);

-- A package that left the seller always has its courier, tracking number and shipping time,
-- and a delivered one its delivery time.
ALTER TABLE "seller_orders" ADD CONSTRAINT "seller_orders_shipped_chk" CHECK (
  "status" NOT IN ('SHIPPED', 'DELIVERED', 'RETURN_REQUESTED', 'RETURNED')
  OR ("shippedAt" IS NOT NULL AND "courier" IS NOT NULL AND "trackingNumber" IS NOT NULL)
);
ALTER TABLE "seller_orders" ADD CONSTRAINT "seller_orders_delivered_chk" CHECK (
  "status" NOT IN ('DELIVERED', 'RETURN_REQUESTED', 'RETURNED') OR "deliveredAt" IS NOT NULL
);

-- One tracking number, one package (per courier): a seller can't "ship" with another package's number.
CREATE UNIQUE INDEX "seller_orders_courier_trackingNumber_key" ON "seller_orders"("courier", "trackingNumber");

-- The automatic confirmation job looks up shipped packages by shipping time.
CREATE INDEX "seller_orders_status_shippedAt_idx" ON "seller_orders"("status", "shippedAt");

-- A package's sale and Vendora's fee are written once: a second confirmation (the buyer and the
-- automatic one at the same moment) can't pay the seller twice.
CREATE UNIQUE INDEX "ledger_entries_one_sale_and_fee_per_package" ON "ledger_entries"("sellerOrderId", "type") WHERE "type" IN ('SALE', 'FEE');

-- Low-stock emails: when the seller was told about this variant's low stock (or set the low number
-- themselves); cleared once it's restocked to 10 or more, so the next drop is news again.
ALTER TABLE "product_variants" ADD COLUMN "lowStockAlertedAt" TIMESTAMPTZ(3);

-- Packages delivered before this milestone earn their sale and fee lines too (available 7 days
-- after delivery, like every sale).
INSERT INTO "ledger_entries" ("id", "storeId", "sellerOrderId", "type", "amountCentavos", "description", "availableAt", "createdAt")
SELECT gen_random_uuid(), so."storeId", so."id", 'SALE', so."subtotalCentavos", 'Sale · VD-' || o."orderNumber", so."deliveredAt" + interval '7 days', so."deliveredAt"
FROM "seller_orders" so JOIN "orders" o ON o."id" = so."orderId"
WHERE so."status" = 'DELIVERED' AND so."subtotalCentavos" > 0;

INSERT INTO "ledger_entries" ("id", "storeId", "sellerOrderId", "type", "amountCentavos", "description", "availableAt", "createdAt")
SELECT gen_random_uuid(), so."storeId", so."id", 'FEE', -so."platformFeeCentavos", 'Vendora fee · VD-' || o."orderNumber", so."deliveredAt" + interval '7 days', so."deliveredAt"
FROM "seller_orders" so JOIN "orders" o ON o."id" = so."orderId"
WHERE so."status" = 'DELIVERED' AND so."platformFeeCentavos" > 0;

-- Variants that are already low today aren't announced: their sellers see them in the products list.
UPDATE "product_variants" SET "lowStockAlertedAt" = now() WHERE "stock" < 10;
