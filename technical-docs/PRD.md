# AccountOS — Product Requirements Document

**Version:** 1.0  
**Track:** Nomba × DevCareer Hackathon — Infrastructure Track  
**Submission type:** Persistent Dedicated Virtual Account System  
**Related files:** `BUILD.md`, `schema.prisma`, `rule-schema.ts`

---

## 1. Problem Statement

Nomba's virtual account API gives a developer a *noun* — an account that exists, has a name, and receives money. It does not give a *verb with memory*: the ability to say "when this account receives money under these conditions, do something specific, remember it happened, and change behavior based on what has happened before."

Every business building on Nomba today re-implements the same missing layer themselves:

- Webhook handlers that reconcile inflows to specific customers
- Conditional logic to suspend accounts after thresholds are met
- Manual cumulative payment tracking
- Custom scripts for KYC-tier enforcement
- No shared audit trail for compliance or disputes

In Africa this pain is acute. Savings cooperatives (ajo/esusu), school fee collectors, rent agents, marketplace escrow operators, and microfinance institutions all run payment workflows that require **conditional, stateful, auditable** virtual account behavior. None of them have engineering teams large enough to build this from scratch per product.

**AccountOS fills this gap on two fronts:**

1. **Programmable Account Layer**: A state machine layer — a NestJS/TypeScript service that sits between Nomba's API and any business's system — turning static virtual accounts into intelligent, rule-driven, auditable financial infrastructure.

2. **Treasury Management Layer**: Businesses can provision treasury bucket DVAs (dedicated virtual accounts for payroll, tax reserves, savings pools, etc.), automatically split incoming customer payments across these buckets via percentage-based rules, and withdraw on demand to external bank accounts. No master-account hop; funds flow directly through the business's own Nomba wallet.

---

## 2. What AccountOS Is

Four capabilities added on top of Nomba's virtual account primitive that do not exist natively:

### 2.1 Identity Layer
Every virtual account is anchored to a `Customer` entity with:
- Persistent identity: KYC tier, BVN reference, optional parent-customer hierarchy (e.g. landlord → tenants)
- Versioned name history: every rename recorded with timestamp and reason — past entries are never modified
- Immutable snapshots: customer name and KYC tier are snapshotted onto every ledger entry so historical records never silently change meaning

**KYC tier model:**

| Tier | How assigned | Typical meaning |
|---|---|---|
| `TIER_0` | Default on creation when no `bvnRef` supplied | Unverified — plain registration |
| `TIER_1` | Auto-derived on creation when `bvnRef` is supplied | BVN-linked |
| `TIER_2` | Explicit `PATCH /customers/:id/kyc-tier` after NIN or address verification | Enhanced KYC |
| `TIER_3` | Explicit `PATCH /customers/:id/kyc-tier` after business or full KYC verification | Full KYC |

Tiers are never auto-upgraded beyond `TIER_1`. The business is responsible for running verification through their KYC provider (Dojah, Prembly, Smile ID, etc.) and calling the tier upgrade endpoint with the verification reference as evidence. AccountOS stores the reference for compliance — it never performs the verification itself.

### 2.2 Rules Engine
Developers attach declarative JSON rules to any virtual account. A rule is the intersection of:
- **Trigger:** what event causes evaluation (`INFLOW_RECEIVED`, `TIME_ELAPSED`, `TIER_CHANGED`, `CUSTOM_EVENT`)
- **Condition:** predicates on the event validated against `rule-schema.ts` at write time
- **Action:** what executes when conditions are met (`SUSPEND_ACCOUNT`, `REACTIVATE_ACCOUNT`, `EXPIRE_ACCOUNT`, `NOTIFY_WEBHOOK`, `RELEASE_FUNDS`, `FLAG_FOR_REVIEW`)
- **Priority + Execution Model:** `SEQUENTIAL` (stop on first match) or `PARALLEL` (all matches fire) — per account, deterministic, documented

Rules are validated by Zod at the API boundary — invalid rules are rejected before they touch the database, never discovered at execution time.

### 2.3 Persistent State + Audit
- **Immutable ledger:** every inflow written as append-only with full reconciliation metadata and customer name snapshot
- **Rule execution tracking:** every rule evaluation tracked from `PENDING → COMPLETED/FAILED`, with retry queue for Nomba API failures
- **Audit log:** every state change (rename, suspension, closure, tier change, rule execution) recorded with before/after snapshots — insert-only, never deleted

### 2.4 Treasury Layer

Businesses provision **logical treasury buckets** — internal sub-ledgers for distinct purposes (Payroll, Tax Reserve, Savings, Operations, Marketing, Custom). Buckets are NOT bank accounts or Nomba DVAs; money physically lives in the business's Nomba account, and buckets record logical ownership via an immutable bucket ledger.

