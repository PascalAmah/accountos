# AccountOS — Architecture
Version: 2.0

---

## 1. System Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        External Systems                          │
│   Nomba API          Business Backends          API Clients      │
└──────┬───────────────────────┬──────────────────────┬────────────┘
       │ inflow webhooks       │ custom events /      │ REST + x-api-key
       │ (HMAC-signed)         │ API calls            │
       ▼                       ▼                      ▼
┌──────────────────────────────────────────────────────────────────┐
│                      AccountOS (NestJS 10)                       │
│                                                                  │
│  ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌────────┐ │
│  │ Webhooks │ │ Events   │ │ Accounts  │ │ Treasury │ │  Auth  │ │
│  │ Module   │ │ Module   │ │ Module    │ │ Module   │ │ Module │ │
│  └────┬─────┘ └────┬─────┘ └─────┬─────┘ └────┬─────┘ └────────┘ │
│       │            │             │             │                  │
│       └────────────▼─────────────┘─────────────┘                 │
│                    │                                              │
│           ┌────────▼────────┐                                    │
│           │  Rule Engine    │  ← validates via rule-schema.ts    │
│           └────────┬────────┘                                    │
│                    │                                              │
│  ┌─────────────────▼──────────────────────────────────────────┐  │
│  │               Core Services                                 │  │
│  │  LedgerService  AuditService  NombaClientService            │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                    │                                              │
│  ┌─────────────────▼──────────────────────────────────────────┐  │
│  │               Infrastructure                                │  │
│  │  BullMQ (webhook + retry queues)  Prisma  nestjs-pino      │  │
│  └─────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
              │                              │
         ┌────▼──────┐                ┌──────▼───┐
         │ PostgreSQL│                │  Redis   │
         └───────────┘                └──────────┘
```

---

## 2. Module Structure

```
src/
├── main.ts                           # Bootstrap, Swagger, global pipes, raw body
├── app.module.ts                     # Root module
│
├── nomba-client/                     # NombaClient module
│   ├── nomba-client.module.ts
│   ├── nomba-client.service.ts       # All Nomba API calls; per-business token cache
│   └── dto/
│
├── auth/                             # Business registration + API key lifecycle
│   ├── auth.module.ts
│   ├── auth.controller.ts            # POST /businesses, PATCH /businesses/:id/credentials, POST /api-keys, GET /api-keys, DELETE /api-keys/:id
│   ├── auth.service.ts               # generate, hash, validate, revoke keys; update credentials
│   └── api-key.guard.ts              # validates x-api-key on every protected request
│
├── identity/
│   ├── identity.module.ts
│   ├── identity.service.ts           # create, rename (EC-01), tier change (EC-03)
│   ├── identity.controller.ts        # POST /customers, GET /customers/:id, PATCH /customers/:id/name, PATCH /customers/:id/kyc-tier, GET /customers/:id/accounts
│   └── dto/
│
├── accounts/
│   ├── accounts.module.ts
│   ├── accounts.controller.ts        # POST /accounts, GET /accounts, GET /:ref/state, PATCH /:ref/status, DELETE /:ref
│   ├── account-lifecycle.service.ts  # status transitions, close (EC-02), reactivate
│   └── dto/
│
├── rules/
│   ├── rules.module.ts
│   ├── rules.controller.ts           # PUT /:ref/rules, PATCH /:ref/rules/:ruleId, DELETE /:ref/rules/:ruleId
│   ├── rules.service.ts              # CRUD, validates via rule-schema.ts
│   └── rule-engine.service.ts        # evaluate(), execute(), EC-05
│
├── webhooks/
│   ├── webhooks.module.ts
│   ├── webhooks.controller.ts        # POST /webhooks/nomba — returns 200 instantly
│   └── webhook-processor.service.ts  # HMAC (per-business secret), idempotency, enqueue to BullMQ
│
├── events/
│   ├── events.module.ts
│   ├── events.controller.ts          # POST /accounts/:ref/events
│   └── events.service.ts             # idempotency, enqueue to BullMQ
│
├── queue/
│   ├── queue.module.ts               # BullMQ module registration
│   ├── webhook.queue.ts              # Queue name: 'webhook-processing'
│   ├── retry.queue.ts                # Queue name: 'retry'
│   ├── webhook.processor.ts          # Worker: full async inflow processing
│   └── retry.processor.ts            # Worker: retries failed Nomba actions (EC-06)
│
├── ledger/
│   ├── ledger.module.ts
│   ├── ledger.service.ts             # append-only writes
│   └── ledger.controller.ts          # GET /:ref/ledger, /ledger/summary, /ledger/export
│
├── audit/
│   ├── audit.module.ts
│   ├── audit.service.ts              # append-only writes, never throws
│   └── audit.controller.ts           # GET /:ref/audit
│
├── treasury/
│   ├── treasury.module.ts
│   ├── treasury.controller.ts        # /treasury-buckets CRUD + /balance + /statement + /withdraw
│   ├── treasury.service.ts           # provisionBucket, management, withdrawal (EC-07, EC-08)
│   └── dto/
│
├── demo/
│   ├── demo.module.ts
│   └── demo.controller.ts            # POST /demo/simulate-inflow
│
├── health/
│   └── health.controller.ts          # GET /health → { status, db, redis, version }
│
└── common/
    ├── filters/
    │   └── http-exception.filter.ts
    ├── guards/
    │   └── api-key.guard.ts          # imported from auth module, applied globally
    ├── interceptors/
    │   └── request-id.interceptor.ts # generates x-request-id, flows to Pino + audit
    ├── decorators/
    │   └── public.decorator.ts       # @Public() skips API key guard
    └── constants/
        └── error-codes.ts            # all typed error code constants
