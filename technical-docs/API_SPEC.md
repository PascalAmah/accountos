# AccountOS — API Specification

**Base URL:** `/api/v1`
**Auth:** All endpoints require `x-api-key` header (except `POST /webhooks/nomba` and admin routes)
**Format:** All requests and responses are `application/json`
**Amounts:** Always in kobo (integer). Display conversion (`÷ 100`) is client-side only.

> **Rule condition shape authority:** `rule-schema.ts` is the single source of truth for valid rule
> structures. The Zod schemas there are enforced at the API boundary — if it doesn't pass
> `validateRuleSet()`, it is rejected with `400 INVALID_RULE_SET`.

---

## Treasury Buckets

Treasury buckets are **logical sub-ledgers** provisioned by a business for fund allocation — they are NOT Nomba virtual accounts. Money physically stays in the business's own Nomba account; a bucket only records how funds are logically owned (see `technical-docs/TREASURY_BUILD.md`). Buckets are direct business resources (no `Customer`). Balance is credited by `RELEASE_FUNDS` rules on customer DVAs (an internal ledger write — no Nomba call) and debited by bucket-to-bucket transfers and external-bank settlements (withdrawals).

### POST /treasury-buckets
Provision a new treasury bucket.

**Request:**
```json
{
  "bucketRef": "payroll-q3-2026",
  "name": "Q3 Payroll Reserve",
  "bucketType": "PAYROLL",
  "description": "Accumulated payroll for Q3 2026",
  "settlementType": "BANK_ACCOUNT",
  "settlementAccountNumber": "0123456789",
  "settlementBankCode": "044",
  "settlementAccountName": "AjoApp Payroll"
}
```

> `bucketType` must be one of: `PAYROLL`, `TAX_RESERVE`, `OPERATIONS`, `MARKETING`, `SAVINGS`, `CUSTOM`.
> `bucketRef` must be unique per business.
> Settlement fields are optional. When `settlementType` is `BANK_ACCOUNT`, withdrawals may omit the destination and fall back to these saved values.

**Response 201:**
```json
{
  "id": "clx...",
  "bucketRef": "payroll-q3-2026",
  "bucketType": "PAYROLL",
  "name": "Q3 Payroll Reserve",
  "description": "Accumulated payroll for Q3 2026",
  "status": "ACTIVE",
  "balanceKobo": 0,
  "createdAt": "2026-06-18T..."
}
```

---

### GET /treasury-buckets
List all treasury buckets for the authenticated business.

**Query params:**
- `status` — optional `AccountStatus` filter
- `page` — default `1`
- `limit` — default `20`, max `100`

**Response 200:**
```json
{
  "data": [ /* TreasuryBucket[] */ ],
  "meta": { "total": 3, "page": 1, "limit": 20, "totalPages": 1 }
}
```

---

### GET /treasury-buckets/:bucketRef
Get details of a single treasury bucket (with ledger-computed balance).

**Response 200:**
```json
{
  "id": "clx...",
  "bucketRef": "payroll-q3-2026",
  "bucketType": "PAYROLL",
  "name": "Q3 Payroll Reserve",
  "description": "Accumulated payroll for Q3 2026",
  "status": "ACTIVE",
  "balanceKobo": 50000000,
  "createdAt": "2026-06-18T..."
}
```

---

### PATCH /treasury-buckets/:bucketRef
Rename a treasury bucket.

**Request:**
```json
{
  "name": "Updated Payroll Reserve"
}
```

**Response 200:** Updated bucket object

---

### DELETE /treasury-buckets/:bucketRef
Close a treasury bucket. The bucket must have a **zero balance** — settle or transfer funds out first.

**Response 200:**
```json
{
  "id": "clx...",
  "bucketRef": "payroll-q3-2026",
  "status": "CLOSED",
  "closedAt": "2026-06-18T..."
}
```

---

### GET /treasury-buckets/:bucketRef/balance
Get the current balance of a treasury bucket (ledger-computed).

**Response 200:**
```json
{
  "bucketRef": "payroll-q3-2026",
  "balanceKobo": 50000000
}
```

> Balance is computed as `SUM(CREDIT BucketLedgerEntry.amountKobo) - SUM(DEBIT BucketLedgerEntry.amountKobo)`.
> No Nomba API call is made — the bucket ledger is the source of truth.

---

### GET /treasury-buckets/:bucketRef/statement
Get the bucket ledger (append-only entries) for a treasury bucket.

