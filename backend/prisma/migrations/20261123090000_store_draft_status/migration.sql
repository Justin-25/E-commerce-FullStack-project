-- Milestone 6a, part 1 of 2: new enum values get a migration of their own, because
-- PostgreSQL can't use a value in the same transaction that adds it.

-- A store being set up ("Save and exit"), not yet submitted for review.
ALTER TYPE "StoreStatus" ADD VALUE 'DRAFT' BEFORE 'PENDING';

-- Shown in the seller's security activity.
ALTER TYPE "SecurityEventType" ADD VALUE 'PAYOUT_ACCOUNT_CHANGED';
