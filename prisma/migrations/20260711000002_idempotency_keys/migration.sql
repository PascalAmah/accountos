-- Migration: idempotency_keys
--
-- Adds the IdempotencyKey model for safe retry of mutating POST endpoints.
-- See API_SPEC §Idempotency for the header contract.

CREATE TABLE "IdempotencyKey" (
    "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "key"            TEXT NOT NULL,
    "businessId"     TEXT NOT NULL,
    "method"         TEXT NOT NULL,
    "path"           TEXT NOT NULL,
    "requestHash"    TEXT NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "responseBody"   JSONB NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "IdempotencyKey_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "IdempotencyKey_businessId_key_key" ON "IdempotencyKey"("businessId", "key");
CREATE INDEX "IdempotencyKey_createdAt_idx" ON "IdempotencyKey"("createdAt");