**Query params:**
- `from` — ISO8601 datetime (inclusive)
- `to` — ISO8601 datetime (inclusive)
- `entryType` — `CREDIT` | `DEBIT`
- `cursor` — pagination cursor (entry `id`)
- `limit` — default `50`, max `100`

**Response 200:**
```json
{
  "data": [ /* BucketLedgerEntry[] ordered by createdAt DESC */ ],
  "nextCursor": "clx..."
}
```

---

### POST /treasury-buckets/:bucketRef/transfer
Move funds from this bucket to another bucket in the same business. Pure internal ledger operation — **no Nomba call**. Debits the source and credits the destination atomically.

**Request:**
```json
{
  "destinationBucketRef": "tax-reserve",
  "amountKobo": 2500000,
  "narration": "Move surplus operating funds to reserve"
}
```

**Response 200:**
```json
{
  "reference": "xfer_...",
  "amountKobo": 2500000,
  "sourceBalanceKobo": 47500000,
  "destinationBalanceKobo": 2500000,
  "status": "COMPLETED"
}
```

---

### POST /treasury-buckets/:bucketRef/withdraw
Settle funds out of a treasury bucket to an **external bank account** (EC-07). This is the only Nomba call in the treasury layer. The bucket row is locked for the duration of the balance check + debit to prevent concurrent overdraw.

**Request:**
```json
{
  "amountKobo": 10000000,
  "destinationAccountNumber": "0123456789",
  "destinationBankCode": "044",
  "destinationAccountName": "AjoApp Payroll",
  "narration": "Payroll disbursement"
}
```

> Destination bank fields are optional if the bucket has a saved `BANK_ACCOUNT` settlement destination; otherwise all three are required.

**Response 200:**
```json
{
  "transactionRef": "wdr_...",
  "amountKobo": 10000000,
  "status": "COMPLETED"
}
```

**Error: Insufficient balance (EC-07)**
```json
{
  "statusCode": 422,
  "code": "INSUFFICIENT_BUCKET_BALANCE",
  "message": "Insufficient bucket balance. Required: 100000000 kobo, Available: 50000000 kobo",
  "timestamp": "2026-06-18T...",
  "path": "/api/v1/treasury-buckets/payroll-q3-2026/withdraw",
  "requestId": "req_01J..."
}
```

---



These endpoints use `x-admin-secret` header (not `x-api-key`). They are `@Public()` — the
`ApiKeyGuard` is bypassed.

### POST /businesses
Register a new business tenant.

**Headers:** `x-admin-secret: <ADMIN_SECRET>`

**Request:**
```json
{
  "name": "AjoApp Ltd",
  "email": "dev@ajoapp.ng",
  "nombaAccountId": "their_nomba_parent_account_id",
  "nombaClientId": "their_nomba_client_id",
  "nombaClientSecret": "their_nomba_client_secret",
  "nombaWebhookSecret": "their_nomba_webhook_hmac_secret",
  "webhookUrl": "https://ajoapp.ng/hooks/accountos"
}
```

> `nombaAccountId`, `nombaClientId`, `nombaClientSecret`, and `nombaWebhookSecret` are the
> business's own Nomba credentials. AccountOS uses these to create and manage virtual accounts
> on their behalf. Each business's funds flow into their own Nomba wallet — AccountOS never
> holds or pools funds.
> All Nomba credential fields are optional to allow mock-mode onboarding during development.

**Response 201:**
```json
{
  "businessId": "clx...",
  "name": "AjoApp Ltd"
}
```

---

### PATCH /businesses/:id/credentials
Update Nomba credentials for an existing business. Use this to graduate a mock-mode business
to production by adding real Nomba credentials — or to rotate credentials without
re-registering.

**Headers:** `x-admin-secret: <ADMIN_SECRET>`

**Request:**
```json
{
  "nombaAccountId": "their_nomba_parent_account_id",
  "nombaClientId": "their_nomba_client_id",
  "nombaClientSecret": "their_nomba_client_secret",
  "nombaWebhookSecret": "their_nomba_webhook_hmac_secret",
  "webhookUrl": "https://ajoapp.ng/hooks/accountos"
}
```

> All fields are optional — only provided fields are updated. Fields not included in the
> request are left unchanged. This allows rotating a single credential (e.g. only
> `nombaWebhookSecret`) without touching the others.

**Response 200:**
```json
{
  "businessId": "clx...",
  "name": "AjoApp Ltd",
  "hasNombaCredentials": true
}
```