```

---

## 3. Tenancy Model

Every resource is scoped to a `Business`. This is the foundation of data isolation.

```
Business
  ├── ApiKey[]         (many keys per business)
  ├── nombaAccountId   (their own Nomba parent account — funds never pooled)
  ├── nombaClientId    (their Nomba OAuth credentials)
  ├── nombaClientSecret
  ├── nombaWebhookSecret
  ├── Customer[]
  │     └── Account[] (accountType: CUSTOMER_ACCOUNT)
  │           ├── Rule[]
  │           ├── LedgerEntry[]
  │           ├── RuleExecution[]
  │           └── AuditLogEntry[]
  └── TreasuryBucket[] (stored as Account[] with accountType: TREASURY_BUCKET, no customerId)
        ├── LedgerEntry[]
        ├── RuleExecution[]
        └── AuditLogEntry[]
```

**Treasury buckets as direct Business relations**: Treasury bucket DVAs are scoped directly to a Business (via `businessId` on Account), not through a Customer. They use `Account.accountType = TREASURY_BUCKET` and an optional `bucketType` discriminator (PAYROLL, TAX_RESERVE, OPERATIONS, MARKETING, SAVINGS, CUSTOM). This design allows direct RELEASE_FUNDS rules to target buckets and keeps the ledger/audit infrastructure unified.

**Nomba credential isolation:**
Every Nomba API call made by AccountOS uses the credentials belonging to the business
that owns the resource. `NombaClientService` accepts a `Business` object and uses
`business.nombaClientId`, `business.nombaClientSecret`, and `business.nombaAccountId`
for every outbound call. Token cache is keyed by `businessId`.

This means:
- Business A's virtual accounts and treasury buckets are created under Business A's Nomba account
- Business A's customers' payments land in Business A's Nomba wallet
- AccountOS never holds, pools, or has access to funds
- Each business's Nomba token lifecycle is independent

**How scoping works in practice:**

1. Request arrives with `x-api-key: ako_live_abc123`
2. `ApiKeyGuard` hashes the key, looks up `ApiKey` record, loads `business`
3. `businessId` is attached to `request.business`
4. Every service method receives `businessId` and appends it to every Prisma query:
   ```typescript
   // Wrong — no tenancy
   prisma.account.findUnique({ where: { accountRef } })

   // Correct — scoped
   prisma.account.findFirst({ where: { accountRef, customer: { businessId } } })
   // For treasury buckets:
   prisma.account.findFirst({ where: { accountRef, businessId, accountType: 'TREASURY_BUCKET' } })
   ```
5. If a business tries to access another business's `accountRef` or `bucketRef`, the query returns null → 404. No data leaks.

---

## 4. Authentication Flow

### Business Registration (once)
```
POST /businesses
{ "name": "AjoApp Ltd", "email": "dev@ajoapp.ng" }
→ { "businessId": "biz_01J...", "name": "AjoApp Ltd" }
```

### Credentials Update (mock → production graduation)
```
PATCH /businesses/:id/credentials
Headers: x-admin-secret: <ADMIN_SECRET>
{
  "nombaAccountId": "their_parent_account_id",
  "nombaClientId":  "their_client_id",
  "nombaClientSecret": "their_client_secret",
  "nombaWebhookSecret": "their_webhook_hmac_secret"
}
→ { "businessId": "biz_01J...", "name": "AjoApp Ltd", "hasNombaCredentials": true }
```

All fields are optional — only provided fields are updated. Once `hasNombaCredentials` is
`true`, set `NOMBA_MOCK_MODE=false` to go live.

### API Key Generation
```
POST /api-keys
Headers: x-admin-secret: <ADMIN_SECRET env var>
{ "businessId": "biz_01J...", "name": "Production Key" }
→ {
    "keyId": "key_01J...",
    "key": "ako_live_a3f8c2...",   ← shown ONCE, never again
    "prefix": "ako_live_a3f",
    "name": "Production Key"
  }
