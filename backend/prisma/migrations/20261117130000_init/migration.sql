-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('CUSTOMER', 'SELLER', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "OAuthProvider" AS ENUM ('GOOGLE');

-- CreateEnum
CREATE TYPE "AuthTokenType" AS ENUM ('EMAIL_VERIFY', 'PASSWORD_RESET', 'EMAIL_CHANGE');

-- CreateEnum
CREATE TYPE "SecurityEventType" AS ENUM ('LOGIN_OK', 'LOGIN_FAILED', 'LOCKED', 'LOGOUT_ALL', 'PASSWORD_CHANGED', 'PASSWORD_RESET', 'EMAIL_CHANGED', 'TWO_FA_ENABLED', 'TWO_FA_DISABLED', 'BACKUP_CODE_USED', 'SESSION_REVOKED', 'TOKEN_REUSE_DETECTED');

-- CreateEnum
CREATE TYPE "StoreStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "BusinessType" AS ENUM ('INDIVIDUAL', 'REGISTERED_BUSINESS');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('GOV_ID', 'DTI_CERT', 'SEC_CERT', 'BIR_2303', 'SELFIE');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PayoutMethod" AS ENUM ('BANK', 'GCASH');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED', 'REMOVED');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PUBLISHED', 'HIDDEN');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT', 'PLACED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('GCASH', 'MAYA', 'CARD', 'COD');

-- CreateEnum
CREATE TYPE "SellerOrderStatus" AS ENUM ('AWAITING_PAYMENT', 'PREPARING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURN_REQUESTED', 'RETURNED');

-- CreateEnum
CREATE TYPE "DeliveryOption" AS ENUM ('STANDARD', 'EXPRESS');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('PAYMONGO', 'COD');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'AWAITING_ACTION', 'PAID', 'FAILED', 'EXPIRED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "LedgerType" AS ENUM ('SALE', 'FEE', 'REFUND', 'PAYOUT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PROCESSING', 'PAID', 'FAILED');

-- CreateEnum
CREATE TYPE "FlagSource" AS ENUM ('BUYER_REPORT', 'AI');

