-- Milestone 7c-1: Support suspends and reactivates accounts (a seller's store with them), and resets
-- two-step verification once the owner confirms from their email.

-- CreateEnum
CREATE TYPE "StoreSuspendedCause" AS ENUM ('ACCOUNT', 'ADMIN', 'WARNINGS');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "suspendedAt" TIMESTAMPTZ(3),
ADD COLUMN "suspendedById" UUID,
ADD COLUMN "suspendedReason" VARCHAR(500);

-- AlterTable
ALTER TABLE "stores" ADD COLUMN "suspendedAt" TIMESTAMPTZ(3),
ADD COLUMN "suspendedCause" "StoreSuspendedCause";

-- CreateTable
CREATE TABLE "two_factor_resets" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "requestedById" UUID,
    "identityCheck" VARCHAR(500) NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "confirmedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "two_factor_resets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "two_factor_resets_tokenHash_key" ON "two_factor_resets"("tokenHash");

-- CreateIndex
CREATE INDEX "two_factor_resets_userId_createdAt_idx" ON "two_factor_resets"("userId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_suspendedById_fkey" FOREIGN KEY ("suspendedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "two_factor_resets" ADD CONSTRAINT "two_factor_resets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "two_factor_resets" ADD CONSTRAINT "two_factor_resets_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Accounts and stores suspended before 7c (none on a fresh database) get a date and a reason.
UPDATE "users" SET "suspendedAt" = "updatedAt", "suspendedReason" = 'Suspended before milestone 7c' WHERE "status" = 'SUSPENDED';
UPDATE "stores" SET "suspendedAt" = "updatedAt", "suspendedCause" = 'ADMIN' WHERE "status" = 'SUSPENDED';

-- A suspended account always says when and why (the user is told the reason).
ALTER TABLE "users" ADD CONSTRAINT "users_suspended_chk" CHECK ("status" <> 'SUSPENDED' OR ("suspendedAt" IS NOT NULL AND "suspendedReason" IS NOT NULL));

-- A suspended store always says when and why (so reactivating an account brings back only the stores it suspended).
ALTER TABLE "stores" ADD CONSTRAINT "stores_suspended_chk" CHECK ("status" <> 'SUSPENDED' OR ("suspendedAt" IS NOT NULL AND "suspendedCause" IS NOT NULL));

-- A reset request is confirmed or cancelled, never both.
ALTER TABLE "two_factor_resets" ADD CONSTRAINT "two_factor_resets_done_chk" CHECK ("confirmedAt" IS NULL OR "cancelledAt" IS NULL);