```

Raw key is generated, shown once, and discarded. Only `SHA-256(key)` stored in DB.

### Every Subsequent Request
```
GET /accounts/ajo-amaka-jan/state
Headers: x-api-key: ako_live_a3f8c2...

ApiKeyGuard:
  1. Extract raw key from header
  2. hash = SHA-256(rawKey)
  3. apiKey = prisma.apiKey.findUnique({ where: { keyHash: hash } })
  4. Check: exists, not revoked, not expired
  5. Attach apiKey.business to request
  6. Update lastUsedAt async (fire-and-forget)
  7. Proceed to controller
```

---

## 5. Async Webhook Processing

Nomba expects `200 OK` within 2 seconds or it retries. Processing a webhook (DB reads, rule evaluation, Nomba API calls) can take longer. Solution: decouple receive from process.

```
POST /webhooks/nomba
  │
  1. Verify HMAC signature → reject if invalid
  2. Enqueue job to BullMQ queue 'webhook-processing'
  3. Return 200 OK immediately  ← Nomba is satisfied here
  │
  (async, in WebhookProcessor worker)
  4. Check ProcessedEvent for eventId → discard if duplicate (EC-04)
  5. Find Account by accountNumber
  6. Check Account.status → if SUSPENDED: write LedgerEntry as FLAGGED, write audit log, stop (do not evaluate rules)
  7. Fetch Customer
  8. Write LedgerEntry
  9. Load active Rules, RuleEngine.evaluate()
  10. RuleEngine.execute() → actions + retry queue for failures (EC-06)
  11. Update LedgerEntry reconciliation status
  12. Write AuditLog
  13. Insert ProcessedEvent (LAST)
```

Same pattern for `POST /accounts/:ref/events` — enqueue, return 200, process async.

---

## 6. Full Data Flows

### 6.1 Inflow Webhook (full async flow)

See §5 above. The key ordering rules:
- HMAC verification is **synchronous** — reject before enqueuing
- `ProcessedEvent` insert is **last** — if worker crashes mid-job, event re-processes safely
- `LedgerEntry` is written before rule evaluation — inflow is always recorded even if rules fail

### 6.2 Two-Tier DVA Allocation (Customer → RELEASE_FUNDS → Treasury Bucket)

When a customer DVA inflow arrives:
1. WebhookProcessor evaluates rules (§6.1 flow)
2. If a matched rule has `action: RELEASE_FUNDS` with `payload.destinationAccountRef` pointing to a treasury bucket:
   - Compute transfer amount: `floor(payload.percentage / 100 * inflowAmountKobo)` (if percentage-based)
   - Resolve destination account: `Account.findFirst({ accountRef, businessId, accountType: 'TREASURY_BUCKET' })`
   - Call `NombaClientService.transferFunds()` from customer DVA → treasury bucket DVA
   - On success: `RuleExecution.status = COMPLETED`, write OUTFLOW LedgerEntry on treasury bucket, write ALLOCATE_FUNDS AuditLogEntry
   - On failure: enqueue retry job (EC-06)

This direct two-tier flow avoids master-account hops. The funds flow: **Nomba → Customer DVA → Nomba → Treasury Bucket DVA**, all within the business's own Nomba wallet.

### 6.3 KYC Tier Change (EC-03)
```
PATCH /customers/:id/kyc-tier
  1. Load Customer (scoped to businessId), snapshot currentTier
  2. Update Customer.kycTier
  3. Load all ACTIVE Rules where kycTierAtCreation != newTier AND account.customer.businessId = businessId
  4. Set each → FLAGGED_FOR_REVIEW
  5. AuditService.log(RULE_FLAGGED_KYC_CHANGE) per rule
  6. AuditService.log(KYC_TIER_CHANGED, { before, after })
  7. Return { customerId, previousTier, newTier, flaggedRuleIds }
