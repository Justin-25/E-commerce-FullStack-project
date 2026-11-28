-- Milestone 7d: shoppers report listings; Moderation keeps or removes them, warns stores, and restores removals.

-- AlterTable
ALTER TABLE "products" ADD COLUMN "removedAt" TIMESTAMPTZ(3),
ADD COLUMN "removedById" UUID,
ADD COLUMN "removedReason" VARCHAR(500);

-- AlterTable
ALTER TABLE "product_flags" ADD COLUMN "orderId" UUID;

-- CreateTable
CREATE TABLE "store_warnings" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "productId" UUID,
    "reason" VARCHAR(500) NOT NULL,
    "issuedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawnAt" TIMESTAMPTZ(3),
    "withdrawnById" UUID,

    CONSTRAINT "store_warnings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "store_warnings_storeId_createdAt_idx" ON "store_warnings"("storeId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_removedById_fkey" FOREIGN KEY ("removedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_flags" ADD CONSTRAINT "product_flags_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_warnings" ADD CONSTRAINT "store_warnings_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_warnings" ADD CONSTRAINT "store_warnings_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_warnings" ADD CONSTRAINT "store_warnings_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_warnings" ADD CONSTRAINT "store_warnings_withdrawnById_fkey" FOREIGN KEY ("withdrawnById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Products removed before 7d (none on a fresh database) get a reason.
UPDATE "products" SET "removedReason" = 'Removed before milestone 7d', "removedAt" = "updatedAt" WHERE "status" = 'REMOVED' AND "removedReason" IS NULL;

-- A listing Vendora removed always says why (the seller sees it).
ALTER TABLE "products" ADD CONSTRAINT "products_removed_chk" CHECK ("status" <> 'REMOVED' OR "removedReason" IS NOT NULL);

-- A shopper's report has one of the reasons on the form; a decided flag says when.
ALTER TABLE "product_flags" ADD CONSTRAINT "product_flags_reason_chk" CHECK ("source" <> 'BUYER_REPORT' OR "reason" IN ('COUNTERFEIT', 'MISLEADING', 'PROHIBITED', 'MISSING_PERMIT', 'OFFENSIVE', 'OTHER'));
ALTER TABLE "product_flags" ADD CONSTRAINT "product_flags_resolved_chk" CHECK ("status" = 'OPEN' OR "resolvedAt" IS NOT NULL);

-- One open report per listing per shopper (sending it twice, or twice at once, makes one).
CREATE UNIQUE INDEX "product_flags_one_open_report" ON "product_flags"("productId", "reporterId") WHERE "status" = 'OPEN' AND "reporterId" IS NOT NULL;
