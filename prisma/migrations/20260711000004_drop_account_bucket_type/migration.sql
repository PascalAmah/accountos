-- Migration: drop_account_bucket_type
--
-- Removes the dead Account.bucketType column — a leftover from the old two-tier
-- "treasury bucket = DVA on Account" model. Treasury buckets are now the separate
-- TreasuryBucket model (with its own bucketType), and no code reads
-- Account.bucketType. Non-breaking cleanup (schema/PRD drift, plan item E4).
--
-- Account.accountType is intentionally KEPT — it is still read by
-- account-lifecycle.service.ts.

ALTER TABLE "Account" DROP COLUMN IF EXISTS "bucketType";