> `hasNombaCredentials` is `true` when all four Nomba credential fields
> (`nombaAccountId`, `nombaClientId`, `nombaClientSecret`, `nombaWebhookSecret`) are present.

---

### POST /api-keys
Generate an API key for a business. The raw key is shown **once** and never stored.

**Headers:** `x-admin-secret: <ADMIN_SECRET>`

**Request:**
```json
{
  "businessId": "clx...",
  "name": "Production Key"
}
```

**Response 201:**
```json
{
  "keyId": "clx...",
  "key": "ako_live_a3f8c2...",
  "prefix": "ako_live_a3f",
  "name": "Production Key"
}
```

> Store the `key` value now — it cannot be retrieved again.

---

### GET /api-keys
List all API keys for the authenticated business. Never returns `keyHash`.

**Response 200:**
```json
[
  {
    "id": "clx...",
    "prefix": "ako_live_a3f",
    "name": "Production Key",
    "lastUsedAt": "2026-06-18T...",
    "createdAt": "2026-06-01T...",
    "revokedAt": null
  }
]
```

---

### DELETE /api-keys/:id
Revoke an API key. Writes `API_KEY_REVOKED` audit log.

**Response 200:**
```json
{ "revoked": true }
```

---

## Customers

### POST /customers
Create a new customer identity.

**Request:**
```json
{
  "displayName": "Chidi Okeke",
  "bvnRef": "sha256:<hash-of-bvn>",
  "kycVerificationProvider": "Dojah",
  "kycVerificationRef": "verify_abc123",
  "email": "chidi@example.com",
  "phone": "+2348012345678",
  "parentId": null
}
```

> **KYC tier is derived automatically — do not pass `kycTier` on creation:**
> - If `bvnRef` is provided → customer is created at `TIER_1` (BVN-linked)
> - If `bvnRef` is omitted → customer is created at `TIER_0` (unverified)
>
> This reflects the reality that a business's app may collect the BVN at registration time
> and pass it straight through. AccountOS tracks that as a tier promotion automatically.
> To upgrade beyond `TIER_1` later, use `PATCH /customers/:id/kyc-tier`.

> `bvnRef` must be a SHA-256 hash of the BVN — never the raw BVN. AccountOS does not
> validate BVNs. The business is responsible for verifying identity via their own KYC
> provider (Dojah, Prembly, Smile ID, etc.) before calling this endpoint.

**Response 201 — with BVN (TIER_1):**
```json
{
  "customerId": "clx...",
  "displayName": "Chidi Okeke",
  "kycTier": "TIER_1",
  "nameHistory": [
    {
      "id": "clx...",
      "previousName": "",
      "newName": "Chidi Okeke",
      "reason": null,
      "changedBy": "system",
      "changedAt": "2026-06-18T..."
    }
  ],
  "createdAt": "2026-06-18T..."
}
```

**Response 201 — without BVN (TIER_0):**
```json
{
  "customerId": "clx...",
  "displayName": "Chidi Okeke",
  "kycTier": "TIER_0",
  "nameHistory": [
    {
      "id": "clx...",
      "previousName": "",
      "newName": "Chidi Okeke",
      "reason": null,
      "changedBy": "system",
      "changedAt": "2026-06-18T..."
    }
  ],
  "createdAt": "2026-06-18T..."
}
```

---

### GET /customers/:customerId
Returns customer details plus linked accounts summary.

**Response 200:**
```json
{
  "customerId": "clx...",
  "displayName": "Chidi Okeke",
  "kycTier": "TIER_1",
  "email": "chidi@example.com",
  "phone": "+2348012345678",
  "parentId": null,
  "nameHistory": [ /* NameHistoryEntry[] */ ],
  "accounts": [
    {
      "accountRef": "ajo-chidi-jan",
      "status": "ACTIVE",
      "accountNumber": "9901234567",
      "createdAt": "2026-06-01T..."
    }
  ],
  "createdAt": "2026-06-18T..."
}
```

---

### PATCH /customers/:customerId/name
Rename a customer. Appends a `NameHistoryEntry` — never overwrites past entries (EC-01).

**Request:**
```json
{
  "newName": "Chidi Okeke Trading Ltd",
  "reason": "Business registration"
}
```

**Response 200:** Updated customer object (same shape as `GET /customers/:customerId`)

**Side effect:** Writes `CUSTOMER_RENAMED` audit log with `before`/`after` snapshots.

---

### PATCH /customers/:customerId/kyc-tier
Update KYC tier. Automatically flags rules whose `kycTierAtCreation` no longer matches (EC-03).