```

### 6.4 Account Closure with Pending Executions (EC-02)
```
DELETE /accounts/:ref
  1. Scope check: account.customer.businessId === request.business.id
  2. Load RuleExecutions where status IN [PENDING, RETRYING]
  3. For each → status: ARCHIVED, archivedReason: CLOSED_BEFORE_COMPLETION
  4. Remove their BullMQ jobs
  5. NombaClientService.expireVirtualAccount()
  6. Account.status = CLOSED, closedAt = now()
  7. AuditService.log(ACCOUNT_CLOSED, { pendingExecutionsArchived: N })
  8. Return closure summary
```

### 6.5 Ajo Monthly Cycle Reset
```
POST /accounts/ajo-amaka-jan/events
{ "eventId": "reset-feb-2026-amaka", "eventName": "cycle_reset" }
  │
  (async worker)
  1. Check ProcessedEvent → discard if duplicate
  2. Load Account (scoped)
  3. Load Rules where trigger = CUSTOM_EVENT
  4. Filter where condition.eventName = "cycle_reset"
  5. Matched rule action = REACTIVATE_ACCOUNT
  6. AccountLifecycleService.reactivate():
     - Guard: reject if status is EXPIRED or CLOSED (terminal)
     - Account.status = ACTIVE
     - AuditService.log(ACCOUNT_REACTIVATED)
  7. Insert ProcessedEvent
  8. Return 200
```

### 6.6 Treasury Withdrawal (EC-07 Insufficient Balance Protection)
```
POST /treasury-buckets/:ref/withdraw
  1. Scope check: bucket.businessId === authenticated businessId
  2. Balance check: LedgerService.getBalance(bucketAccountId)
     → If balance < amountKobo: throw 422 INSUFFICIENT_BUCKET_BALANCE (no Nomba call)
  3. Write TREASURY_WITHDRAWAL_INITIATED AuditLogEntry (fire-and-forget)
  4. Database transaction:
     a. Write OUTFLOW LedgerEntry with reconciliationStatus: PENDING
     b. Call NombaClientService.transferFunds()
     c. If success: update LedgerEntry reconciliationStatus = MATCHED, log TREASURY_WITHDRAWAL_COMPLETED
     d. If failure: rollback OUTFLOW entry, log TREASURY_WITHDRAWAL_FAILED
  5. Return closure summary
```

---

## 7. NombaClient Mock Mode

For local development and Jest tests, real Nomba API calls are replaced with fixture responses.

```typescript
// Controlled by env var: NOMBA_MOCK_MODE=true
// NombaClientService checks this flag and returns mock data instead of calling Nomba

