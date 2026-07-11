-- Migration: enforce_append_only
--
-- Adds BEFORE UPDATE OR DELETE triggers on the four append-only tables:
--   LedgerEntry, AuditLogEntry, BucketLedgerEntry, NameHistoryEntry
--
-- Design decisions:
--   - Triggers (not REVOKE): Prisma connects as the table owner, which bypasses
--     grants and non-forced RLS. Triggers fire regardless of role.
--   - Column-guard on LedgerEntry: reconciliationStatus is the ONE legitimate
--     mutation — updated by the webhook processor after rule evaluation. All
--     other UPDATEs and DELETEs are rejected.
--   - The trigger function is shared across tables; each table's trigger
--     specifies which columns (if any) are exempt from the guard.

-- ── Shared trigger function ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION enforce_append_only()
RETURNS TRIGGER AS $$
DECLARE
    exempt_cols TEXT[] := TG_ARGV;
    col_name   TEXT;
    old_val    TEXT;
    new_val    TEXT;
BEGIN
    -- DELETE: always rejected for append-only tables
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'DELETE forbidden on append-only table %.%',
            TG_TABLE_SCHEMA, TG_TABLE_NAME;
    END IF;

    -- UPDATE: check every column except those listed in TG_ARGV
    FOR col_name IN
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = TG_TABLE_SCHEMA
          AND table_name   = TG_TABLE_NAME
          AND column_name  <> ALL (exempt_cols)
    LOOP
        EXECUTE format('SELECT ($1).%I::text, ($2).%I::text', col_name, col_name)
        INTO old_val, new_val
        USING OLD, NEW;

        IF old_val IS DISTINCT FROM new_val THEN
            RAISE EXCEPTION 'UPDATE forbidden on append-only column %.%.%',
                TG_TABLE_SCHEMA, TG_TABLE_NAME, col_name;
        END IF;
    END LOOP;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── LedgerEntry: reconciliationStatus is the only mutable column ────────────

DROP TRIGGER IF EXISTS trg_append_only_ledger ON "LedgerEntry";
CREATE TRIGGER trg_append_only_ledger
    BEFORE UPDATE OR DELETE ON "LedgerEntry"
    FOR EACH ROW
    EXECUTE FUNCTION enforce_append_only('reconciliationStatus');

-- ── AuditLogEntry: fully append-only (no exemptions) ─────────────────────────

DROP TRIGGER IF EXISTS trg_append_only_audit ON "AuditLogEntry";
CREATE TRIGGER trg_append_only_audit
    BEFORE UPDATE OR DELETE ON "AuditLogEntry"
    FOR EACH ROW
    EXECUTE FUNCTION enforce_append_only();

-- ── BucketLedgerEntry: fully append-only (no exemptions) ─────────────────────

DROP TRIGGER IF EXISTS trg_append_only_bucket_ledger ON "BucketLedgerEntry";
CREATE TRIGGER trg_append_only_bucket_ledger
    BEFORE UPDATE OR DELETE ON "BucketLedgerEntry"
    FOR EACH ROW
    EXECUTE FUNCTION enforce_append_only();

-- ── NameHistoryEntry: fully append-only (no exemptions) ──────────────────────

DROP TRIGGER IF EXISTS trg_append_only_name_history ON "NameHistoryEntry";
CREATE TRIGGER trg_append_only_name_history
    BEFORE UPDATE OR DELETE ON "NameHistoryEntry"
    FOR EACH ROW
    EXECUTE FUNCTION enforce_append_only();