When customer payments arrive, percentage-based **`RELEASE_FUNDS` rules** automatically allocate funds to buckets as pure ledger entries — no Nomba API call per allocation. Each business withdraws from buckets to external bank accounts on demand via the **Settlement lifecycle**: PENDING (reserves balance) → PROCESSING → COMPLETED (writes DEBIT + calls Nomba) or FAILED (releases reservation, no DEBIT written).

Key design points:
- **Logical-bucket architecture**: Buckets are internal sub-ledgers, not Nomba DVAs. A single business Nomba account holds all funds; buckets describe how funds are logically owned and allocated.
- **Allocation is ledger-only**: Inflows split to buckets via immutable BucketLedgerEntry writes. No Nomba API calls during allocation — allocation is a pure database operation.
- **Ledger-computed balance**: Bucket balance = latest BucketLedgerEntry.cumulativeAmountKobo (O(1) indexed lookup). Available balance = ledger balance − reserved balance (SUM of in-flight Settlement rows).
- **Settlement lifecycle**: The only Treasury operation that calls Nomba. Reservation prevents double-spend; DEBIT is written only after Nomba confirms the transfer (ADR #13). Failed settlements release the reservation without debiting the bucket.
- **Immutable bucket ledger**: BucketLedgerEntry rows are append-only (enforced by DB trigger). Balances are always derivable from the ledger.

---

## 3. Use Cases

### 3.1 Ajo/Esusu Rotating Savings *(flagship demo)*
Each member of a rotating savings group gets a dedicated virtual account bound to their `Customer` identity. Rules auto-suspend the account once the agreed contribution lands (preventing double payment), notify the admin once the full pot is collected, and trigger payout at cycle end. No manual intervention. No spreadsheets. Full audit trail.

```json
{
  "accountRef": "ajo-group-04-member-012",
  "executionModel": "SEQUENTIAL",
  "rules": [
    { "trigger": "inflow_received", "condition": { "amount_gte": 5000000 }, "action": "suspend_account", "priority": 0 },
    { "trigger": "inflow_received", "condition": { "cumulative_gte": 60000000 }, "action": "notify_webhook", "payload": { "url": "https://yourbusiness.com/hooks/pot-complete" }, "priority": 1 }
  ]
}
```
*(All amounts in kobo: ₦50,000 = 5,000,000 kobo. `executionModel` and `trigger`/`action` values are lowercase strings as accepted by the API — they map to uppercase Prisma enums internally.)*

### 3.2 Escrow for Marketplace / Freelance
A buyer pays into a virtual account tied to a specific order. Funds are held. Release happens on `delivery_confirmed` (business-originated custom event via `POST /accounts/:ref/events`) or after 7 days with no dispute raised (`TIME_ELAPSED`). If `dispute_raised` arrives instead, the account transitions to `FLAG_FOR_REVIEW`. The same rule engine, ledger, and audit log that run Ajo also run escrow — nothing added except a different rule set.

```json
{
  "accountRef": "order-88213-escrow",
  "executionModel": "SEQUENTIAL",
  "rules": [
    { "trigger": "custom_event", "condition": { "eventName": "delivery_confirmed" }, "action": "release_funds", "payload": { "destinationAccountRef": "seller-4471" }, "priority": 0 },
    { "trigger": "custom_event", "condition": { "eventName": "dispute_raised" }, "action": "flag_for_review", "priority": 1 },
    { "trigger": "time_elapsed", "condition": { "no_event_for_days": 7, "eventName": "dispute_raised" }, "action": "release_funds", "payload": { "destinationAccountRef": "seller-4471" }, "priority": 2 }
  ]
}
```

### 3.3 Rent Collection & Property Management
One virtual account per tenant, all bound under a shared landlord `Customer` via `parentId`. Rules reconcile inflows against expected rent: underpayment fires a webhook; 35 days with no inflow escalates automatically. The landlord queries a single ledger view across all tenant accounts.

### 3.4 Treasury Buckets for Multi-Purpose Fund Allocation
A business (ajo group administrator, school, marketplace, or microfinance institution) provisions logical treasury buckets for distinct purposes: one for **Payroll**, one for **Tax Reserve**, one for **Savings Pool**. When customer payments arrive, percentage-based rules automatically split them as internal ledger allocations (no Nomba call per split):

```json
{
  "accountRef": "school-fees-sept-2026",
  "executionModel": "PARALLEL",
  "rules": [
    {
      "trigger": "inflow_received",
      "condition": { "amount_gte": 0 },
      "action": "release_funds",
      "payload": { "destinationAccountRef": "payroll", "percentage": 60 },
      "priority": 0
    },
    {
      "trigger": "inflow_received",
      "condition": { "amount_gte": 0 },
      "action": "release_funds",
      "payload": { "destinationAccountRef": "tax-reserve", "percentage": 25 },
      "priority": 1
    },
    {
      "trigger": "inflow_received",
      "condition": { "amount_gte": 0 },
      "action": "release_funds",
      "payload": { "destinationAccountRef": "savings", "percentage": 15 },
      "priority": 2
    }
  ]
}
```

As inflows arrive, 60% is ledger-allocated to the payroll bucket, 25% to tax reserve, 15% to savings — each as an immutable BucketLedgerEntry credit. Settlement to external bank accounts uses the durable Settlement lifecycle: `POST /treasury-buckets/:ref/withdraw` creates a PENDING reservation, calls Nomba only once, and writes the DEBIT only on success.

### 3.5 Other Patterns (same infrastructure, different rule sets)

| Pattern | Trigger | Action |
|---|---|---|
| School fee aggregation | `INFLOW_RECEIVED` (cumulative) | `NOTIFY_WEBHOOK`, `SUSPEND_ACCOUNT`, `RELEASE_FUNDS` (percentage split) |
| Invoice matching for SMEs | `INFLOW_RECEIVED` (exact amount condition) | `NOTIFY_WEBHOOK`, `RELEASE_FUNDS` (to treasury) |
| Dormant account cleanup | `TIME_ELAPSED` | `EXPIRE_ACCOUNT` |



---

## 4. Judging Criteria Alignment

| Criterion | How AccountOS addresses it |
|---|---|
| **Reconciliation accuracy** | Idempotency check (`processed_events` table) before any rule evaluation — no inflow is ever double-counted even under Nomba webhook retries. Every inflow written to an immutable ledger tied to Nomba's transaction reference, customer name snapshot, and rule executions triggered. |
| **Identity and naming model quality** | Dedicated `Customer` entity with `kycTier`, `bvn`, `parentId` hierarchy, and append-only `NameHistoryEntry` table. Ledger entries carry `customerNameSnapshot` — historical records never change meaning when a customer is renamed. |
| **Treasury architecture quality** | Two-tier DVA model with direct fund flow through each business's own Nomba wallet. Percentage-based RELEASE_FUNDS rules allocate inflows across treasury buckets. Ledger-computed balance (SUM INFLOW - SUM OUTFLOW) ensures balance integrity without additional API calls. |
| **Edge-case handling** | Nine edge cases (EC-01–EC-09) each given an explicit, documented state transition and a corresponding Jest test. See §5. |
| **Developer API quality** | Small, consistent REST surface. Zod validation at the API boundary with formatted error messages. `@nestjs/swagger` auto-generates OpenAPI docs. Predictable error shapes with typed error codes. |

---

## 5. Edge Case Specification

| ID | Scenario | Required behaviour |
|---|---|---|
| **EC-01** | Account rename mid-lifecycle | Rename writes a `NameHistoryEntry` and updates `Customer.displayName`. Historical ledger and audit records retain the `customerNameSnapshot` captured at transaction time — they never change. |
| **EC-02** | Account closed with pending rule executions | All `RuleExecution` records in `PENDING` or `RETRYING` state transition to `ARCHIVED` with `archivedReason: CLOSED_BEFORE_COMPLETION`. Audit log records the count of archived executions. Never a silent failure. |
| **EC-03** | KYC tier change mid-lifecycle | Rules carrying the prior `kycTierAtCreation` are transitioned to `FLAGGED_FOR_REVIEW` status. Rules are not auto-rewritten — explicit developer action required to re-enable via `PATCH /accounts/:ref/rules/:ruleId`. The tier change and each flagged rule are recorded in the audit log for compliance. |
| **EC-04** | Duplicate webhook delivery | `ProcessedWebhookEvent` lookup on Nomba's event ID (or the business's custom event ID) rejects reprocessing before any rule evaluation runs. Duplicate is logged to audit, not executed. Return `200 OK` to prevent Nomba retries. |
| **EC-05** | Conflicting rules on the same trigger | Resolved deterministically by `executionModel`: `SEQUENTIAL` evaluates rules in `priority` order and stops on first match; `PARALLEL` fires all matching rules. Behavior is explicit and documented — never undefined. |
| **EC-06** | Nomba API failure during rule action | `RuleExecution` state transitions: `PENDING → RETRYING` (enqueued in BullMQ with exponential backoff: 1 min, 5 min, 15 min, 1 hr, 4 hr). After 5 failed attempts: `RETRYING → FAILED`. Nothing marked `COMPLETED` until the downstream call actually succeeds. |
| **EC-07** | Treasury withdrawal with insufficient available balance | Settlement reservation (PENDING) prevents double-spend. `POST /treasury-buckets/:ref/withdraw` checks `availableKobo = ledgerBalance − reservedKobo` before creating a Settlement record. If available < requested, return `422 INSUFFICIENT_BUCKET_BALANCE` before any Nomba call. |
| **EC-08** | Percentage-based RELEASE_FUNDS rules exceed 100% | `PUT /accounts/:ref/rules` or `POST /accounts` with multiple PARALLEL `release_funds` rules validates that SUM(all percentage fields) ≤ 100. Reject with `400 INVALID_RULE_SET` if validation fails. Check runs at write time, not execution time. |
| **EC-09** | Nomba API failure during settlement | Settlement → FAILED with `failureReason`; reservation is released; no DEBIT BucketLedgerEntry is ever written. The bucket's available balance is restored immediately. ADR #13: never debit a bucket until the transfer succeeds. |