AccountOS does not perform KYC verification. The business must verify the customer via their
own KYC provider before calling this endpoint. `verificationProvider` and `verificationRef`
are stored as a compliance reference only.

**Tier progression model:**

| From | To | Typical trigger |
|---|---|---|
| `TIER_0` | `TIER_1` | BVN submitted after initial registration (`reason: BVN_VERIFIED`) |
| `TIER_1` | `TIER_2` | NIN or address verified by KYC provider (`reason: NIN_VERIFIED` or `ADDRESS_VERIFIED`) |
| `TIER_2` | `TIER_3` | Business registration or enhanced due diligence (`reason: BUSINESS_VERIFIED` or `ENHANCED_DUE_DILIGENCE`) |
| any | lower | Compliance downgrade or manual review (`reason: TIER_DOWNGRADED` or `MANUAL_COMPLIANCE_REVIEW`) |

> Note: `TIER_1` is normally auto-assigned at creation when `bvnRef` is provided. Use this
> endpoint for `TIER_1` only when BVN was not submitted at registration time.

**Request:**
```json
{
  "kycTier": "TIER_2",
  "verificationProvider": "Prembly",
  "verificationRef": "kyc_987654",
  "reason": "NIN_VERIFIED"
}
```

> `verificationProvider`, `verificationRef`, and `reason` are optional.
> Supported `reason` values: `BVN_VERIFIED`, `NIN_VERIFIED`, `ADDRESS_VERIFIED`,
> `BUSINESS_VERIFIED`, `ENHANCED_DUE_DILIGENCE`, `TIER_DOWNGRADED`, `MANUAL_COMPLIANCE_REVIEW`

**Response 200:**
```json
{
  "customerId": "clx...",
  "previousTier": "TIER_1",
  "newTier": "TIER_2",
  "flaggedRuleIds": ["clx-rule-1", "clx-rule-2"]
}
```

**Side effects:**
- Rules with `kycTierAtCreation != newTier` → `FLAGGED_FOR_REVIEW` status
- Writes `KYC_TIER_CHANGED` audit log
- Writes `RULE_FLAGGED_KYC_CHANGE` audit log per flagged rule

---

## Virtual Accounts

### POST /accounts
Provision a new virtual account via Nomba + attach an optional rule set.

**Request:**
```json
{
  "customerId": "clx...",
  "accountRef": "ajo-chidi-jan",
  "accountName": "Chidi Okeke - Ajo Fund",
  "executionModel": "SEQUENTIAL",
  "rules": [
    {
      "trigger": "inflow_received",
      "condition": { "amount_gte": 5000000 },
      "action": "suspend_account",
      "priority": 0
    },
    {
      "trigger": "inflow_received",
      "condition": { "cumulative_gte": 60000000 },
      "action": "notify_webhook",
      "payload": { "url": "https://yourbusiness.com/hooks/pot-complete" },
      "priority": 1
    }
  ]
}
```

> `executionModel` must be `SEQUENTIAL` or `PARALLEL`.
> All `condition` amount values are in **kobo**. ₦50,000 = `5000000`.
> Rule shape is validated against `rule-schema.ts`. Invalid rules return `400 INVALID_RULE_SET`.

**Example: Percentage-based fund allocation to treasury buckets**
```json
{
  "customerId": "clx...",
  "accountRef": "school-fees-sept-2026",
  "accountName": "School Fees Collection - September 2026",
  "executionModel": "PARALLEL",
  "rules": [
    {
      "trigger": "inflow_received",
      "condition": { "amount_gte": 0 },
      "action": "release_funds",
      "payload": { "destinationAccountRef": "treasury-payroll", "percentage": 60 },
      "priority": 0
    },
    {
      "trigger": "inflow_received",
      "condition": { "amount_gte": 0 },
      "action": "release_funds",
      "payload": { "destinationAccountRef": "treasury-tax-reserve", "percentage": 25 },
      "priority": 1
    },
    {
      "trigger": "inflow_received",
      "condition": { "amount_gte": 0 },
      "action": "release_funds",
      "payload": { "destinationAccountRef": "treasury-savings", "percentage": 15 },
      "priority": 2
    }
  ]
}
```

> When `percentage` is set, the transfer amount is calculated as `floor(percentage / 100 * inflow.amountKobo)`.
> Multiple PARALLEL `release_funds` rules must have SUM(percentage) ≤ 100 (EC-08).
> `percentage` and `amountKobo` are mutually exclusive in the payload.

