-- Milestone 7c-2: Support suspends (with a reason), reactivates and renames stores; renamed stores keep their old addresses.

-- AlterTable
ALTER TABLE "stores" ADD COLUMN "suspendedReason" VARCHAR(500);

-- CreateTable
CREATE TABLE "store_slug_redirects" (
    "slug" VARCHAR(80) NOT NULL,
    "storeId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_slug_redirects_pkey" PRIMARY KEY ("slug")
);

-- CreateIndex
CREATE INDEX "store_slug_redirects_storeId_idx" ON "store_slug_redirects"("storeId");

-- AddForeignKey
ALTER TABLE "store_slug_redirects" ADD CONSTRAINT "store_slug_redirects_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Stores Support suspended before 7c-2 (none on a fresh database) get a reason.
UPDATE "stores" SET "suspendedReason" = 'Suspended before milestone 7c-2' WHERE "suspendedCause" = 'ADMIN' AND "suspendedReason" IS NULL;

-- A store Support suspended always says why (the seller sees it).
ALTER TABLE "stores" ADD CONSTRAINT "stores_suspended_reason_chk" CHECK ("suspendedCause" IS NULL OR "suspendedCause" <> 'ADMIN' OR "suspendedReason" IS NOT NULL);