---

## 6. API Surface (summary)

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `POST` | `/businesses` | `x-admin-secret` | Register a new business tenant |
| `PATCH` | `/businesses/:id/credentials` | `x-admin-secret` | Update Nomba credentials (mock → production graduation) |
| `POST` | `/api-keys` | `x-admin-secret` | Generate an API key (shown once) |
| `GET` | `/api-keys` | `x-api-key` | List API keys for the business |
| `DELETE` | `/api-keys/:id` | `x-api-key` | Revoke an API key |
| `POST` | `/customers` | `x-api-key` | Create a customer identity |
| `GET` | `/customers/:id` | `x-api-key` | Get customer + linked accounts |
| `PATCH` | `/customers/:id/name` | `x-api-key` | Rename — appends to `NameHistoryEntry` (EC-01) |
| `PATCH` | `/customers/:id/kyc-tier` | `x-api-key` | Update tier — flags stale rules (EC-03) |
| `POST` | `/accounts` | `x-api-key` | Provision virtual account via Nomba + attach rule set |
| `GET` | `/accounts` | `x-api-key` | List accounts for the business |
| `GET` | `/accounts/:ref/state` | `x-api-key` | Account state + customer snapshot + rule summary |
| `PATCH` | `/accounts/:ref/status` | `x-api-key` | Manual status override (not for CLOSED/EXPIRED) |
| `DELETE` | `/accounts/:ref` | `x-api-key` | Close account — archives pending executions (EC-02) |
| `PUT` | `/accounts/:ref/rules` | `x-api-key` | Replace rule set on an existing account |
| `PATCH` | `/accounts/:ref/rules/:ruleId` | `x-api-key` | Enable/disable a single rule |
| `DELETE` | `/accounts/:ref/rules/:ruleId` | `x-api-key` | Archive a single rule |
| `POST` | `/accounts/:ref/events` | `x-api-key` | Business-originated custom events (escrow, disputes) |
| `GET` | `/accounts/:ref/ledger` | `x-api-key` | Immutable inflow ledger with reconciliation status |
| `GET` | `/accounts/:ref/ledger/summary` | `x-api-key` | Aggregated ledger totals and reconciliation breakdown |
| `GET` | `/accounts/:ref/ledger/export` | `x-api-key` | CSV export of ledger entries |
| `GET` | `/accounts/:ref/audit` | `x-api-key` | Full audit trail of every lifecycle event |
| `POST` | `/treasury-buckets` | `x-api-key` | Provision a new treasury bucket DVA |
| `GET` | `/treasury-buckets` | `x-api-key` | List all treasury buckets for the business |
| `GET` | `/treasury-buckets/:ref` | `x-api-key` | Get single treasury bucket details |
| `PATCH` | `/treasury-buckets/:ref` | `x-api-key` | Rename treasury bucket |
| `DELETE` | `/treasury-buckets/:ref` | `x-api-key` | Close treasury bucket (EC-02) |
| `GET` | `/treasury-buckets/:ref/balance` | `x-api-key` | Get current balance (ledger-computed) |
| `GET` | `/treasury-buckets/:ref/statement` | `x-api-key` | Get treasury bucket transaction history (ledger) |
| `POST` | `/treasury-buckets/:ref/withdraw` | `x-api-key` | Withdraw funds to external bank account (EC-07) |
| `POST` | `/webhooks/nomba` | HMAC signature | Nomba inflow webhook intake — idempotent (EC-04) |
| `POST` | `/demo/simulate-inflow` | `x-admin-secret` | Simulate inflow for local dev — mock mode only, same pipeline as real webhook |

---

## 7. Non-Goals (v1)

- No multi-currency — NGN only; schema is left open to extend
- No dispute arbitration — disputes are surfaced via audit log for a human or downstream system
- No bulk/batch account provisioning

---

## 8. Assumptions

- Nomba's webhook payload includes a stable unique event/transaction reference usable as an idempotency key — verify against live Nomba docs before final implementation
- Nomba exposes a transfer/payout endpoint usable for `RELEASE_FUNDS` — verify against current Nomba API docs
- CBN KYC tier limits referenced illustratively (₦50,000 = Tier 1 ceiling) — revalidate against current CBN rules before any production use