-- CreateEnum
CREATE TYPE "FlagStatus" AS ENUM ('OPEN', 'KEPT', 'REMOVED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "emailVerifiedAt" TIMESTAMPTZ(3),
    "passwordHash" VARCHAR(255),
    "name" VARCHAR(100) NOT NULL,
    "phone" VARCHAR(20),
    "role" "Role" NOT NULL DEFAULT 'CUSTOMER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "passwordChangedAt" TIMESTAMPTZ(3),
    "twoFactorSecret" VARCHAR(255),
    "twoFactorEnabledAt" TIMESTAMPTZ(3),
    "lastLoginAt" TIMESTAMPTZ(3),
    "deletedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_accounts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "OAuthProvider" NOT NULL,
    "providerUserId" VARCHAR(255) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "refreshTokenHash" VARCHAR(64) NOT NULL,
    "familyId" UUID NOT NULL,
    "userAgent" VARCHAR(512),
    "ipAddress" VARCHAR(45),
    "location" VARCHAR(100),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedReason" VARCHAR(50),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "AuthTokenType" NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "newEmail" VARCHAR(254),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_codes" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" VARCHAR(64) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backup_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_events" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "SecurityEventType" NOT NULL,
    "ipAddress" VARCHAR(45),
    "userAgent" VARCHAR(512),
    "location" VARCHAR(100),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addresses" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "label" VARCHAR(30),
    "fullName" VARCHAR(100) NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "region" VARCHAR(100) NOT NULL,
    "province" VARCHAR(100),
    "city" VARCHAR(100) NOT NULL,
    "barangay" VARCHAR(100) NOT NULL,
    "street" VARCHAR(255) NOT NULL,
    "postalCode" VARCHAR(10) NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stores" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "description" TEXT,
    "logoUrl" VARCHAR(500),
    "bannerUrl" VARCHAR(500),
    "status" "StoreStatus" NOT NULL DEFAULT 'PENDING',
    "businessType" "BusinessType" NOT NULL,
    "legalName" VARCHAR(150),
    "registrationNo" VARCHAR(50),
    "tinEncrypted" VARCHAR(255),
    "shipsFrom" VARCHAR(100),
    "ratingAvg" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "followerCount" INTEGER NOT NULL DEFAULT 0,
    "warningCount" INTEGER NOT NULL DEFAULT 0,
    "approvedAt" TIMESTAMPTZ(3),
    "suspendedUntil" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_documents" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "type" "DocumentType" NOT NULL,
    "fileKey" VARCHAR(255) NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" UUID,
    "note" VARCHAR(500),
    "reviewedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_accounts" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "method" "PayoutMethod" NOT NULL,
    "accountName" VARCHAR(100) NOT NULL,
    "accountNumberEncrypted" VARCHAR(255) NOT NULL,
    "last4" VARCHAR(4) NOT NULL,
    "verifiedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payout_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_follows" (
    "userId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_follows_pkey" PRIMARY KEY ("userId","storeId")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "parentId" UUID,
    "name" VARCHAR(80) NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(220) NOT NULL,
    "description" TEXT NOT NULL,
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "ratingAvg" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "soldCount" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variants" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "sku" VARCHAR(64) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "priceCentavos" INTEGER NOT NULL,
    "compareAtCentavos" INTEGER,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "weightGrams" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_images" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "url" VARCHAR(500) NOT NULL,
    "publicId" VARCHAR(255),
    "alt" VARCHAR(200),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "orderItemId" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "title" VARCHAR(120),
    "body" TEXT,
    "helpfulCount" INTEGER NOT NULL DEFAULT 0,
    "status" "ReviewStatus" NOT NULL DEFAULT 'PUBLISHED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wishlist_items" (
    "userId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "priceAtSaveCentavos" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wishlist_items_pkey" PRIMARY KEY ("userId","productId")
);

-- CreateTable
CREATE TABLE "carts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_items" (
    "cartId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "addedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("cartId","variantId")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "orderNumber" SERIAL NOT NULL,
    "userId" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "paymentMethod" "PaymentMethod" NOT NULL,
    "subtotalCentavos" INTEGER NOT NULL,
    "deliveryCentavos" INTEGER NOT NULL,
    "discountCentavos" INTEGER NOT NULL DEFAULT 0,
    "totalCentavos" INTEGER NOT NULL,
    "shippingAddress" JSONB NOT NULL,
    "placedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seller_orders" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "status" "SellerOrderStatus" NOT NULL DEFAULT 'AWAITING_PAYMENT',
    "deliveryOption" "DeliveryOption" NOT NULL DEFAULT 'STANDARD',
    "subtotalCentavos" INTEGER NOT NULL,
    "deliveryCentavos" INTEGER NOT NULL,
    "platformFeeCentavos" INTEGER NOT NULL DEFAULT 0,
    "courier" VARCHAR(60),
    "trackingNumber" VARCHAR(60),
    "shipBy" TIMESTAMPTZ(3),
    "shippedAt" TIMESTAMPTZ(3),
    "deliveredAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "seller_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "sellerOrderId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "productTitle" VARCHAR(200) NOT NULL,
    "variantName" VARCHAR(100) NOT NULL,
    "imageUrl" VARCHAR(500),
    "unitPriceCentavos" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_events" (
    "id" UUID NOT NULL,
    "sellerOrderId" UUID NOT NULL,
    "status" VARCHAR(40) NOT NULL,
    "message" VARCHAR(255) NOT NULL,
    "location" VARCHAR(100),
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "providerRef" VARCHAR(100),
    "amountCentavos" INTEGER NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "failureReason" VARCHAR(255),
    "paidAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "providerEventId" VARCHAR(100) NOT NULL,
    "type" VARCHAR(80) NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(3),
    "error" VARCHAR(500),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_requests" (
    "id" UUID NOT NULL,
    "sellerOrderId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "status" "ReturnStatus" NOT NULL DEFAULT 'REQUESTED',
    "refundCentavos" INTEGER NOT NULL DEFAULT 0,
    "resolvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "return_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "sellerOrderId" UUID,
    "payoutId" UUID,
    "type" "LedgerType" NOT NULL,
    "amountCentavos" INTEGER NOT NULL,
    "description" VARCHAR(200),
    "availableAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payouts" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "reference" VARCHAR(30) NOT NULL,
    "amountCentavos" INTEGER NOT NULL,
    "method" "PayoutMethod" NOT NULL,
    "accountLast4" VARCHAR(4) NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PROCESSING',
    "failureReason" VARCHAR(255),
    "paidAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_flags" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "source" "FlagSource" NOT NULL,
    "reason" VARCHAR(255) NOT NULL,
    "message" TEXT,
    "riskScore" INTEGER,
    "status" "FlagStatus" NOT NULL DEFAULT 'OPEN',
    "reporterId" UUID,
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMPTZ(3),
    "resolutionNote" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" VARCHAR(60) NOT NULL,
    "targetType" VARCHAR(40) NOT NULL,
    "targetId" UUID,
    "metadata" JSONB,
    "ipAddress" VARCHAR(45),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_status_idx" ON "users"("role", "status");

-- CreateIndex
CREATE INDEX "oauth_accounts_userId_idx" ON "oauth_accounts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_accounts_provider_providerUserId_key" ON "oauth_accounts"("provider", "providerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refreshTokenHash_key" ON "sessions"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_revokedAt_idx" ON "sessions"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "sessions_familyId_idx" ON "sessions"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "auth_tokens_tokenHash_key" ON "auth_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "auth_tokens_userId_type_idx" ON "auth_tokens"("userId", "type");

-- CreateIndex
CREATE INDEX "backup_codes_userId_idx" ON "backup_codes"("userId");

-- CreateIndex
CREATE INDEX "security_events_userId_createdAt_idx" ON "security_events"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "addresses_userId_idx" ON "addresses"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "stores_ownerId_key" ON "stores"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "stores_slug_key" ON "stores"("slug");

-- CreateIndex
CREATE INDEX "stores_status_idx" ON "stores"("status");

-- CreateIndex
CREATE INDEX "store_documents_storeId_idx" ON "store_documents"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "payout_accounts_storeId_key" ON "payout_accounts"("storeId");

-- CreateIndex
CREATE INDEX "store_follows_storeId_idx" ON "store_follows"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE INDEX "categories_parentId_idx" ON "categories"("parentId");

-- CreateIndex
CREATE INDEX "products_categoryId_status_idx" ON "products"("categoryId", "status");

-- CreateIndex
CREATE INDEX "products_storeId_status_idx" ON "products"("storeId", "status");

-- CreateIndex
CREATE INDEX "products_status_soldCount_idx" ON "products"("status", "soldCount" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "products_storeId_slug_key" ON "products"("storeId", "slug");

-- CreateIndex
CREATE INDEX "product_variants_productId_idx" ON "product_variants"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_storeId_sku_key" ON "product_variants"("storeId", "sku");

-- CreateIndex
CREATE INDEX "product_images_productId_sortOrder_idx" ON "product_images"("productId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_orderItemId_key" ON "reviews"("orderItemId");

-- CreateIndex
CREATE INDEX "reviews_productId_status_createdAt_idx" ON "reviews"("productId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "reviews_userId_idx" ON "reviews"("userId");

-- CreateIndex
CREATE INDEX "wishlist_items_productId_idx" ON "wishlist_items"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "carts_userId_key" ON "carts"("userId");

-- CreateIndex
CREATE INDEX "cart_items_variantId_idx" ON "cart_items"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_orderNumber_key" ON "orders"("orderNumber");

-- CreateIndex
CREATE INDEX "orders_userId_createdAt_idx" ON "orders"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "orders_status_expiresAt_idx" ON "orders"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "seller_orders_storeId_status_createdAt_idx" ON "seller_orders"("storeId", "status", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "seller_orders_orderId_storeId_key" ON "seller_orders"("orderId", "storeId");

-- CreateIndex
CREATE INDEX "order_items_sellerOrderId_idx" ON "order_items"("sellerOrderId");

-- CreateIndex
CREATE INDEX "order_items_variantId_idx" ON "order_items"("variantId");

-- CreateIndex
CREATE INDEX "order_items_productId_idx" ON "order_items"("productId");

-- CreateIndex
CREATE INDEX "shipment_events_sellerOrderId_occurredAt_idx" ON "shipment_events"("sellerOrderId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "payments_providerRef_key" ON "payments"("providerRef");

-- CreateIndex
CREATE INDEX "payments_orderId_idx" ON "payments"("orderId");

-- CreateIndex
CREATE INDEX "webhook_events_processedAt_idx" ON "webhook_events"("processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_providerEventId_key" ON "webhook_events"("provider", "providerEventId");

-- CreateIndex
CREATE INDEX "return_requests_sellerOrderId_idx" ON "return_requests"("sellerOrderId");

-- CreateIndex
CREATE INDEX "return_requests_userId_idx" ON "return_requests"("userId");

-- CreateIndex
CREATE INDEX "ledger_entries_storeId_availableAt_idx" ON "ledger_entries"("storeId", "availableAt");

-- CreateIndex
CREATE INDEX "ledger_entries_sellerOrderId_idx" ON "ledger_entries"("sellerOrderId");

-- CreateIndex
CREATE INDEX "ledger_entries_payoutId_idx" ON "ledger_entries"("payoutId");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_reference_key" ON "payouts"("reference");

-- CreateIndex
CREATE INDEX "payouts_storeId_createdAt_idx" ON "payouts"("storeId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "product_flags_status_createdAt_idx" ON "product_flags"("status", "createdAt");

-- CreateIndex
CREATE INDEX "product_flags_productId_idx" ON "product_flags"("productId");

-- CreateIndex
CREATE INDEX "audit_logs_targetType_targetId_idx" ON "audit_logs"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_createdAt_idx" ON "audit_logs"("actorId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_codes" ADD CONSTRAINT "backup_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stores" ADD CONSTRAINT "stores_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_documents" ADD CONSTRAINT "store_documents_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_documents" ADD CONSTRAINT "store_documents_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_accounts" ADD CONSTRAINT "payout_accounts_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_follows" ADD CONSTRAINT "store_follows_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_follows" ADD CONSTRAINT "store_follows_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_orders" ADD CONSTRAINT "seller_orders_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_orders" ADD CONSTRAINT "seller_orders_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_sellerOrderId_fkey" FOREIGN KEY ("sellerOrderId") REFERENCES "seller_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_sellerOrderId_fkey" FOREIGN KEY ("sellerOrderId") REFERENCES "seller_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_sellerOrderId_fkey" FOREIGN KEY ("sellerOrderId") REFERENCES "seller_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_sellerOrderId_fkey" FOREIGN KEY ("sellerOrderId") REFERENCES "seller_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "payouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_flags" ADD CONSTRAINT "product_flags_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_flags" ADD CONSTRAINT "product_flags_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_flags" ADD CONSTRAINT "product_flags_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =====================================================================
-- Hand-written additions (Prisma can't express these in schema.prisma).
-- The database itself refuses impossible data, even if app code has a bug.
-- =====================================================================

-- Emails are stored lowercase so "Maria@Gmail.com" can't create a second account.
ALTER TABLE "users" ADD CONSTRAINT "users_email_lowercase_chk" CHECK ("email" = lower("email"));

-- Money and stock can never go negative; compare-at price must be above the price.
ALTER TABLE "product_variants"
  ADD CONSTRAINT "product_variants_price_chk" CHECK ("priceCentavos" >= 0),
  ADD CONSTRAINT "product_variants_compare_at_chk" CHECK ("compareAtCentavos" IS NULL OR "compareAtCentavos" > "priceCentavos"),
  ADD CONSTRAINT "product_variants_stock_chk" CHECK ("stock" >= 0),
  ADD CONSTRAINT "product_variants_weight_chk" CHECK ("weightGrams" IS NULL OR "weightGrams" > 0);
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_quantity_chk" CHECK ("quantity" BETWEEN 1 AND 99);
ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_quantity_chk" CHECK ("quantity" > 0),
  ADD CONSTRAINT "order_items_price_chk" CHECK ("unitPriceCentavos" >= 0);
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_amounts_chk" CHECK ("subtotalCentavos" >= 0 AND "deliveryCentavos" >= 0 AND "discountCentavos" >= 0),
  ADD CONSTRAINT "orders_total_chk" CHECK ("totalCentavos" = "subtotalCentavos" + "deliveryCentavos" - "discountCentavos");
ALTER TABLE "seller_orders" ADD CONSTRAINT "seller_orders_amounts_chk" CHECK ("subtotalCentavos" >= 0 AND "deliveryCentavos" >= 0 AND "platformFeeCentavos" >= 0);
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_chk" CHECK ("amountCentavos" > 0);
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_amount_chk" CHECK ("amountCentavos" > 0);
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_refund_chk" CHECK ("refundCentavos" >= 0);
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_amount_chk" CHECK ("amountCentavos" <> 0);
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_price_chk" CHECK ("priceAtSaveCentavos" >= 0);

-- Ratings, scores and counters stay in range.
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_rating_chk" CHECK ("rating" BETWEEN 1 AND 5);
ALTER TABLE "products" ADD CONSTRAINT "products_rating_chk" CHECK ("ratingAvg" BETWEEN 0 AND 5 AND "ratingCount" >= 0 AND "soldCount" >= 0);
ALTER TABLE "stores" ADD CONSTRAINT "stores_rating_chk" CHECK ("ratingAvg" BETWEEN 0 AND 5 AND "ratingCount" >= 0 AND "followerCount" >= 0 AND "warningCount" >= 0);
ALTER TABLE "product_flags" ADD CONSTRAINT "product_flags_risk_chk" CHECK ("riskScore" IS NULL OR "riskScore" BETWEEN 0 AND 100);
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_attempts_chk" CHECK ("attempts" >= 0);

-- Stored secrets have the expected shape (SHA-256 hex, last 4 digits).
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_token_hash_chk" CHECK ("refreshTokenHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_token_hash_chk" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "payout_accounts" ADD CONSTRAINT "payout_accounts_last4_chk" CHECK ("last4" ~ '^[0-9]{4}$');

-- Shoppers see order numbers as VD-21000, VD-21001, …
ALTER SEQUENCE "orders_orderNumber_seq" RESTART WITH 21000;