**Response 201:**
```json
{
  "accountRef": "ajo-chidi-jan",
  "nombaAccountId": "nomba_internal_id",
  "accountNumber": "9901234567",
  "bankName": "Nomba MFB",
  "accountNameAtCreation": "Chidi Okeke - Ajo Fund",
  "customerId": "clx...",
  "status": "ACTIVE",
  "executionModel": "SEQUENTIAL",
  "rules": [
    {
      "id": "clx-rule-1",
      "trigger": "inflow_received",
      "condition": { "amount_gte": 5000000 },
      "action": "suspend_account",
      "priority": 0,
      "status": "ACTIVE",
      "kycTierAtCreation": "TIER_1"
    }
  ],
  "createdAt": "2026-06-18T..."
}
```

> The request field `accountName` is stored as `accountNameAtCreation` — an immutable snapshot
> that never changes after creation. All responses (201 and `GET /accounts/:ref/state`) return
> it as `accountNameAtCreation`.

---

### GET /accounts
List accounts for the authenticated business.

**Query params:**
- `status` — filter: `ACTIVE` | `SUSPENDED` | `EXPIRED` | `CLOSED`
- `page` — default `1`
- `limit` — default `20`, max `100`

**Response 200:**
```json
{
  "data": [ /* Account[] */ ],
  "pagination": { "total": 12, "page": 1, "limit": 20 }
}
```

---

### GET /accounts/:accountRef/state
Rich state summary of an account.

**Response 200:**
```json
{
  "account": {
    "accountRef": "ajo-chidi-jan",
    "nombaAccountId": "...",
    "accountNumber": "9901234567",
    "bankName": "Nomba MFB",
    "status": "SUSPENDED",
    "executionModel": "SEQUENTIAL",
    "accountNameAtCreation": "Chidi Okeke - Ajo Fund",
    "closedAt": null,
    "createdAt": "2026-06-01T..."
  },
  "customer": {
    "customerId": "clx...",
    "displayName": "Chidi Okeke",
    "kycTier": "TIER_1"
  },
  "ruleset": {
    "executionModel": "SEQUENTIAL",
    "rules": [ /* Rule[] ordered by priority ASC */ ]
  },
  "summary": {
    "totalInflows": 3,
    "totalAmountKobo": 15000000,
    "totalAmountNgn": 150000,
    "lastInflowAt": "2026-06-17T...",
    "pendingRuleExecutions": 0,
    "flaggedRules": 0
  }
}
```

---

### PATCH /accounts/:accountRef/status
Manually override account status. Cannot set `CLOSED` or `EXPIRED` here — use `DELETE` for closure.
Cannot reactivate a `CLOSED` or `EXPIRED` account (`400 ACCOUNT_TERMINAL_STATE`).

**Request:**
```json
{
  "status": "SUSPENDED",
  "reason": "Manual hold by admin"
}
```

**Response 200:** Updated account object

**Side effect:** Writes `ACCOUNT_STATUS_OVERRIDE` audit log with `before`/`after` and `reasonCode`.

---

### DELETE /accounts/:accountRef
Close an account. Archives all `PENDING` and `RETRYING` rule executions (EC-02).

**Response 200:**
```json
{
  "accountRef": "ajo-chidi-jan",
  "status": "CLOSED",
  "pendingExecutionsArchived": 2,
  "archivedRuleExecutionIds": ["clx-exec-1", "clx-exec-2"]
}
```

**Side effects:**
- All `PENDING`/`RETRYING` `RuleExecution` records → `ARCHIVED` with `archivedReason: CLOSED_BEFORE_COMPLETION`
- Their BullMQ jobs are removed
- `NombaClientService.expireVirtualAccount()` is called
- Writes `ACCOUNT_CLOSED` audit log

---

## Rules

### PUT /accounts/:accountRef/rules
Replace the entire rule set on an account. Existing `ACTIVE` rules are archived with
`archivedReason: SUPERSEDED_BY_UPDATE`. New rules are created with `kycTierAtCreation` snapshotted
from the customer's current tier.

**Request:**
```json
{
  "executionModel": "PARALLEL",
  "rules": [
    {
      "trigger": "inflow_received",
      "condition": { "amount_gte": 10000000 },
      "action": "notify_webhook",
      "payload": { "url": "https://yourbusiness.com/hooks/large-payment" },
      "priority": 0
    }
  ]
}
```

> `accountRef` is taken from the URL — do not include it in the body.
> Rule shape validated against `rule-schema.ts` before any DB write.

