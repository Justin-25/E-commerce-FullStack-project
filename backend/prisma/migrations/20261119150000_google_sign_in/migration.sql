-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SecurityEventType" ADD VALUE 'GOOGLE_CONNECTED';
ALTER TYPE "SecurityEventType" ADD VALUE 'GOOGLE_DISCONNECTED';

-- DropIndex
DROP INDEX "oauth_accounts_userId_idx";

-- AlterTable
ALTER TABLE "oauth_accounts" ADD COLUMN     "email" VARCHAR(254);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_accounts_userId_provider_key" ON "oauth_accounts"("userId", "provider");
