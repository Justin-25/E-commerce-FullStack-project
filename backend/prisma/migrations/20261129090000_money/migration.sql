-- Milestone 7b: Finance marks payouts paid (with the transfer's reference) or failed, and closes refunds
-- PayMongo kept refusing: by a refund made in PayMongo's dashboard, or by another transfer.

-- CreateEnum
CREATE TYPE "RefundSentVia" AS ENUM ('PAYMONGO_API', 'PAYMONGO_DASHBOARD', 'OTHER_TRANSFER');

-- AlterTable
ALTER TABLE "payouts" ADD COLUMN "handledById" UUID,
ADD COLUMN "transferReference" VARCHAR(100);

-- AlterTable
ALTER TABLE "refunds" ADD COLUMN "handledById" UUID,
ADD COLUMN "manualReference" VARCHAR(100),
ADD COLUMN "sentVia" "RefundSentVia";

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_handledById_fkey" FOREIGN KEY ("handledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_handledById_fkey" FOREIGN KEY ("handledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Refunds sent before 7b went through our PayMongo call; payouts paid before it (the demo history,
-- simulated) get a "DEMO-" reference so every paid payout has one.
UPDATE "refunds" SET "sentVia" = 'PAYMONGO_API' WHERE "status" = 'SENT';
UPDATE "payouts" SET "transferReference" = 'DEMO-' || "reference" WHERE "status" = 'PAID';

-- A sent refund says how: PayMongo (with PayMongo's refund id) or another transfer (with its reference).
-- ("sentVia" IS NOT NULL first: with a NULL, the IN below would be unknown, and a CHECK lets unknown through.)
ALTER TABLE "refunds" DROP CONSTRAINT "refunds_sent_chk";
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_sent_chk" CHECK (
  "status" <> 'SENT' OR (
    "sentAt" IS NOT NULL AND "sentVia" IS NOT NULL AND (
      ("sentVia" IN ('PAYMONGO_API', 'PAYMONGO_DASHBOARD') AND "providerRefundId" IS NOT NULL)
      OR ("sentVia" = 'OTHER_TRANSFER' AND "manualReference" IS NOT NULL)
    )
  )
);

-- A paid payout can be matched to the bank or GCash statement.
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_paid_reference_chk" CHECK ("status" <> 'PAID' OR "transferReference" IS NOT NULL);