if (process.env.NOMBA_MOCK_MODE === 'true') {
  return {
    accountId: `mock_${Date.now()}`,
    accountNumber: `990${Math.floor(Math.random() * 9000000 + 1000000)}`,
    bankName: 'Nomba (Mock)',
    status: 'active'
  }
}
```

**Mock → Production graduation path:**
1. Register business without credentials: `POST /businesses { name, email }`
2. Build and test locally with `NOMBA_MOCK_MODE=true` — use `POST /demo/simulate-inflow` to fire synthetic inflows through the full pipeline
3. When ready for production: `PATCH /businesses/:id/credentials` with real Nomba credentials → `hasNombaCredentials: true`
4. Set `NOMBA_MOCK_MODE=false` — live Nomba calls now use the business's own stored credentials

`POST /demo/simulate-inflow` is only available when `NOMBA_MOCK_MODE=true`. It constructs a Nomba-shaped inflow payload and enqueues it to the same `webhook-processing` queue — the `WebhookWorker` processes it identically to a real webhook, exercising the full ledger/rule/audit pipeline.

---

## 8. Error Codes (complete list)

Defined in `src/common/constants/error-codes.ts`:

```typescript
export const ErrorCodes = {
  // Auth
  MISSING_API_KEY:        'MISSING_API_KEY',
  INVALID_API_KEY:        'INVALID_API_KEY',
  API_KEY_REVOKED:        'API_KEY_REVOKED',
  API_KEY_EXPIRED:        'API_KEY_EXPIRED',
  INVALID_ADMIN_SECRET:   'INVALID_ADMIN_SECRET',
  // Validation
  VALIDATION_ERROR:       'VALIDATION_ERROR',
  INVALID_RULE_SET:       'INVALID_RULE_SET',
  // Business
  BUSINESS_NOT_FOUND:     'BUSINESS_NOT_FOUND',
  // Customer
  CUSTOMER_NOT_FOUND:     'CUSTOMER_NOT_FOUND',
  // Account
  ACCOUNT_NOT_FOUND:      'ACCOUNT_NOT_FOUND',
  ACCOUNT_NOT_ACTIVE:     'ACCOUNT_NOT_ACTIVE',
  ACCOUNT_ALREADY_CLOSED: 'ACCOUNT_ALREADY_CLOSED',
  ACCOUNT_TERMINAL_STATE: 'ACCOUNT_TERMINAL_STATE',  // cannot reactivate EXPIRED/CLOSED
  DUPLICATE_ACCOUNT_REF:  'DUPLICATE_ACCOUNT_REF',
  // Rules
  RULE_NOT_FOUND:         'RULE_NOT_FOUND',
  RULE_CONFLICT:          'RULE_CONFLICT',
  PERCENTAGE_SUM_EXCEEDS_100: 'PERCENTAGE_SUM_EXCEEDS_100',  // EC-08: PARALLEL release_funds sum > 100
  // Treasury
  INSUFFICIENT_BUCKET_BALANCE: 'INSUFFICIENT_BUCKET_BALANCE',  // EC-07: withdrawal > balance (422)
  BUCKET_NOT_FOUND:            'BUCKET_NOT_FOUND',              // 404
  // Nomba
  NOMBA_API_ERROR:        'NOMBA_API_ERROR',
  INVALID_WEBHOOK_SIGNATURE: 'INVALID_WEBHOOK_SIGNATURE',
  // Demo / dev
  DEMO_MODE_ONLY:         'DEMO_MODE_ONLY',  // POST /demo/simulate-inflow called outside demo mode
  // Generic
  INTERNAL_ERROR:         'INTERNAL_ERROR',
} as const

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes]
```

All errors return:
```json
{
  "statusCode": 404,
  "code": "ACCOUNT_NOT_FOUND",
  "message": "No account found with ref: ajo-amaka-jan",
  "timestamp": "2026-06-18T12:00:00.000Z",
  "path": "/api/v1/accounts/ajo-amaka-jan/state",
  "requestId": "req_01J..."
}
```

---

## 9. Environment Variables (complete)

```
# Database
DATABASE_URL=postgresql://accountos:accountos@localhost:5432/accountos

# Redis
REDIS_URL=redis://localhost:6379

# Nomba API
NOMBA_API_BASE_URL=https://api.nomba.com/v1
NOMBA_CLIENT_ID=
NOMBA_CLIENT_SECRET=
NOMBA_ACCOUNT_ID=
NOMBA_WEBHOOK_HMAC_SECRET=
NOMBA_MOCK_MODE=true        # set false to use live Nomba API

# Demo & Webhook Echo
DEMO_MODE_ENABLED=true       # enables POST /demo/simulate-inflow (independent from NOMBA_MOCK_MODE)
DEMO_WEBHOOK_URL=http://localhost:3000/demo/webhook-echo  # for webhook echo endpoint

# AccountOS
ADMIN_SECRET=change-me-in-prod   # protects POST /businesses and POST /api-keys
PORT=3000
NODE_ENV=development
APP_VERSION=1.0.0               # exposed in GET /health
```
