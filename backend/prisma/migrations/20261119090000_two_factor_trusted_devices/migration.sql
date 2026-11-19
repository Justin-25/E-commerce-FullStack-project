-- AlterEnum
ALTER TYPE "SecurityEventType" ADD VALUE 'BACKUP_CODES_RENEWED';

-- CreateTable
CREATE TABLE "trusted_devices" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "userAgent" VARCHAR(512),
    "ipAddress" VARCHAR(45),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "trusted_devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trusted_devices_tokenHash_key" ON "trusted_devices"("tokenHash");

-- CreateIndex
CREATE INDEX "trusted_devices_userId_revokedAt_idx" ON "trusted_devices"("userId", "revokedAt");

-- AddForeignKey
ALTER TABLE "trusted_devices" ADD CONSTRAINT "trusted_devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written safety rules (Prisma cannot express CHECK constraints)
-- Only a SHA-256 hash is ever stored, never the raw cookie token.
ALTER TABLE "trusted_devices" ADD CONSTRAINT "trusted_devices_token_hash_chk" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "trusted_devices" ADD CONSTRAINT "trusted_devices_expiry_chk" CHECK ("expiresAt" > "createdAt");
