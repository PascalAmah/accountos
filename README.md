# AccountOS

**Programmable, stateful virtual account infrastructure built on Nomba.**

AccountOS is a NestJS service that turns Nomba's static virtual accounts into intelligent, rule-driven, auditable financial infrastructure. Built for the Nomba × DevCareer Hackathon — Infrastructure Track.

---

## What it does

Nomba gives you a virtual account. AccountOS gives it a brain.

Four capabilities layered on top of Nomba's DVA primitive:

- **Identity Layer** — Customer entities with KYC tiers (TIER_0–TIER_3), BVN references, parent-child hierarchies, and append-only name history. Every ledger entry carries a customer name snapshot so historical records never change meaning.
- **Rules Engine** — Attach declarative JSON rules to any account. Triggers (`INFLOW_RECEIVED`, `TIME_ELAPSED`, `CUSTOM_EVENT`, `TIER_CHANGED`), conditions, and actions (`SUSPEND_ACCOUNT`, `RELEASE_FUNDS`, `NOTIFY_WEBHOOK`, etc.) validated by Zod at write time — never at execution time.
- **Persistent State + Audit** — Immutable ledger, rule execution tracking with retry queue, and an insert-only audit log of every lifecycle event.
- **Treasury Layer** — Businesses provision treasury bucket DVAs (Payroll, Tax Reserve, Savings, etc.) and split incoming customer payments across them automatically via percentage-based `RELEASE_FUNDS` rules. Withdraw to external bank accounts on demand.

---

## Use cases

**Ajo/Esusu rotating savings** — Each member gets a dedicated DVA. Rules auto-suspend on contribution receipt, notify the admin when the full pot lands, and trigger payout at cycle end.

**Marketplace escrow** — Funds held in a DVA, released on `delivery_confirmed` custom event or after 7 days with no dispute. Same rule engine, different rule set.

**Rent collection** — One DVA per tenant under a shared landlord customer. Underpayment fires a webhook; 35 days with no inflow escalates automatically.

**Treasury allocation** — School, ajo group, or marketplace splits every inflow: 60% → Payroll bucket, 25% → Tax Reserve, 15% → Savings. Each bucket is a real Nomba NUBAN. No master-account hop.

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | NestJS 10 + TypeScript |
| Database | PostgreSQL via Prisma |
| Queue | BullMQ + Redis |
| Validation | Zod (`rule-schema.ts`) |
| API docs | `@nestjs/swagger` (OpenAPI) |
| Logging | nestjs-pino |

---

## Getting started

### Prerequisites
- Node.js 20+
- pnpm
- PostgreSQL
- Redis
- Docker (optional)

### Install

```bash
pnpm install
```

### Configure

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

Key variables:

```env
DATABASE_URL=postgresql://accountos:accountos@localhost:5432/accountos
REDIS_URL=redis://localhost:6379
ADMIN_SECRET=change-me-in-prod
NOMBA_MOCK_MODE=true        # set false for live Nomba API
DEMO_MODE_ENABLED=true
PORT=3000
```

### Database setup

```bash
pnpm prisma migrate deploy
pnpm prisma generate
```

### Run with Docker

```bash
docker-compose up
```

### Run locally

```bash
# development
pnpm run start:dev

# production
pnpm run start:prod
```

---

## Quick start (mock mode)

With `NOMBA_MOCK_MODE=true`, no Nomba credentials are needed. The full pipeline runs with fixture responses.

**1. Register a business**
```bash
curl -X POST http://localhost:3000/api/v1/businesses \
  -H "x-admin-secret: change-me-in-prod" \
  -H "Content-Type: application/json" \
  -d '{ "name": "AjoApp Ltd", "email": "dev@ajoapp.ng" }'
```

**2. Generate an API key**
```bash
curl -X POST http://localhost:3000/api/v1/api-keys \
  -H "x-admin-secret: change-me-in-prod" \
  -H "Content-Type: application/json" \
  -d '{ "businessId": "<businessId>", "name": "Dev Key" }'
# Key shown once — save it
```

**3. Create a customer**
```bash
curl -X POST http://localhost:3000/api/v1/customers \
  -H "x-api-key: <your-key>" \
  -H "Content-Type: application/json" \
  -d '{ "displayName": "Amaka Okafor" }'
```

**4. Provision a virtual account with rules**
```bash
curl -X POST http://localhost:3000/api/v1/accounts \
  -H "x-api-key: <your-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "accountRef": "ajo-amaka-jan",
    "customerId": "<customerId>",
    "executionModel": "SEQUENTIAL",
    "rules": [
      {
        "trigger": "inflow_received",
        "condition": { "amount_gte": 5000000 },
        "action": "suspend_account",
        "priority": 0
      }
    ]
  }'
```

**5. Simulate an inflow**

Use the `accountNumber` (NUBAN) returned from step 4:

```bash
curl -X POST http://localhost:3000/api/v1/demo/simulate-inflow \
  -H "x-admin-secret: change-me-in-prod" \
  -H "Content-Type: application/json" \
  -d '{ "accountNumber": "<nuban-from-step-4>", "amountKobo": 5000000 }'
```

Swagger docs available at `http://localhost:3000/api/docs`.

---

## Mock → production graduation

1. Register business (no credentials needed at this step)
2. Build and test with `NOMBA_MOCK_MODE=true`
3. Update credentials when ready:
   ```bash
   curl -X PATCH http://localhost:3000/api/v1/businesses/<id>/credentials \
     -H "x-admin-secret: change-me-in-prod" \
     -H "Content-Type: application/json" \
     -d '{
       "nombaAccountId": "...",
       "nombaSubAccountId": "...",
       "nombaClientId": "...",
       "nombaClientSecret": "...",
       "nombaWebhookSecret": "..."
     }'
   ```
