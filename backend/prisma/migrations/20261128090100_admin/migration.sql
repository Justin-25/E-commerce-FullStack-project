-- Milestone 7a, part 2: admin roles, seller application reviews, the audit log by time.

-- Admin accounts hold at least one role; other accounts none.
ALTER TABLE "users" ADD COLUMN "adminRoles" "AdminRole"[] NOT NULL DEFAULT ARRAY[]::"AdminRole"[];
ALTER TABLE "users" ADD CONSTRAINT "users_admin_roles_chk" CHECK (("role" = 'ADMIN') = (cardinality("adminRoles") > 0));

-- The latest review of a seller application: who, when, and the note sent to the seller (required
-- when asking for changes or rejecting).
ALTER TABLE "stores" ADD COLUMN "reviewNote" VARCHAR(1000);
ALTER TABLE "stores" ADD COLUMN "reviewedAt" TIMESTAMPTZ(3);
ALTER TABLE "stores" ADD COLUMN "reviewedById" UUID;
ALTER TABLE "stores" ADD CONSTRAINT "stores_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "stores" ADD CONSTRAINT "stores_review_note_chk" CHECK ("status" NOT IN ('CHANGES_REQUESTED', 'REJECTED') OR "reviewNote" IS NOT NULL);

-- The audit log page lists everything newest first.
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt" DESC);