**Response 200:**
```json
{
  "executionModel": "PARALLEL",
  "rules": [ /* new Rule[] with ids */ ]
}
```

**Side effect:** Writes `RULES_UPDATED` audit log.

---

### PATCH /accounts/:accountRef/rules/:ruleId
Re-enable or archive a single rule. Primarily used to re-enable a `FLAGGED_FOR_REVIEW` rule
after manual review following a KYC tier change (EC-03).

**Request:**
```json
{ "enabled": true }
```

> `enabled: true` → sets status back to `ACTIVE` (only valid from `FLAGGED_FOR_REVIEW`)
> `enabled: false` → sets status to `ARCHIVED` with `archivedReason: MANUALLY_ARCHIVED`

**Response 200:** Updated rule object

---

### DELETE /accounts/:accountRef/rules/:ruleId
Archive a rule. Sets `status: ARCHIVED`, `archivedReason: MANUALLY_ARCHIVED`.

**Response 200:**
```json
{ "archived": true, "ruleId": "clx-rule-1" }
```

**Side effect:** Writes `RULE_ARCHIVED` audit log.

---

## Events (Business-originated)

### POST /accounts/:accountRef/events
Trigger a custom business event against an account (e.g. `delivery_confirmed`, `cycle_reset`,
`dispute_raised`). Enqueued to BullMQ — returns `200` immediately (EC-04 idempotency applies).

**Request:**
```json
{
  "eventId": "evt-reset-feb-2026-chidi",
  "eventName": "cycle_reset"
}
```

> `eventId` must be unique per business. Duplicate `eventId` is silently discarded —
> rule evaluation runs exactly once.

**Response 200:**
```json
{ "received": true }
```

---

## Ledger

### GET /accounts/:accountRef/ledger
Paginated inflow ledger entries for an account.

**Query params:**
- `from` — ISO8601 datetime (inclusive, filters on `receivedAt`)
- `to` — ISO8601 datetime (inclusive)
- `reconciliationStatus` — `PENDING` | `MATCHED` | `UNMATCHED` | `FLAGGED`
- `page` — default `1`
- `limit` — default `20`, max `100`

**Response 200:**
```json
{
  "data": [
    {
      "entryId": "clx...",
      "nombaTransactionRef": "NMB-TXN-001",
      "direction": "INFLOW",
      "amountKobo": 5000000,
      "amountNgn": 50000,
      "currency": "NGN",
      "senderName": "Emeka Nwosu",
      "senderAccountNumber": "0123456789",
      "senderBankCode": "044",
      "narration": "Ajo contribution June",
      "customerNameSnapshot": "Chidi Okeke",
      "kycTierAtTime": "TIER_1",
      "cumulativeAmountKobo": 15000000,
      "reconciliationStatus": "MATCHED",
      "receivedAt": "2026-06-17T..."
    }
  ],
  "pagination": { "total": 3, "page": 1, "limit": 20 }
}
```

---

### GET /accounts/:accountRef/ledger/summary

**Response 200:**
```json
{
  "accountRef": "ajo-chidi-jan",
  "totalInflows": 3,
  "totalAmountKobo": 15000000,
  "totalAmountNgn": 150000,
  "lastInflowAt": "2026-06-17T...",
  "reconciliationBreakdown": {
    "matched": 2,
    "unmatched": 1,
    "flagged": 0
  }
}
```

---

### GET /accounts/:accountRef/ledger/export
CSV export of ledger entries. Accepts same query params as `GET /ledger`.

**Response headers:**
```
Content-Type: text/csv
Content-Disposition: attachment; filename="ledger-ajo-chidi-jan-2026-06-18.csv"
```

**CSV columns (in order):**
```
entryId, nombaTransactionRef, direction, amountNgn, currency, senderName,
customerNameSnapshot, kycTierAtTime, reconciliationStatus, receivedAt
```

---

## Audit Log

### GET /accounts/:accountRef/audit
Full audit trail for an account ordered by `occurredAt DESC`.

**Query params:**
- `action` — filter by `AuditAction` enum value (e.g. `ACCOUNT_CLOSED`, `CUSTOMER_RENAMED`)
- `from` / `to` — ISO8601 datetime range
- `page` — default `1`
- `limit` — default `20`, max `100`

