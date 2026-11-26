-- Milestone 7a, part 1 (enum values only: PostgreSQL can't use a new enum value in the same
-- transaction that adds it, so the next migration uses them).

-- "Ask for changes" on a seller application: back to the seller with the admin's note.
ALTER TYPE "StoreStatus" ADD VALUE 'CHANGES_REQUESTED';

-- What an admin may do: Support (applications, payout accounts, users, stores), Finance (payouts,
-- refunds), Moderation (listings). An admin can hold several.
CREATE TYPE "AdminRole" AS ENUM ('SUPPORT', 'FINANCE', 'MODERATION');
