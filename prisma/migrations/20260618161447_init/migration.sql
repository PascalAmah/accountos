-- CreateEnum
CREATE TYPE "KycTier" AS ENUM ('TIER_0', 'TIER_1', 'TIER_2', 'TIER_3');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'EXPIRED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ExecutionModel" AS ENUM ('SEQUENTIAL', 'PARALLEL');

-- CreateEnum
CREATE TYPE "RuleTrigger" AS ENUM ('INFLOW_RECEIVED', 'TIME_ELAPSED', 'TIER_CHANGED', 'CUSTOM_EVENT');

-- CreateEnum
CREATE TYPE "RuleAction" AS ENUM ('SUSPEND_ACCOUNT', 'REACTIVATE_ACCOUNT', 'EXPIRE_ACCOUNT', 'NOTIFY_WEBHOOK', 'RELEASE_FUNDS', 'FLAG_FOR_REVIEW');

-- CreateEnum
CREATE TYPE "RuleStatus" AS ENUM ('ACTIVE', 'ARCHIVED', 'FLAGGED_FOR_REVIEW');

-- CreateEnum
CREATE TYPE "RuleArchivedReason" AS ENUM ('CLOSED_BEFORE_COMPLETION', 'SUPERSEDED_BY_UPDATE', 'MANUALLY_ARCHIVED');

-- CreateEnum
CREATE TYPE "RuleExecutionStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'RETRYING', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('INFLOW', 'OUTFLOW');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('PENDING', 'MATCHED', 'UNMATCHED', 'FLAGGED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('BUSINESS_CREATED', 'API_KEY_CREATED', 'API_KEY_REVOKED', 'CUSTOMER_CREATED', 'CUSTOMER_RENAMED', 'KYC_TIER_CHANGED', 'ACCOUNT_CREATED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_REACTIVATED', 'ACCOUNT_EXPIRED', 'ACCOUNT_CLOSED', 'ACCOUNT_STATUS_OVERRIDE', 'RULES_UPDATED', 'RULE_FLAGGED_KYC_CHANGE', 'RULE_ARCHIVED', 'RULE_ACTION_COMPLETED', 'RULE_ACTION_FAILED', 'INFLOW_RECEIVED', 'CUSTOM_EVENT_PROCESSED', 'DUPLICATE_EVENT_DISCARDED', 'UNKNOWN_ACCOUNT_WEBHOOK');

-- CreateTable
CREATE TABLE "Business" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "webhookUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Business_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "kycTier" "KycTier" NOT NULL DEFAULT 'TIER_0',
    "bvn" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "businessId" TEXT NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NameHistoryEntry" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "previousName" TEXT NOT NULL,
    "newName" TEXT NOT NULL,
    "reason" TEXT,
    "changedBy" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NameHistoryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "accountRef" TEXT NOT NULL,
    "nombaAccountId" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "executionModel" "ExecutionModel" NOT NULL DEFAULT 'SEQUENTIAL',
    "accountNameAtCreation" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rule" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "trigger" "RuleTrigger" NOT NULL,
    "condition" JSONB NOT NULL,
    "action" "RuleAction" NOT NULL,
    "payload" JSONB,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" "RuleStatus" NOT NULL DEFAULT 'ACTIVE',
    "kycTierAtCreation" "KycTier" NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "archivedReason" "RuleArchivedReason",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleExecution" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "triggeredByLedgerEntryId" TEXT,
    "triggeredBy" TEXT NOT NULL,
    "status" "RuleExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "nombaApiResponse" JSONB,
    "errorMessage" TEXT,
    "archivedReason" "RuleArchivedReason",
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "RuleExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "nombaTransactionRef" TEXT NOT NULL,
    "nombaEventId" TEXT NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amountKobo" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "senderName" TEXT,
    "senderAccountNumber" TEXT,
    "senderBankCode" TEXT,
    "narration" TEXT,
    "customerNameSnapshot" TEXT NOT NULL,
    "kycTierAtTime" "KycTier" NOT NULL,
    "cumulativeAmountKobo" BIGINT NOT NULL,
    "reconciliationStatus" "ReconciliationStatus" NOT NULL DEFAULT 'PENDING',
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "accountRef" TEXT,
    "businessId" TEXT,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLogEntry" (
    "id" TEXT NOT NULL,
    "accountId" TEXT,
    "customerId" TEXT,
    "businessId" TEXT,
    "actor" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "beforeState" JSONB,
    "afterState" JSONB,
    "reasonCode" TEXT,
    "metadata" JSONB,
    "requestId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLogEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Business_email_key" ON "Business"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_keyHash_idx" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_businessId_idx" ON "ApiKey"("businessId");

