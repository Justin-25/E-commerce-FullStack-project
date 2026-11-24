-- Milestone 6c-2: cancelling paid packages (seller, buyer within the hour, automatic) and refunds
-- that are saved first, then sent to PayMongo and retried until they go through.

CREATE TYPE "CancelledBy" AS ENUM ('SELLER', 'BUYER', 'SYSTEM');
CREATE TYPE "CancelReason" AS ENUM ('OUT_OF_STOCK', 'CANNOT_SHIP_TO_ADDRESS', 'BUYER_ASKED', 'BUYER_CANCELLED', 'NOT_SHIPPED_IN_TIME');
CREATE TYPE "RefundReason" AS ENUM ('PACKAGE_CANCELLED', 'DUPLICATE_PAYMENT', 'LATE_PAYMENT_SOLD_OUT');
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- Who cancelled a paid package and why: both or neither, and only on a cancelled package.
-- (Unpaid orders that expire are cancelled without either.)
ALTER TABLE "seller_orders" ADD COLUMN "cancelledBy" "CancelledBy";
ALTER TABLE "seller_orders" ADD COLUMN "cancelReason" "CancelReason";
ALTER TABLE "seller_orders" ADD CONSTRAINT "seller_orders_cancel_chk" CHECK (
  ("cancelledBy" IS NULL) = ("cancelReason" IS NULL) AND ("cancelledBy" IS NULL OR "status" = 'CANCELLED')
);

-- The seller's two warnings before the automatic cancel, each sent once.
ALTER TABLE "seller_orders" ADD COLUMN "lateNotifiedAt" TIMESTAMPTZ(3);
ALTER TABLE "seller_orders" ADD COLUMN "cancelWarnedAt" TIMESTAMPTZ(3);

-- The automatic cancel and the warnings look up packages to ship by their ship-by time.
CREATE INDEX "seller_orders_status_shipBy_idx" ON "seller_orders"("status", "shipBy");

-- Refunds: saved before they're sent; one per cancelled package.
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "sellerOrderId" UUID,
    "amountCentavos" INTEGER NOT NULL,
    "reason" "RefundReason" NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "providerRefundId" VARCHAR(100),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3),
    "lastError" VARCHAR(255),
    "sentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "refunds_sellerOrderId_key" ON "refunds"("sellerOrderId");
CREATE UNIQUE INDEX "refunds_providerRefundId_key" ON "refunds"("providerRefundId");
CREATE INDEX "refunds_paymentId_idx" ON "refunds"("paymentId");
CREATE INDEX "refunds_status_nextAttemptAt_idx" ON "refunds"("status", "nextAttemptAt");

ALTER TABLE "refunds" ADD CONSTRAINT "refunds_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_sellerOrderId_fkey" FOREIGN KEY ("sellerOrderId") REFERENCES "seller_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_chk" CHECK ("amountCentavos" > 0);
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_attempts_chk" CHECK ("attempts" >= 0);
-- A sent refund always has PayMongo's id and the time it was sent.
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_sent_chk" CHECK ("status" <> 'SENT' OR ("providerRefundId" IS NOT NULL AND "sentAt" IS NOT NULL));
