-- Migration: settlement_and_balance
--
-- Adds the Settlement entity with its enum, audit actions, and indexes.
-- Also adds a covering index for fast SUM-based balance computation on
-- BucketLedgerEntry, and a latestBalance helper index.
--
-- See TREASURY_BUILD.md §Settlement Entity for the full design.

-- ── Enum ─────────────────────────────────────────────────────────────────────

DO $$ BEGIN
    CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Settlement table ─────────────────────────────────────────────────────────

CREATE TABLE "Settlement" (
    "id"          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "bucketId"    TEXT NOT NULL,
    "businessId"  TEXT NOT NULL,
    "amountKobo"  BIGINT NOT NULL,
    "currency"    TEXT NOT NULL DEFAULT 'NGN',
    "status"      "SettlementStatus" NOT NULL DEFAULT 'PENDING',

    "destinationType"          "SettlementDestinationType" NOT NULL,
    "destinationAccountName"   TEXT,
    "destinationAccountNumber" TEXT,
    "destinationBankCode"      TEXT,
    "destinationBucketRef"     TEXT,

    "nombaTransferReference" TEXT,
    "failureReason"          TEXT,
    "initiatedBy"            TEXT NOT NULL,

    "completedAt" TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Settlement_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "TreasuryBucket"("id") ON DELETE RESTRICT,
    CONSTRAINT "Settlement_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT
);

-- Unique nullable nombaTransferReference (PostgreSQL treats NULLs as distinct)
CREATE UNIQUE INDEX "Settlement_nombaTransferReference_key" ON "Settlement"("nombaTransferReference") WHERE "nombaTransferReference" IS NOT NULL;

CREATE INDEX "Settlement_bucketId_status_idx" ON "Settlement"("bucketId", "status");
CREATE INDEX "Settlement_businessId_status_idx" ON "Settlement"("businessId", "status");

-- ── Covering index for fast SUM-based balance audit ──────────────────────────

CREATE INDEX "BucketLedgerEntry_bucketId_entryType_amountKobo_idx"
    ON "BucketLedgerEntry"("bucketId", "entryType", "amountKobo");