-- CreateIndex
CREATE INDEX "Customer_businessId_idx" ON "Customer"("businessId");

-- CreateIndex
CREATE INDEX "Customer_kycTier_idx" ON "Customer"("kycTier");

-- CreateIndex
CREATE INDEX "NameHistoryEntry_customerId_changedAt_idx" ON "NameHistoryEntry"("customerId", "changedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Account_accountRef_key" ON "Account"("accountRef");

-- CreateIndex
CREATE UNIQUE INDEX "Account_nombaAccountId_key" ON "Account"("nombaAccountId");

-- CreateIndex
CREATE INDEX "Account_customerId_idx" ON "Account"("customerId");

-- CreateIndex
CREATE INDEX "Account_status_idx" ON "Account"("status");

-- CreateIndex
CREATE INDEX "Account_accountNumber_idx" ON "Account"("accountNumber");

-- CreateIndex
CREATE INDEX "Rule_accountId_status_idx" ON "Rule"("accountId", "status");

-- CreateIndex
CREATE INDEX "Rule_accountId_trigger_idx" ON "Rule"("accountId", "trigger");

-- CreateIndex
CREATE INDEX "Rule_accountId_priority_idx" ON "Rule"("accountId", "priority");

-- CreateIndex
CREATE INDEX "RuleExecution_accountId_status_idx" ON "RuleExecution"("accountId", "status");

-- CreateIndex
CREATE INDEX "RuleExecution_status_nextRetryAt_idx" ON "RuleExecution"("status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "RuleExecution_ruleId_idx" ON "RuleExecution"("ruleId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_nombaTransactionRef_key" ON "LedgerEntry"("nombaTransactionRef");

-- CreateIndex
CREATE INDEX "LedgerEntry_accountId_createdAt_idx" ON "LedgerEntry"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_accountId_reconciliationStatus_idx" ON "LedgerEntry"("accountId", "reconciliationStatus");

-- CreateIndex
CREATE INDEX "LedgerEntry_nombaTransactionRef_idx" ON "LedgerEntry"("nombaTransactionRef");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedEvent_eventId_key" ON "ProcessedEvent"("eventId");

-- CreateIndex
CREATE INDEX "ProcessedEvent_eventType_processedAt_idx" ON "ProcessedEvent"("eventType", "processedAt");

-- CreateIndex
CREATE INDEX "AuditLogEntry_accountId_occurredAt_idx" ON "AuditLogEntry"("accountId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditLogEntry_customerId_occurredAt_idx" ON "AuditLogEntry"("customerId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditLogEntry_businessId_occurredAt_idx" ON "AuditLogEntry"("businessId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditLogEntry_action_occurredAt_idx" ON "AuditLogEntry"("action", "occurredAt");

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NameHistoryEntry" ADD CONSTRAINT "NameHistoryEntry_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleExecution" ADD CONSTRAINT "RuleExecution_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleExecution" ADD CONSTRAINT "RuleExecution_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleExecution" ADD CONSTRAINT "RuleExecution_triggeredByLedgerEntryId_fkey" FOREIGN KEY ("triggeredByLedgerEntryId") REFERENCES "LedgerEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLogEntry" ADD CONSTRAINT "AuditLogEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
