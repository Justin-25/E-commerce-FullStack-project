-- Milestone 6a, part 2 of 2: becoming a seller (onboarding).

-- New stores start as drafts; only "Submit for review" makes them PENDING.
ALTER TABLE "stores" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

-- What the store sells, chosen in step 1 (a top-level category).
ALTER TABLE "stores" ADD COLUMN "categoryId" UUID;
ALTER TABLE "stores" ADD CONSTRAINT "stores_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "stores_categoryId_idx" ON "stores"("categoryId");

-- When the store was submitted for review. Every store past DRAFT has one
-- (existing stores were set up before onboarding existed: use when they were approved).
ALTER TABLE "stores" ADD COLUMN "submittedAt" TIMESTAMPTZ(3);
UPDATE "stores" SET "submittedAt" = coalesce("approvedAt", "createdAt") WHERE "status" <> 'DRAFT';
ALTER TABLE "stores" ADD CONSTRAINT "stores_submitted_chk" CHECK ("status" = 'DRAFT' OR "submittedAt" IS NOT NULL);

-- Bank payouts need the bank; GCash payouts never have one.
ALTER TABLE "payout_accounts" ADD COLUMN "bankName" VARCHAR(60);
ALTER TABLE "payout_accounts" ADD CONSTRAINT "payout_accounts_bank_chk" CHECK (("method" = 'BANK') = ("bankName" IS NOT NULL));

-- "dti-certificate.pdf · 860 KB": the file's type and size, read from the storage service (never from the browser).
ALTER TABLE "store_documents" ADD COLUMN "format" VARCHAR(10);
ALTER TABLE "store_documents" ADD COLUMN "bytes" INTEGER;
ALTER TABLE "store_documents" ADD CONSTRAINT "store_documents_bytes_chk" CHECK ("bytes" IS NULL OR "bytes" > 0);