**Response 200:**
```json
{
  "data": [
    {
      "auditId": "clx...",
      "action": "CUSTOMER_RENAMED",
      "actor": "ako_live_a3f",
      "beforeState": { "displayName": "Chidi Okeke" },
      "afterState": { "displayName": "Chidi Okeke Trading Ltd" },
      "reasonCode": null,
      "metadata": { "reason": "Business registration" },
      "requestId": "req_01J...",
      "occurredAt": "2026-06-18T..."
    }
  ],
  "pagination": { "total": 12, "page": 1, "limit": 20 }
}
```

> `action` values match the `AuditAction` enum in `schema.prisma` exactly (uppercase).

---

## Webhooks

### POST /webhooks/nomba
Receives inflow notifications from Nomba in production. No `x-api-key` required — validated
via HMAC-SHA256 signature. Returns `200` immediately after signature verification and enqueue
(EC-04).

**Headers:**
- `x-nomba-signature` — HMAC-SHA256 hex digest of the raw request body, keyed with the
  business's `nombaWebhookSecret`

> AccountOS resolves the correct business by looking up the `accountNumber` in the payload
> against its accounts table, then uses that business's `nombaWebhookSecret` for HMAC
> verification. This means each business's webhook is verified with their own signing secret.

**Request (Nomba payload shape):**
```json
{
  "eventId": "evt_abc123",
  "eventType": "VIRTUAL_ACCOUNT_PAYMENT",
  "data": {
    "transactionRef": "NMB-TXN-001",
    "accountNumber": "9901234567",
    "amount": 5000000,
    "currency": "NGN",
    "senderName": "Emeka Nwosu",
    "senderAccountNumber": "0123456789",
    "senderBankCode": "044",
    "narration": "Ajo contribution June",
    "createdAt": "2026-06-18T12:00:00Z"
  }
}
```

**Response:** Always `200 OK` (even for duplicates — return 200 to prevent Nomba retries).

```json
{ "received": true }
```

**Duplicate handling:** If `eventId` already exists in `ProcessedEvent`, returns `200` immediately
and writes a `DUPLICATE_EVENT_DISCARDED` audit log. Rule evaluation does **not** run.

**Bad signature:** Returns `401 INVALID_WEBHOOK_SIGNATURE`.

---

### POST /demo/simulate-inflow
Simulates a Nomba inflow webhook for local development and testing. Bypasses HMAC verification
and constructs a synthetic inflow event that flows through the **identical** async pipeline as
a real Nomba webhook (`WebhookWorker` → ledger → rule evaluation → audit).

**Availability:** Only available when `DEMO_MODE_ENABLED=true`. This flag is **independent** from `NOMBA_MOCK_MODE`.

- `NOMBA_MOCK_MODE=true` controls whether NombaClient returns fixture responses or calls the real Nomba API.
- `DEMO_MODE_ENABLED=true` controls whether the `POST /demo/simulate-inflow` endpoint is active.

You can have `NOMBA_MOCK_MODE=false` and `DEMO_MODE_ENABLED=true` (production Nomba + demo endpoint), or vice versa, or both enabled, or both disabled. They are orthogonal.

Returns `403 DEMO_MODE_ONLY` if `DEMO_MODE_ENABLED` is not `true`.

**Headers:** `x-admin-secret: <ADMIN_SECRET>`

**Request:**
```json
{
  "accountNumber": "9900000001",
  "amountKobo": 5000000,
  "senderName": "Emeka Nwosu",
  "senderAccountNumber": "0123456789",
  "senderBankCode": "044",
  "narration": "Ajo contribution June"
}
```

> `accountNumber` must match an account provisioned (in mock or real mode).
> `amountKobo` is in kobo — ₦50,000 = `5000000`.
> A unique `eventId` (`demo_<uuid>`) and `transactionRef` (`DEMO-TXN-<uuid>`) are
> auto-generated — no two simulate-inflow calls are ever treated as duplicates.

**Response 200:**
```json
{
  "received": true,
  "eventId": "demo_01J...",
  "transactionRef": "DEMO-TXN-01J..."
}
```

> The pipeline is async — this response confirms the job was enqueued. Query
> `GET /accounts/:ref/state` or `GET /accounts/:ref/ledger` after ~100ms to see results.

**Error cases:**
- `403 DEMO_MODE_ONLY` — `DEMO_MODE_ENABLED` is not `true`
- `401 INVALID_ADMIN_SECRET` — wrong `x-admin-secret`
- `400 VALIDATION_ERROR` — missing required fields

---

## Standard Error Responses

All errors follow this shape:

