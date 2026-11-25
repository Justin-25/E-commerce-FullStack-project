-- Milestone 6d: the seller dashboard (store visits) and payouts.

-- Unique visitors per store per day (Philippine days), copied each night from Redis, where they're
-- counted without cookies or personal data (a daily-salted hash of IP + browser, HyperLogLog).
CREATE TABLE "store_daily_visits" (
    "storeId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "visits" INTEGER NOT NULL,

    CONSTRAINT "store_daily_visits_pkey" PRIMARY KEY ("storeId", "day")
);
ALTER TABLE "store_daily_visits" ADD CONSTRAINT "store_daily_visits_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "store_daily_visits" ADD CONSTRAINT "store_daily_visits_visits_chk" CHECK ("visits" >= 0);

-- The payout history's columns, written when the payout is made (a failed payout gives its lines back,
-- but its history row keeps what it was).
ALTER TABLE "payouts" ADD COLUMN "orderCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "payouts" ADD COLUMN "grossCentavos" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "payouts" ADD COLUMN "feesCentavos" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_breakdown_chk" CHECK ("orderCount" >= 0 AND "grossCentavos" >= 0 AND "feesCentavos" >= 0);

-- A paid payout has its date; a failed one says why.
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_status_chk" CHECK (
  ("status" <> 'PAID' OR "paidAt" IS NOT NULL) AND ("status" <> 'FAILED' OR "failureReason" IS NOT NULL)
);

-- One payout in progress per store: a "Request payout" and the Monday payout at the same moment
-- (or two servers) can't both create one.
CREATE UNIQUE INDEX "payouts_one_in_progress_per_store" ON "payouts"("storeId") WHERE "status" = 'PROCESSING';

-- A payout line in the ledger always belongs to a payout and takes money out.
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payout_chk" CHECK ("type" <> 'PAYOUT' OR ("payoutId" IS NOT NULL AND "amountCentavos" < 0));