4. Set `NOMBA_MOCK_MODE=false` — live Nomba calls now use the business's stored credentials

---

## API overview

All endpoints are under `/api/v1`. Auth via `x-api-key` header. Admin routes use `x-admin-secret`.

Amounts are always in **kobo** (integer). ₦50,000 = `5000000`.

### Auth & API keys

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `POST` | `/businesses` | admin-secret | Register a business tenant |
| `GET` | `/businesses/me` | api-key | Get authenticated business profile |
| `PATCH` | `/businesses/:id/credentials` | admin-secret | Update Nomba credentials |
| `POST` | `/api-keys` | admin-secret | Generate an API key (shown once) |
| `GET` | `/api-keys` | api-key | List all API keys |
| `DELETE` | `/api-keys/:id` | api-key | Revoke an API key |

### Customers

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `POST` | `/customers` | api-key | Create a customer identity |
| `GET` | `/customers` | api-key | List all customers |
| `GET` | `/customers/:id` | api-key | Get customer with name history & accounts |
| `PATCH` | `/customers/:id/name` | api-key | Rename customer — appends history (EC-01) |
| `PATCH` | `/customers/:id/kyc-tier` | api-key | Update KYC tier — flags stale rules (EC-03) |

### Virtual accounts

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `POST` | `/accounts` | api-key | Provision DVA + attach rules |
| `GET` | `/accounts` | api-key | List accounts (paginated, filterable by status) |
| `GET` | `/accounts/:ref/state` | api-key | Account state + rule summary + ledger stats |
| `PATCH` | `/accounts/:ref/status` | api-key | Manually override account status |
| `DELETE` | `/accounts/:ref` | api-key | Close account, archive pending executions (EC-02) |

### Rules

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `PUT` | `/accounts/:ref/rules` | api-key | Replace entire rule set |
| `PATCH` | `/accounts/:ref/rules/:ruleId` | api-key | Enable/disable a single rule |
| `DELETE` | `/accounts/:ref/rules/:ruleId` | api-key | Delete (archive) a rule |

### Events

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `POST` | `/accounts/:ref/events` | api-key | Fire a custom business event (idempotent) |

### Ledger

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `GET` | `/accounts/:ref/ledger` | api-key | Paginated inflow ledger entries |
| `GET` | `/accounts/:ref/ledger/summary` | api-key | Aggregate ledger summary |
| `GET` | `/accounts/:ref/ledger/export` | api-key | Download ledger as CSV |

### Treasury buckets

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `POST` | `/treasury-buckets` | api-key | Provision a treasury bucket DVA |
| `GET` | `/treasury-buckets` | api-key | List all buckets (paginated) |
| `GET` | `/treasury-buckets/:ref` | api-key | Get bucket details with balance |
| `PATCH` | `/treasury-buckets/:ref` | api-key | Rename a bucket |
| `DELETE` | `/treasury-buckets/:ref` | api-key | Close a bucket |
| `GET` | `/treasury-buckets/:ref/balance` | api-key | Ledger-computed balance |
| `GET` | `/treasury-buckets/:ref/statement` | api-key | Paginated ledger statement |
| `POST` | `/treasury-buckets/:ref/withdraw` | api-key | Withdraw to external bank account (EC-07) |

### Webhooks & demo

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `POST` | `/webhooks/nomba` | HMAC | Nomba inflow webhook intake (HMAC-verified) |
| `POST` | `/demo/simulate-inflow` | admin-secret | Simulate inflow (demo mode only) |
| `ANY` | `/demo/webhook-echo` | none | Echo back any payload (debug helper) |

### Health

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | none | DB + Redis connectivity check |

Full spec in [`technical-docs/API_SPEC.md`](./technical-docs/API_SPEC.md).

---

## Architecture

```
Nomba API / Business Backends
         │
         ▼
   AccountOS (NestJS)
   ├── Webhook intake (HMAC verify → BullMQ → async processing)
   ├── Rules Engine (Zod-validated, SEQUENTIAL or PARALLEL)
   ├── Ledger Service (append-only)
   ├── Audit Service (insert-only)
   └── Treasury Service (two-tier DVA flow, atomic withdrawal)
         │
    ┌────┴────┐
 PostgreSQL  Redis
```

Each business's Nomba credentials are stored isolated per tenant. AccountOS is the orchestrator — it never holds or pools funds. Full architecture in [`technical-docs/ARCHITECTURE.md`](./technical-docs/ARCHITECTURE.md).

---

## Edge cases handled

| ID | Scenario | Behaviour |
|---|---|---|
| EC-01 | Account rename mid-lifecycle | Append-only name history; ledger snapshots unchanged |
| EC-02 | Close with pending rule executions | All pending executions archived with reason |
| EC-03 | KYC tier change mid-lifecycle | Stale rules flagged for review; no silent failures |
| EC-04 | Duplicate webhook delivery | Idempotency check before any rule evaluation |
| EC-05 | Conflicting rules on same trigger | Deterministic: SEQUENTIAL stops on first match; PARALLEL fires all |
| EC-06 | Nomba API failure during rule action | BullMQ retry with exponential backoff; max 5 attempts |
| EC-07 | Treasury withdrawal insufficient balance | 422 before any Nomba call; ledger integrity preserved |
| EC-08 | RELEASE_FUNDS percentages exceed 100% | Rejected at write time with `400 INVALID_RULE_SET` |
| EC-09 | Unexpected treasury inflow | Treated as standard inflow; ledger reconciliation maintained |

---

## Tests

```bash
pnpm run test          # unit tests
pnpm run test:e2e      # e2e tests
pnpm run test:cov      # coverage
```

---

## License

MIT