```json
{
  "statusCode": 404,
  "code": "ACCOUNT_NOT_FOUND",
  "message": "No virtual account found with ref: ajo-chidi-jan",
  "timestamp": "2026-06-18T12:00:00.000Z",
  "path": "/api/v1/accounts/ajo-chidi-jan/state",
  "requestId": "req_01J..."
}
```

| HTTP | Code | When |
|------|------|------|
| 400 | `VALIDATION_ERROR` | Request body failed `class-validator` DTO validation |
| 400 | `INVALID_RULE_SET` | Rule body failed `validateRuleSet()` Zod validation |
| 400 | `PERCENTAGE_SUM_EXCEEDS_100` | Multiple PARALLEL `release_funds` rules have SUM(percentage) > 100 (EC-08) |
| 401 | `MISSING_API_KEY` | No `x-api-key` header |
| 401 | `INVALID_API_KEY` | Key hash not found |
| 401 | `API_KEY_REVOKED` | Key has been revoked |
| 401 | `API_KEY_EXPIRED` | Key has passed `expiresAt` |
| 401 | `INVALID_ADMIN_SECRET` | Wrong `x-admin-secret` on admin routes |
| 401 | `INVALID_WEBHOOK_SIGNATURE` | HMAC mismatch on `POST /webhooks/nomba` |
| 403 | `DEMO_MODE_ONLY` | `POST /demo/simulate-inflow` called when `DEMO_MODE_ENABLED` is not `true` |
| 404 | `BUSINESS_NOT_FOUND` | `businessId` not found |
| 404 | `CUSTOMER_NOT_FOUND` | `customerId` not found in this business |
| 404 | `ACCOUNT_NOT_FOUND` | `accountRef` not found in this business |
| 404 | `BUCKET_NOT_FOUND` | `bucketRef` not found in this business |
| 404 | `RULE_NOT_FOUND` | `ruleId` not found on this account |
| 409 | `DUPLICATE_ACCOUNT_REF` | `accountRef` already exists |
| 409 | `ACCOUNT_ALREADY_CLOSED` | Operation attempted on a closed/expired account |
| 409 | `ACCOUNT_TERMINAL_STATE` | Reactivation attempted on `CLOSED` or `EXPIRED` account |
| 422 | `INSUFFICIENT_BUCKET_BALANCE` | Treasury bucket balance < requested withdrawal amount (EC-07) |
| 422 | `NOMBA_API_ERROR` | Nomba API returned a non-2xx response |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

> Error codes match `ErrorCodes` in `src/common/constants/error-codes.ts` exactly.

---

## Rule Condition Reference

All conditions are validated by `rule-schema.ts` at write time. Invalid conditions return `400 INVALID_RULE_SET`.

### `inflow_received` conditions
At least one field required. All amounts in **kobo**.

| Field | Type | Meaning |
|---|---|---|
| `amount_gte` | `int` (kobo) | Inflow amount ≥ value |
| `amount_lte` | `int` (kobo) | Inflow amount ≤ value |
| `amount_lt` | `int` (kobo) | Inflow amount < value |
| `amount_eq` | `int` (kobo) | Inflow amount = value exactly |
| `cumulative_gte` | `int` (kobo) | Running total for account ≥ value |

### `time_elapsed` conditions
Requires `no_inflow_for_days` OR `no_event_for_days` (with `eventName`).

| Field | Type | Meaning |
|---|---|---|
| `no_inflow_for_days` | `int` | No inflow received in N days |
| `no_event_for_days` | `int` | No custom event of `eventName` in N days |
| `eventName` | `string` | Event name — required when using `no_event_for_days` |

### `tier_changed` conditions
Requires `fromTier` and/or `toTier`.

| Field | Type | Meaning |
|---|---|---|
| `fromTier` | `KycTier` | Previous tier |
| `toTier` | `KycTier` | New tier |

### `custom_event` conditions

| Field | Type | Meaning |
|---|---|---|
| `eventName` | `string` | Must match `eventName` in `POST /accounts/:ref/events` |

### Actions and their payloads

| Action | Payload required | Nomba API call |
|---|---|---|
| `suspend_account` | none | `suspendVirtualAccount()` |
| `reactivate_account` | none | none — status update only |
| `expire_account` | none | `expireVirtualAccount()` |
| `notify_webhook` | `{ "url": "https://..." }` | POST to `url` (fire-and-forget, 5s timeout) |
| `release_funds` | `{ "destinationAccountRef": "..." }` | `transfer()` |
| `flag_for_review` | none | none — status update only |
