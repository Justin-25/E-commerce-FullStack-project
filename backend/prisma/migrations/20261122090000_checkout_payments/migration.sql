-- Milestone 5b: checkout and PayMongo payments.

-- "Place order" sent twice (double click, retry after a timeout) must give ONE order:
-- the browser sends the same key, and the database refuses a second order with it.
ALTER TABLE "orders" ADD COLUMN "idempotencyKey" VARCHAR(64);
CREATE UNIQUE INDEX "orders_userId_idempotencyKey_key" ON "orders"("userId", "idempotencyKey");
ALTER TABLE "orders" ADD CONSTRAINT "orders_idempotency_key_chk" CHECK ("idempotencyKey" IS NULL OR length("idempotencyKey") BETWEEN 8 AND 64);

-- Each payment attempt: providerRef = PayMongo's checkout session (cs_…), plus the payment
-- that settled it (pay_…, needed for refunds) and the page to send the shopper back to.
ALTER TABLE "payments" ADD COLUMN "providerPaymentId" VARCHAR(100);
CREATE UNIQUE INDEX "payments_providerPaymentId_key" ON "payments"("providerPaymentId");
ALTER TABLE "payments" ADD COLUMN "checkoutUrl" VARCHAR(500);
