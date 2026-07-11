-- Treasury Layer: logical sub-ledger buckets (see technical-docs/TREASURY_BUILD.md)
-- Buckets are NOT Nomba DVAs. Money physically lives in the business's Nomba account;
-- buckets record logical ownership via an immutable bucket ledger.

-- CreateEnum
CREATE TYPE "BucketEntryType" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "SettlementDestinationType" AS ENUM ('BANK_ACCOUNT', 'NOMBA_ACCOUNT', 'INTERNAL_BUCKET', 'WEBHOOK');

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'BUCKET_TRANSFER';

-- CreateTable
CREATE TABLE "TreasuryBucket" (
    "id" TEXT NOT NULL,
    "bucketRef" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bucketType" "BucketType" NOT NULL,
    "description" TEXT,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "businessId" TEXT NOT NULL,
    "settlementType" "SettlementDestinationType",
    "settlementAccountName" TEXT,
    "settlementAccountNumber" TEXT,
    "settlementBankCode" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TreasuryBucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BucketLedgerEntry" (
    "id" TEXT NOT NULL,
    "bucketId" TEXT NOT NULL,
    "entryType" "BucketEntryType" NOT NULL,
    "amountKobo" BIGINT NOT NULL,
    "cumulativeAmountKobo" BIGINT NOT NULL,
    "reference" TEXT NOT NULL,
    "sourceLedgerEntryId" TEXT,
    "narration" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BucketLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TreasuryBucket_businessId_idx" ON "TreasuryBucket"("businessId");

-- CreateIndex
CREATE INDEX "TreasuryBucket_businessId_status_idx" ON "TreasuryBucket"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TreasuryBucket_businessId_bucketRef_key" ON "TreasuryBucket"("businessId", "bucketRef");

-- CreateIndex
CREATE UNIQUE INDEX "BucketLedgerEntry_reference_key" ON "BucketLedgerEntry"("reference");

-- CreateIndex
CREATE INDEX "BucketLedgerEntry_bucketId_createdAt_idx" ON "BucketLedgerEntry"("bucketId", "createdAt");

-- CreateIndex
CREATE INDEX "BucketLedgerEntry_entryType_idx" ON "BucketLedgerEntry"("entryType");

-- AddForeignKey
ALTER TABLE "TreasuryBucket" ADD CONSTRAINT "TreasuryBucket_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BucketLedgerEntry" ADD CONSTRAINT "BucketLedgerEntry_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "TreasuryBucket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BucketLedgerEntry" ADD CONSTRAINT "BucketLedgerEntry_sourceLedgerEntryId_fkey" FOREIGN KEY ("sourceLedgerEntryId") REFERENCES "LedgerEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
