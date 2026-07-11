-- Migration: settlement_audit_actions
--
-- The settlement lifecycle (SettlementService) logs four AuditAction values that
-- exist in schema.prisma but were never added to the Postgres "AuditAction" enum
-- by 20260711000001_settlement_and_balance. Because AuditService.log() swallows
-- errors, settlement audit writes were failing SILENTLY against the real DB —
-- losing the entire settlement audit trail.
--
-- ADD VALUE IF NOT EXISTS is idempotent (PG 12+): safe whether or not a prior
-- partial deploy already added any of these.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SETTLEMENT_RESERVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SETTLEMENT_COMPLETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SETTLEMENT_FAILED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SETTLEMENT_CANCELLED';
