# Row-Level Security (RLS) Design

**Status:** Documented — not yet implemented  
**Version:** 1.0  
**Owner:** AccountOS Core

---

## Purpose

This document describes the Row-Level Security (RLS) design that will enforce
tenant isolation at the database level for AccountOS. Currently all tenancy
is enforced at the application layer (every query includes a `businessId` filter).
RLS adds a defense-in-depth guarantee: even if application-layer filtering is
missed or bypassed, PostgreSQL itself prevents cross-tenant data access.

---

## Target Tables

Every table that holds business-scoped data should have RLS enabled:

| Table | Tenant Column | Notes |
|---|---|---|
| `Customer` | `businessId` | |
| `Account` | `businessId` | |
| `ApiKey` | `businessId` | |
| `TreasuryBucket` | `businessId` | |
| `BucketLedgerEntry` | `bucketId → TreasuryBucket.businessId` | Join through bucket |
| `LedgerEntry` | `accountId → Account.businessId` | Join through account |
| `AuditLogEntry` | `businessId` | Nullable — system-level entries have no business |
| `Settlement` | `businessId` | |
| `IdempotencyKey` | `businessId` | |
| `ProcessedEvent` | `businessId` | Nullable |
| `Rule` | `accountId → Account.businessId` | Join through account |
| `RuleExecution` | `accountId → Account.businessId` | Join through account |
| `NameHistoryEntry` | `customerId → Customer.businessId` | Join through customer |

---

## Session Variable Pattern

The application sets a PostgreSQL session variable at the start of every
connection or transaction:

```sql
SET app.current_business_id = '<businessId>';
```

PostgreSQL policies then reference this variable:

```sql
CREATE POLICY tenant_isolation ON "Customer"
  FOR ALL
  USING ("businessId" = current_setting('app.current_business_id'));
```

For tables without a direct `businessId` column, the policy joins through
the parent:

```sql
CREATE POLICY tenant_isolation ON "BucketLedgerEntry"
  FOR ALL
  USING (
    "bucketId" IN (
      SELECT id FROM "TreasuryBucket"
      WHERE "businessId" = current_setting('app.current_business_id')
    )
  );
```

---

## Prisma Integration

Prisma connects as the table owner by default, which bypasses RLS. To make RLS
enforceable, use one of these approaches:

### Option A: `$queryRaw` session set + non-owner role (recommended)

1. Create a dedicated PostgreSQL role (e.g. `accountos_app`) that does NOT own
   the tables.
2. Grant SELECT/INSERT/UPDATE/DELETE on all tables to this role.
3. At connection start, execute `SET app.current_business_id = ?` via
   `$queryRaw` or a Prisma `$extends` middleware.
4. Prisma connects as `accountos_app` — RLS policies fire.

```ts
// prisma.config.ts or similar setup
const prisma = new PrismaClient().$extends({
  query: {
    $allModels: {
      async $allOperations({ args, query }) {
        // Set session variable in a transaction or before each query
        const businessId = getCurrentBusinessId(); // from async_hooks or CLS
        if (businessId) {
          await prisma.$executeRawUnsafe(
            `SET LOCAL app.current_business_id = '${businessId}'`
          );
        }
        return query(args);
      },
    },
  },
});
```

### Option B: `FORCE ROW LEVEL SECURITY` (PostgreSQL 15+)

`ALTER TABLE "Customer" FORCE ROW LEVEL SECURITY;` makes RLS apply even to
the table owner. This is the simplest path if all queries already include a
`businessId` filter — the owner must also satisfy the policy.

Downside: system-level queries (seeding, migrations, admin operations that
cross tenants) need explicit `SET app.current_business_id = ''` or a bypass
role.

### pgBouncer Consideration

If using pgBouncer in transaction mode, `SET LOCAL` works correctly because
each transaction gets a fresh server connection. In session mode, `SET SESSION`
leaks across transactions — avoid. Always use `SET LOCAL` or wrap in
`BEGIN ... SET LOCAL ... COMMIT`.

---

## Policy Examples

### Direct businessId tables

```sql
ALTER TABLE "Customer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Customer" FORCE ROW LEVEL SECURITY;

CREATE POLICY customer_tenant_isolation ON "Customer"
  FOR ALL
  USING ("businessId" = current_setting('app.current_business_id'))
  WITH CHECK ("businessId" = current_setting('app.current_business_id'));
```

### Joined tables (no direct businessId)

```sql
ALTER TABLE "BucketLedgerEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BucketLedgerEntry" FORCE ROW LEVEL SECURITY;

CREATE POLICY bucket_ledger_tenant_isolation ON "BucketLedgerEntry"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "TreasuryBucket"
      WHERE "TreasuryBucket".id = "BucketLedgerEntry"."bucketId"
        AND "TreasuryBucket"."businessId" = current_setting('app.current_business_id')
    )
  );
```

### Nullable businessId tables (AuditLogEntry, ProcessedEvent)

System-level entries have `businessId IS NULL`. The policy must allow reads
of NULL rows:

```sql
CREATE POLICY audit_tenant_isolation ON "AuditLogEntry"
  FOR ALL
  USING (
    "businessId" IS NULL
    OR "businessId" = current_setting('app.current_business_id')
  );
```

---

## Rollout Plan

1. **Phase 0 (now):** Document the design. No code or migration changes.
2. **Phase 1 (staging):** Create the `accountos_app` role, apply policies,
   update Prisma connection string. Run the full test suite with RLS enabled.
3. **Phase 2 (canary):** Deploy to a canary instance with a subset of traffic.
   Monitor for policy violations in PostgreSQL logs.
4. **Phase 3 (production):** Roll out to all instances. Keep the session variable
   pattern; add `FORCE ROW LEVEL SECURITY` if using the owner-role approach.

---

## Testing RLS

```sql
-- Verify RLS is enabled
SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class
WHERE relname IN ('Customer', 'Account', 'TreasuryBucket');

-- Verify a cross-tenant query returns zero rows
SET app.current_business_id = 'biz_A';
SELECT * FROM "Customer" WHERE "businessId" = 'biz_B';  -- should return 0 rows

-- Verify system-level audit entries are visible
SET app.current_business_id = 'biz_A';
SELECT count(*) FROM "AuditLogEntry" WHERE "businessId" IS NULL;  -- should return rows
```

---

## Decision Log

| Decision | Rationale |
|---|---|
| Session variable (`app.current_business_id`) over JWT claims | Simpler; no JWT dependency in the database; works with API keys that don't carry claims |
| RLS + Prisma `$extends` over middleware-only tenancy | Defense in depth — the database is the final guard, not the application |
| `FORCE ROW LEVEL SECURITY` (owner bypass) | Simplest rollout with existing owner-role Prisma connection; no new role needed in phase 1 |
| `SET LOCAL` over `SET SESSION` | Safe with pgBouncer transaction pooling; avoids leaking session state across transactions |
