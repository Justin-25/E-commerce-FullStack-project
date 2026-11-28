-- Milestone 8a: Vendora AI chats. Each message is stored exactly as sent to / received from Claude, in order.
-- CreateEnum
CREATE TYPE "AiScope" AS ENUM ('SHOPPER', 'SELLER', 'ADMIN');

-- CreateEnum
CREATE TYPE "AiRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateTable
CREATE TABLE "ai_conversations" (
    "id" UUID NOT NULL,
    "scope" "AiScope" NOT NULL,
    "userId" UUID,
    "visitorHash" CHAR(64),
    "productId" UUID,
    "title" VARCHAR(120),
    "questionCount" INTEGER NOT NULL DEFAULT 0,
    "busyUntil" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_messages" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" "AiRole" NOT NULL,
    "content" JSON NOT NULL,
    "text" TEXT,
    "cards" JSONB,
    "model" VARCHAR(64),
    "stopReason" VARCHAR(40),
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_conversations_userId_lastMessageAt_idx" ON "ai_conversations"("userId", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "ai_conversations_visitorHash_lastMessageAt_idx" ON "ai_conversations"("visitorHash", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "ai_conversations_lastMessageAt_idx" ON "ai_conversations"("lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_messages_conversationId_seq_key" ON "ai_messages"("conversationId", "seq");

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A chat has exactly one owner: an account, or (signed out) one browser's visitor cookie hash.
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_owner_chk" CHECK (("userId" IS NULL) <> ("visitorHash" IS NULL));
-- Signed-out chats are shopper chats only (Ask your data needs an account).
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_visitor_chk" CHECK ("visitorHash" IS NULL OR "scope" = 'SHOPPER');
-- At most 20 questions per chat, even if two arrive at once.
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_questions_chk" CHECK ("questionCount" BETWEEN 0 AND 20);

-- Every stored message can be replayed: a non-empty list of content blocks (JSON, not JSONB: kept exactly as written,
-- key order included, because Claude checks the replayed history and the prompt cache matches it token for token).
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_content_chk" CHECK (json_typeof("content") = 'array' AND json_array_length("content") > 0);
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_seq_chk" CHECK ("seq" >= 0);
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_tokens_chk" CHECK ("inputTokens" >= 0 AND "outputTokens" >= 0 AND "cacheReadTokens" >= 0 AND "cacheWriteTokens" >= 0);
