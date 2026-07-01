# AccountOS — Build Guide (v2)

**This is the primary context file for your AI coding agent.**  
Load this file at the start of every coding session before writing any code.

**Tool-specific loading:**
| Tool | File to create | Action |
|---|---|---|
| Claude Code | `CLAUDE.md` at repo root | Copy full contents here |
| Cursor | `.cursor/rules/build.mdc` | Copy full contents here |
| Copilot | `.github/copilot-instructions.md` | Copy full contents here |
| Bare chat | — | Paste as first message every session |

**Read order before coding:** `PRD.md` → `ARCHITECTURE.md` → `schema.prisma` → `rule-schema.ts` → this file.

---

## 1. What You Are Building

AccountOS is a NestJS/TypeScript backend service that wraps Nomba's virtual account API with a programmable rules engine, identity layer, tenancy model, audit infrastructure, and a treasury layer for multi-purpose fund allocation.

**Programmable Account Layer**: Businesses register, get an API key, provision virtual accounts with attached rules, and AccountOS handles the rest: receiving Nomba webhooks, evaluating rules, executing actions, reconciling ledger entries, and maintaining a full audit trail.

**Treasury Layer**: Businesses provision treasury bucket DVAs (dedicated virtual accounts for Payroll, Tax Reserve, Savings, Operations, Marketing, or custom purposes), configure percentage-based `RELEASE_FUNDS` rules that automatically split customer DVA inflows across buckets, and withdraw from buckets to external bank accounts on demand. Each business's funds flow through their own Nomba wallet — AccountOS is the orchestrator, never the custodian.

---

## 2. Tech Stack (locked — do not deviate)

| Concern | Choice |
|---|---|
| Framework | NestJS 10 |
| Language | TypeScript 5 (`strict: true`) |
| ORM | Prisma |
| Validation | Zod (`rule-schema.ts`) + `class-validator` for DTOs |
| Queue | BullMQ + Redis |
| Logging | Pino via `nestjs-pino` |
| API Docs | `@nestjs/swagger` auto-generated |
| Money | BigInt (kobo) — ₦1 = 100 kobo, never Decimal/Float |
| Testing | Jest |
| Package manager | pnpm |
| Local infra | Docker + docker-compose |

---

## 3. Hard Constraints (never violate)

1. **`LedgerEntry` and `AuditLogEntry` are insert-only.** No `prisma.ledgerEntry.update()` or delete anywhere.
2. **All Nomba API calls go through `NombaClientService` only.** No other file imports axios or calls Nomba.
3. **Every query is scoped to `businessId`** extracted from the validated API key. No unscoped queries on tenant-owned resources.
4. **Every webhook/event handler checks `ProcessedEvent` before any rule evaluation.** No exceptions.
5. **`ProcessedEvent` is inserted LAST** — after ledger, executions, and audit are committed.
6. **Money is always BigInt (kobo).** No `parseFloat`, no `Decimal`. Display conversion (÷100) only in DTO response transforms.
7. **Rule writes validate via `validateRuleSet()` from `rule-schema.ts`** before any Prisma write.
8. **`AuditService.log()` never throws.** It catches internally, logs to Pino, and lets the calling operation succeed.
9. **Return `200 OK` from `POST /webhooks/nomba` immediately** after HMAC verification + enqueue. Never process synchronously.
10. **TypeScript strict mode is on.** No `any` types. Handle all nulls explicitly.
11. **Never store raw BVN or NIN.** The `bvnRef` field stores only a SHA-256 hash of the BVN. `kycVerificationProvider` and `kycVerificationRef` store the business's KYC provider name and reference ID. AccountOS is not a KYC provider — it records KYC state only.
12. **Each business has their own Nomba credentials.** `NombaClientService` always uses the credentials from `request.business` (loaded via `ApiKeyGuard`). Never use global `.env` Nomba credentials for tenant operations. AccountOS never pools funds — each business's payments go to their own Nomba wallet. Global `.env` Nomba credentials (`NOMBA_CLIENT_ID`, etc.) are used only as fallback for mock mode.

---

## 4. Module Responsibilities

| Service | Owns | Never does |
|---|---|---|
| `AuthService` | Key generation, hashing, validation, revocation | Business logic |
| `ApiKeyGuard` | Extract + validate key, attach `business` to request | Any business logic |
| `IdentityService` | Customer CRUD, rename, tier change | Calls Nomba, writes ledger |
| `AccountLifecycleService` | Status transitions, close (EC-02), reactivate | Direct Nomba calls |
| `RulesService` | Rule CRUD, validates via rule-schema.ts | Rule evaluation |
| `RuleEngineService` | evaluate(), execute(), conflict resolution (EC-05) | Writes ledger, calls Nomba directly |
| `WebhookProcessorService` | HMAC verify + enqueue (returns 200 fast) | Rule evaluation, DB writes |
| `WebhookWorker` (BullMQ) | Full async inflow processing | HTTP concerns |
| `LedgerService` | Append-only LedgerEntry writes | Updates or deletes |
| `AuditService` | Append-only AuditLogEntry writes | Updates or deletes |
| `NombaClientService` | All outbound HTTP to Nomba, token + mock mode, per-business credentials | Business logic |
| `RetryProcessor` (BullMQ) | Retry failed Nomba actions with backoff (EC-06) | Direct rule evaluation |
| `TreasuryService` | Bucket provisioning, management, balance checks, withdrawals | Direct Nomba calls (delegates to NombaClient) |

---

## 5. Project Setup (run once, in order)

### Prerequisites
- Node.js 20 LTS (`node -v` should show v20.x)
- pnpm 9+ (`pnpm -v` — install with `npm i -g pnpm` if not present)
- Docker Desktop running
- Nomba developer account with sandbox credentials (or use `NOMBA_MOCK_MODE=true` to skip)

### Step 1 — Scaffold NestJS
```bash
pnpm add -g @nestjs/cli
nest new accountos --package-manager pnpm
cd accountos
```

### Step 2 — Install all dependencies
```bash
pnpm add \
  @nestjs/config \
  @nestjs/swagger swagger-ui-express \
  @nestjs/bullmq bullmq \
  @prisma/client \
  nestjs-pino pino-http \
  axios \
  zod \
  class-validator class-transformer \
  uuid

pnpm add -D \
  prisma \
  pino-pretty \
  @types/node \
  @types/uuid
```

### Step 3 — Copy context files to repo root
Place these files at the project root (same level as `package.json`):
- `PRD.md`
- `ARCHITECTURE.md`
- `BUILD.md` (this file)
- `rule-schema.ts`

> **Note:** `schema.prisma` goes to `prisma/schema.prisma` (Step 4), not the repo root.

### Step 4 — Initialise Prisma
```bash
npx prisma init
```
Then **replace** `prisma/schema.prisma` entirely with the provided `schema.prisma` file.

### Step 5 — Create docker-compose.yml
```yaml
version: '3.8'
services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: accountos
      POSTGRES_USER: accountos
      POSTGRES_PASSWORD: accountos
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U accountos"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
```

### Step 6 — Create .env
```bash
cp .env.example .env
```

Create `.env.example`:
```
# Database
DATABASE_URL=postgresql://accountos:accountos@localhost:5432/accountos

# Redis
REDIS_URL=redis://localhost:6379

# Nomba API (fallback / mock mode only — production uses per-business credentials stored in DB)
NOMBA_API_BASE_URL=https://api.nomba.com/v1
NOMBA_CLIENT_ID=your_client_id
NOMBA_CLIENT_SECRET=your_client_secret
NOMBA_ACCOUNT_ID=your_account_id
NOMBA_WEBHOOK_HMAC_SECRET=your_webhook_secret
NOMBA_MOCK_MODE=true

# Demo & Webhook Echo (independent from NOMBA_MOCK_MODE)
DEMO_MODE_ENABLED=true
DEMO_WEBHOOK_URL=http://localhost:3000/demo/webhook-echo

# AccountOS
ADMIN_SECRET=change-me-in-production
PORT=3000
NODE_ENV=development
APP_VERSION=1.0.0
```

### Step 7 — Configure tsconfig.json
Ensure these compiler options are set:
```json
{
  "compilerOptions": {
    "strict": true,
    "esModuleInterop": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "skipLibCheck": true
  }
}
```

### Step 8 — Start infrastructure
```bash
docker-compose up -d
# Wait ~10 seconds for healthy status
docker-compose ps
```

### Step 9 — Run first migration
```bash
npx prisma migrate dev --name init
npx prisma generate
```

### Step 10 — Verify setup
```bash
pnpm run start:dev
# App starts on http://localhost:3000
# Swagger UI: http://localhost:3000/api/docs
# Health: http://localhost:3000/health
```

Setup is complete when all three URLs respond.

---

## 6. Build Phases

Implement in strict order. Do not begin a phase until the previous phase's definition of done is met.

---

### Phase 1 — App Shell & Global Config

**Files to create:**
- `src/main.ts` — Bootstrap with raw body enabled, global pipes, global filter, Swagger, Pino
- `src/app.module.ts` — Root module wiring
- `src/health/health.controller.ts` — `GET /health`
- `src/common/filters/http-exception.filter.ts` — Consistent error format
- `src/common/interceptors/request-id.interceptor.ts` — `x-request-id` generation
- `src/common/constants/error-codes.ts` — All error code constants
- `src/common/decorators/public.decorator.ts` — `@Public()` skip-auth decorator

**`main.ts` requirements:**
```typescript
const app = await NestFactory.create(AppModule, { rawBody: true }) // raw body for HMAC
app.setGlobalPrefix('api/v1')
app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
app.useGlobalFilters(new HttpExceptionFilter())
app.useGlobalInterceptors(new RequestIdInterceptor())
// Swagger
const config = new DocumentBuilder()
  .setTitle('AccountOS API')
  .setDescription('Programmable virtual account state machine on Nomba')
  .setVersion('1.0')
  .addApiKey({ type: 'apiKey', in: 'header', name: 'x-api-key' }, 'api-key')
  .build()
```

**`GET /health` response:**
```json
{
  "status": "ok",
  "db": "connected",
  "redis": "connected",
  "version": "1.0.0",
  "timestamp": "2026-06-18T12:00:00.000Z"
}
```
Mark `@Public()` — no API key required.

**Error response format (all endpoints):**
```json
{
  "statusCode": 404,
  "code": "ACCOUNT_NOT_FOUND",
  "message": "No account found with ref: xyz",
  "timestamp": "2026-06-18T12:00:00.000Z",
  "path": "/api/v1/accounts/xyz/state",
  "requestId": "req_01J..."
}
```

**`error-codes.ts` — implement all codes from ARCHITECTURE.md §8**

**Definition of done:** `npm run start:dev` starts. `GET /health` returns 200. `GET /api/docs` loads Swagger UI. A request to any non-existent route returns the correct error format.

---

### Phase 2 — Auth Module (API Keys + Business Registration)

**Files:**
- `src/auth/auth.module.ts`
- `src/auth/auth.service.ts`
- `src/auth/auth.controller.ts`
- `src/auth/api-key.guard.ts`
- `src/common/guards/api-key.guard.ts` (re-export or move here)

**`AuthService` methods:**

`registerBusiness(dto: { name, email })` → creates `Business` record, returns `{ businessId, name }`

`updateBusinessCredentials(id: string, dto: UpdateBusinessCredentialsDto, adminSecret: string)`:
- Verify `adminSecret === process.env.ADMIN_SECRET` → throw if not
- Load `Business` by `id` → 404 if not found
- Build patch object from only the keys present in `dto` (never overwrite with `undefined`)
- Update and return `{ businessId, name, hasNombaCredentials }` where `hasNombaCredentials` is `true` when all four Nomba fields are non-null

`createApiKey(dto: { businessId, name }, adminSecret: string)`:
```typescript
// 1. Verify adminSecret === process.env.ADMIN_SECRET → throw if not
// 2. Generate raw key:
const secret = crypto.randomBytes(32).toString('hex')
const rawKey = `ako_live_${secret}`
// 3. Hash it:
const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
// 4. Take prefix for display:
const keyPrefix = rawKey.slice(0, 12)
// 5. Save ApiKey { keyHash, keyPrefix, name, businessId }
// 6. Return { keyId, key: rawKey, prefix: keyPrefix, name }
// rawKey is shown ONCE here and never stored
```

`validateApiKey(rawKey: string)`:
```typescript
const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
const apiKey = await prisma.apiKey.findUnique({ where: { keyHash }, include: { business: true } })
if (!apiKey) throw new UnauthorizedException(ErrorCodes.INVALID_API_KEY)
if (apiKey.revokedAt) throw new UnauthorizedException(ErrorCodes.API_KEY_REVOKED)
if (apiKey.expiresAt && apiKey.expiresAt < new Date()) throw new UnauthorizedException(ErrorCodes.API_KEY_EXPIRED)
// fire-and-forget lastUsedAt update
prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } }).catch(() => {})
return apiKey
```

`revokeApiKey(keyId, businessId)` → sets `revokedAt`, writes audit log `API_KEY_REVOKED`

`listApiKeys(businessId)` → returns keys with `{ id, prefix, name, lastUsedAt, createdAt, revokedAt }` — never `keyHash`

**`ApiKeyGuard`:**
```typescript
async canActivate(context): Promise<boolean> {
  const request = context.switchToHttp().getRequest()
  if (Reflect.getMetadata(IS_PUBLIC_KEY, context.getHandler())) return true
  const rawKey = request.headers['x-api-key']
  if (!rawKey) throw new UnauthorizedException(ErrorCodes.MISSING_API_KEY)
  const apiKey = await authService.validateApiKey(rawKey)
  request.business = apiKey.business
  request.apiKey = apiKey
  return true
}
```
Apply globally in `app.module.ts` via `APP_GUARD`.

**Endpoints:**
```
POST   /businesses                    → register (protected by x-admin-secret header, mark @Public())
PATCH  /businesses/:id/credentials    → update Nomba credentials (x-admin-secret, mark @Public())
POST   /api-keys                      → generate key (protected by x-admin-secret header, mark @Public())
GET    /api-keys                      → list keys for business (x-api-key auth)
DELETE /api-keys/:id                  → revoke (x-api-key auth)
```

**Definition of done:**
- `POST /businesses` creates a business
- `POST /api-keys` returns a raw key in response
- Every subsequent call with that key in `x-api-key` header is authenticated
- Calling without a key returns `401 MISSING_API_KEY`
- Calling with a revoked key returns `401 API_KEY_REVOKED`

---

### Phase 3 — Identity Module

**Files:** `src/identity/`

**`IdentityService` methods:**

`createCustomer(dto, businessId)` → creates `Customer` with `businessId`, sets initial `NameHistoryEntry` with `previousName: ""` and `newName: dto.displayName`

`renameCustomer(customerId, { newName, reason }, businessId, actor)`:
1. Load customer (scope: `{ id: customerId, businessId }`) → 404 if not found
2. Create `NameHistoryEntry { previousName: customer.displayName, newName, reason, changedBy: actor }`
3. Update `Customer.displayName`
4. `AuditService.log(CUSTOMER_RENAMED, { before: { displayName: old }, after: { displayName: newName } })`

`updateKycTier(customerId, newTier, businessId, actor)`:
1. Load customer (scoped) → 404 if not found
2. Snapshot `previousTier`
3. Update `Customer.kycTier`
4. Load all ACTIVE rules across customer's accounts where `kycTierAtCreation != newTier`
5. For each: update `status → FLAGGED_FOR_REVIEW`
6. `AuditService.log(RULE_FLAGGED_KYC_CHANGE)` per rule
7. `AuditService.log(KYC_TIER_CHANGED, { before: { kycTier: previousTier }, after: { kycTier: newTier } })`
8. Return `{ customerId, previousTier, newTier, flaggedRuleIds }`

`getCustomerAccounts(customerId, businessId)` → accounts where `customer.id = customerId AND customer.businessId = businessId`

**EC-01 test:** rename → verify `NameHistoryEntry` appended, `displayName` updated, old entries unchanged.
**EC-03 test:** tier change → verify flagged rules are `FLAGGED_FOR_REVIEW`, audit log written.

---

### Phase 4 — Accounts Module

**Files:** `src/accounts/`

**`AccountLifecycleService` methods:**

`provision(dto, businessId, actor)`:
1. Validate `dto.rules` via `validateRuleSet()` → `400 INVALID_RULE_SET` on failure with Zod errors
2. Verify `customer.businessId === businessId` → 404 if not (tenancy check)
3. Call `NombaClientService.createVirtualAccount()`
4. Prisma transaction: create `Account` + `Rule[]`
5. `AuditService.log(ACCOUNT_CREATED)`
6. Return account + rules

`listAccounts(businessId, filters: { status?, page?, limit? })`:
- Scope: `customer.businessId = businessId`
- Cap `limit` at 100 — enforce with `Math.min(limit, 100)`

`getState(accountRef, businessId)`:
- Scope check on `customer.businessId`
- Return: account + customer + ruleset + summary `{ totalInflows, totalAmountKobo, totalAmountNgn, lastInflowAt, pendingRuleExecutions, flaggedRules }`

`updateStatus(accountRef, { status, reason }, businessId, actor)`:
- Scope check
- Guard: cannot set `CLOSED` or `EXPIRED` via this endpoint (use `close()`)
- Guard: cannot reactivate a `CLOSED` or `EXPIRED` account (`400 ACCOUNT_TERMINAL_STATE`)
- Update `Account.status`
- `AuditService.log(ACCOUNT_STATUS_OVERRIDE, { before, after, reasonCode: reason })`

`close(accountRef, businessId, actor)` — see ARCHITECTURE.md §6.3 for full flow

`reactivate(accountRef, triggeredBy)` — internal method called by rule engine:
- Guard: if status is `EXPIRED` or `CLOSED` → throw (`ACCOUNT_TERMINAL_STATE`)
- Set `Account.status = ACTIVE`
- `AuditService.log(ACCOUNT_REACTIVATED)`

**EC-02 test:** close account with 2 pending executions → both archived with `CLOSED_BEFORE_COMPLETION`.

---

### Phase 5 — Rules Module + Rule Engine

**Files:** `src/rules/`

**`RulesService` methods:**

`upsertRules(accountRef, dto, businessId, actor)`:
1. Scope check
2. `validateRuleSet(dto)` → reject if invalid
3. Prisma transaction:
   - Set existing ACTIVE rules → `ARCHIVED`, `archivedReason: SUPERSEDED_BY_UPDATE`
   - Create new Rules with `kycTierAtCreation = customer.kycTier`
4. `AuditService.log(RULES_UPDATED)`

`archiveRule(accountRef, ruleId, businessId, actor)`:
- Scope check
- Set rule `status → ARCHIVED`, `archivedReason: MANUALLY_ARCHIVED`
- `AuditService.log(RULE_ARCHIVED)`

`toggleRule(accountRef, ruleId, enabled, businessId, actor)`:
- For re-enabling a `FLAGGED_FOR_REVIEW` rule only
- Validate rule belongs to account (scoped)

**`RuleEngineService` methods:**

`evaluate(rules, triggerType, eventPayload, accountSummary)`:
- Filter rules where `rule.trigger === triggerType` and `rule.status === ACTIVE`
- For each matching rule: evaluate ALL conditions (AND logic) using kobo integers
- Condition logic:
  ```
  amount_gte     → eventPayload.amountKobo >= condition.amount_gte
  amount_lte     → eventPayload.amountKobo <= condition.amount_lte
  cumulative_gte → accountSummary.cumulativeAmountKobo >= condition.cumulative_gte
  eventName      → eventPayload.eventName === condition.eventName
  ```
- If `SEQUENTIAL`: return only the first matching rule (lowest priority number)
- If `PARALLEL`: return all matching rules (ordered by priority ASC)

`execute(matchedRules, account, triggeredBy)`:
- For each rule: `prisma.ruleExecution.create({ status: PENDING })`
- Call the appropriate action:
  - `SUSPEND_ACCOUNT` → `AccountLifecycleService` status update ONLY (`Account.status = SUSPENDED`). No Nomba API call. The webhook processor gates future payments at AccountOS level — Nomba account stays physically active so it can be unsuspended without any Nomba interaction.
  - `REACTIVATE_ACCOUNT` → `AccountLifecycleService.reactivate()` ONLY (`Account.status = ACTIVE`). No Nomba API call. Nomba account was never suspended so no call needed.
  - `EXPIRE_ACCOUNT` → `NombaClientService.expireVirtualAccount()` + status update. Calls `DELETE /v1/accounts/virtual/{identifier}` on Nomba — **irreversible**.
  - `NOTIFY_WEBHOOK` → POST to `payload.url` with inflow details (fire-and-forget, 5s timeout)
  - `RELEASE_FUNDS` → `NombaClientService.transfer()` to `payload.destinationAccountRef`. If `payload.percentage` is set, compute transfer amount as `floor(payload.percentage / 100 * ledgerEntry.amountKobo)` (EC-15). Destination is resolved to a treasury bucket DVA (scoped to businessId).
  - `FLAG_FOR_REVIEW` → update `Account.status` only (no Nomba call needed)
- On Nomba success: `RuleExecution.status → COMPLETED`
- On Nomba failure: `RuleExecution.status → RETRYING` + enqueue BullMQ retry job

**EC-08: Percentage-Sum Validation**
- In `RulesService.upsertRules()`: when creating PARALLEL rules with multiple `RELEASE_FUNDS` actions having `payload.percentage`:
  - Validate `SUM(percentage for all percentage-based release_funds rules) <= 100`
  - Reject with `400 PERCENTAGE_SUM_EXCEEDS_100` if validation fails
  - This check runs at write time, not execution time

**Suspend gate logic (in WebhookWorker, after finding the account):**
```typescript
if (account.status === 'SUSPENDED') {
  await ledgerService.write({ ...entry, reconciliationStatus: 'FLAGGED' })
  await auditService.log(INFLOW_RECEIVED, { metadata: { note: 'account suspended — rules skipped' } })
  return // stop processing, do not evaluate rules
}
```
This means payments still arrive at Nomba and trigger webhooks — AccountOS receives them, records them as FLAGGED, but skips all rule evaluation until the account is reactivated.

**EC-05 tests:**
- SEQUENTIAL: two matching rules, only first fires
- PARALLEL: two matching rules, both fire
- No match: nothing fires
- Cumulative condition evaluates correctly

---

### Phase 6 — NombaClient + Queue Infrastructure

**Files:** `src/nomba-client/`, `src/queue/`

**`NombaClientService`:**

`getAccessToken(business: Business)`:
```typescript
// Token cache is keyed per businessId — each business has independent token lifecycle
if (this.tokenCache.has(business.id)) {
  const cached = this.tokenCache.get(business.id)
  if (Date.now() < cached.expiresAt - 30_000) return cached.token
}
// Use business.nombaClientId + business.nombaClientSecret for OAuth
// POST to Nomba auth endpoint, store token keyed by business.id
```

Mock mode check at top of every method:
```typescript
if (process.env.NOMBA_MOCK_MODE === 'true') {
  return this.getMockResponse(method, params)
}
```

Every Nomba API call uses the business's own credentials:
- `Authorization: Bearer <token>` — from `getAccessToken(business)`
- `accountId: <business.nombaAccountId>` — header on every request

This ensures each business's funds flow into their own Nomba wallet.
AccountOS never pools or holds funds from multiple businesses.

Methods to implement (all backed by real Nomba API calls):
- `createVirtualAccount(business, params)` — POST /v1/accounts/virtual
- `fetchVirtualAccount(business, identifier)` — GET /v1/accounts/virtual/{identifier}
- `fetchParentAccount(business)` — GET /v1/accounts/parent
- `updateVirtualAccount(business, identifier, updates)` — PUT /v1/accounts/virtual/{identifier}
- `expireVirtualAccount(business, identifier)` — DELETE /v1/accounts/virtual/{identifier} — irreversible
- `transferFunds(business, params)` — transfer funds (for RELEASE_FUNDS action). Supports `amountKobo` parameter (percentage calculation done by RuleEngine before calling)

All failures throw `NombaApiException` — never raw axios errors.

**BullMQ Queues — two separate queues:**

Queue 1: `'webhook-processing'` — runs the full async inflow flow
- Worker: `WebhookWorker` — implements full ARCHITECTURE.md §5 steps 4–12

Queue 2: `'rule-action-retry'` — retries failed Nomba API actions
- Worker: `RetryProcessor`
- Backoff: `[60_000, 300_000, 900_000, 3_600_000, 14_400_000]` ms
- Max attempts: 5
- On exhaustion: `RuleExecution.status → FAILED`, `AuditService.log(RULE_ACTION_FAILED)`

**EC-06 test:** mock NombaClientService to fail 3× then succeed — verify execution transitions `PENDING → RETRYING → RETRYING → RETRYING → COMPLETED`.

---

### Phase 7 — Webhooks + Events

**Files:** `src/webhooks/`, `src/events/`

**`WebhooksController.receive()`:**
```typescript
@Post('/webhooks/nomba')
@Public()
@HttpCode(200)
async receive(@Req() req: RawBodyRequest<Request>) {
  // 1. Parse accountNumber from raw body to resolve the owning business
  const body = JSON.parse(req.rawBody!.toString())
  const accountNumber = body?.data?.accountNumber
  if (!accountNumber) throw new BadRequestException('Missing accountNumber in webhook payload')

  const account = await prisma.account.findFirst({
    where: { accountNumber },
    include: { customer: { include: { business: true } } }
  })
  if (!account) {
    // Unknown account — enqueue anyway so WebhookWorker can log UNKNOWN_ACCOUNT_WEBHOOK
    await this.webhookQueue.add('process-inflow', body)
    return { received: true }
  }

  // 2. HMAC verify using the business's own nombaWebhookSecret (per-business, not global env)
  const secret = account.customer.business.nombaWebhookSecret
  if (!secret) throw new UnauthorizedException(ErrorCodes.INVALID_WEBHOOK_SIGNATURE)

  const signature = req.headers['x-nomba-signature'] as string
  const expected = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody!)
    .digest('hex')
  if (!signature || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
    throw new UnauthorizedException(ErrorCodes.INVALID_WEBHOOK_SIGNATURE)
  }

  // 3. Enqueue for async processing
  await this.webhookQueue.add('process-inflow', body)
  // 4. Return immediately — Nomba is satisfied
  return { received: true }
}
```

**`EventsController.trigger()`:**
```typescript
@Post('/accounts/:ref/events')
async trigger(@Param('ref') ref: string, @Body() dto: TriggerEventDto, @Req() req) {
  await this.eventsQueue.add('process-event', { accountRef: ref, businessId: req.business.id, ...dto })
  return { received: true }
}
```

**EC-04 test:** send same eventId twice → rule evaluation runs exactly once, one `ProcessedEvent` record exists.

---

### Phase 7 — Treasury Module

**Files:** `src/treasury/`

**`TreasuryService` methods:**

`provisionBucket(businessId, business, dto)`:
1. Verify `bucketRef` is unique (scoped to businessId) → 409 DUPLICATE_ACCOUNT_REF if not
2. Call `NombaClientService.provisionDva(business, dto.name)`
3. Create `Account` record with `accountType: TREASURY_BUCKET`, `bucketType`, optional `description`, no `customerId`
4. `AuditService.log(TREASURY_BUCKET_CREATED)`
5. Return bucket account with NUBAN

`getBuckets(businessId, page, limit)`:
- Scope: `Account` where `businessId === authenticated businessId` and `accountType = TREASURY_BUCKET`
- Return paginated list

`getBucket(businessId, bucketRef)`:
- Scope check → 404 if not found in this business

`renameBucket(businessId, bucketRef, name)`:
- Update bucket display name, return updated record

`closeBucket(businessId, bucketRef)`:
- Archive all `PENDING`/`RETRYING` RuleExecution records with `archivedReason: CLOSED_BEFORE_COMPLETION` (same pattern as account closure, EC-02)
- Call `NombaClientService.expireVirtualAccount()`
- Set `Account.status = CLOSED`
- `AuditService.log(TREASURY_BUCKET_CLOSED, { pendingExecutionsArchived: N })`
- Return closure summary

`getBalance(businessId, bucketRef)`:
- Compute: `SUM(INFLOW LedgerEntry.amountKobo) - SUM(OUTFLOW LedgerEntry.amountKobo)` for the bucket
- Return balance in both kobo and NGN
- Never call Nomba API; ledger is source of truth

`getStatement(businessId, bucketRef, filters)`:
- Return paginated LedgerEntry records for bucket (same shape as account ledger)
- Optional `from`, `to`, `direction` filters

`withdraw(businessId, bucketRef, business, dto)`:
1. Scope check: bucket.businessId === businessId → 404 if not
2. Compute current balance: `LedgerService.getBalance(bucketAccountId)`
3. **EC-07 Insufficient Balance Check**: If `balance < dto.amountKobo`, throw `422 INSUFFICIENT_BUCKET_BALANCE` immediately — no Nomba call, no DB write
4. `AuditService.log(TREASURY_WITHDRAWAL_INITIATED)` (fire-and-forget, before transaction)
5. Prisma transaction:
   a. `LedgerService.writeOutflow({ accountId: bucket.id, amountKobo, reconciliationStatus: PENDING, ... })`
   b. `NombaClientService.transferFunds(business, { sourceAccountId: bucket.nombaAccountId, destinationAccountNumber: dto.destinationAccountNumber, amountKobo, ... })`
   c. If success: update `LedgerEntry.reconciliationStatus = MATCHED`, `AuditService.log(TREASURY_WITHDRAWAL_COMPLETED)`
   d. If failure: rollback (OUTFLOW entry not written), `AuditService.log(TREASURY_WITHDRAWAL_FAILED, { error })`
6. Return `{ ledgerEntryId, amountKobo, newBalance, completedAt }`

**Percentage-Based RELEASE_FUNDS Validation (EC-08):**

In `RulesService.upsertRules()` and `POST /accounts`:
- When adding/updating rules with `executionModel: PARALLEL` and multiple `action: RELEASE_FUNDS` rules with `payload.percentage` set:
  - Validate: `SUM(percentage for all release_funds rules) <= 100`
  - Reject with `400 PERCENTAGE_SUM_EXCEEDS_100` if validation fails
- This check runs at write time (before any LedgerEntry created), not at execution time

**RuleEngineService.execute() — Percentage Handling:**
- When matched rule has `action: RELEASE_FUNDS` and `payload.percentage` is set:
  - Compute: `amountToTransfer = Math.floor(payload.percentage / 100 * ledgerEntry.amountKobo)` (BigInt math)
  - Resolve destination: `Account.findFirst({ accountRef: payload.destinationAccountRef, businessId, accountType: 'TREASURY_BUCKET' })`
  - Call `NombaClientService.transferFunds(business, { ... })`
  - On success: write OUTFLOW LedgerEntry on treasury bucket, write ALLOCATE_FUNDS AuditLogEntry
  - On failure: enqueue retry job (EC-06)

**Definition of done:** All treasury endpoints respond correctly. `POST /accounts` with percentage rules validates and stores correctly. `POST /treasury-buckets/:ref/withdraw` rejects insufficient balance (EC-07) without calling Nomba. Balance is computed from ledger. All treasury fund flows go through NombaClientService using the business's own credentials.

---

### Phase 8 — Ledger + Audit

**Files:** `src/ledger/`, `src/audit/`

**Ledger endpoints:**

`GET /accounts/:ref/ledger`:
- Query params: `from`, `to` (ISO8601), `reconciliationStatus`, `page` (default 1), `limit` (default 20, max 100 — enforce with DTO `@Max(100)`)
- Scope: account must belong to `request.business`
- Response: paginated `LedgerEntry[]` with amounts in both kobo and NGN

`GET /accounts/:ref/ledger/summary`:
```json
{
  "accountRef": "ajo-amaka-jan",
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

`GET /accounts/:ref/ledger/export`:
- Returns CSV, `Content-Type: text/csv`, `Content-Disposition: attachment; filename="ledger-{ref}-{date}.csv"`
- Columns: `entryId, nombaTransactionRef, direction, amountNgn, currency, senderName, customerNameSnapshot, kycTierAtTime, reconciliationStatus, receivedAt`
- Build CSV as a plain string — no external library needed

**Amount display rule — apply in ALL response DTOs:**
```typescript
// In DTO transform:
amountKobo: Number(entry.amountKobo),  // BigInt → Number for JSON
amountNgn: Number(entry.amountKobo) / 100
```

---

### Phase 9 — Swagger + Polish

1. Add to every controller method:
   - `@ApiOperation({ summary: '...' })`
   - `@ApiResponse({ status: X, description: '...' })` for success and error cases
   - `@ApiSecurity('api-key')` (except `@Public()` routes)

2. Enforce `@Max(100)` on all `limit` query params via DTO validation

3. Add `@nestjs/throttler` globally:
```typescript
ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])
```
Exempt `POST /webhooks/nomba` from throttling (Nomba fires many webhooks legitimately).

4. Verify `pnpm run build` passes with zero TypeScript errors.

---

### Phase 10 — Tests, README, Postman

**Required Jest tests (EC-01 through EC-09 + auth):**

| Test file | What it covers |
|---|---|
| `auth.service.spec.ts` | Key generation, hash verify, revocation, invalid key |
| `identity.service.spec.ts` | EC-01 rename (nameHistory append), EC-03 tier change (rule flagging) |

| `account-lifecycle.service.spec.ts` | EC-02 close with pending executions |
| `rule-engine.service.spec.ts` | EC-05 sequential, parallel, no match, cumulative conditions |
| `webhook.processor.spec.ts` | EC-04 duplicate discard, valid inflow ledger write |
| `retry.processor.spec.ts` | EC-06 retry transitions, exhaustion → FAILED |

**`README.md` for judges — must include:**
```markdown
## Quick Start
1. Clone repo
2. `cp .env.example .env` and fill in values (or leave NOMBA_MOCK_MODE=true)
3. `docker-compose up -d`
4. `npx prisma migrate dev`
5. `pnpm run start:dev`
6. Swagger: http://localhost:3000/api/docs
7. Health: http://localhost:3000/health

## Generate Your First API Key
POST /businesses → get businessId
POST /api-keys (x-admin-secret header) → get your API key

## Run the Ajo Demo
Import postman/AccountOS.postman_collection.json
Follow the "Ajo Demo Flow" folder — 8 requests, full lifecycle
```

**Postman collection** (`postman/AccountOS.postman_collection.json`) — cover this flow:
1. Register Business
2. Create API Key
3. Create Customer (Amaka Obi, TIER_1)
4. Provision Account with ajo rules
5. Simulate inflow webhook (suspend rule)
6. GET /accounts/:ref/state — show SUSPENDED
7. POST /accounts/:ref/events with `cycle_reset` — reactivate
8. GET /accounts/:ref/ledger — show reconciled entry
9. GET /accounts/:ref/audit — show full trail
10. PATCH /customers/:id/kyc-tier — show rule flagging

---

## 7. Definition of Done

The build is complete when all of these pass:

- [ ] `pnpm run build` — zero TypeScript errors
- [ ] `npx prisma validate` — schema valid
- [ ] All 9 EC tests pass: `pnpm run test`
- [ ] Auth tests pass: key generation, validation, revocation
- [ ] Swagger UI at `/api/docs` shows all endpoints with correct shapes
- [ ] `GET /health` returns `{ status: "ok", db: "connected", redis: "connected" }`
- [ ] Treasury end-to-end test passes: simulate-inflow → RELEASE_FUNDS → treasury bucket balance increases → withdrawal succeeds
- [ ] Ajo demo Postman collection runs end-to-end successfully
- [ ] Live deploy URL exists (Railway or Render)
- [ ] `README.md` has one-command setup + key generation instructions

---

## 8. Agent Session Prompts

**Opening every session:**
> "Read BUILD.md in full, then ARCHITECTURE.md. Confirm you have read both. State which Phase we are on and what the definition of done is for that Phase before writing any code."

**Starting a phase:**
> "Implement Phase [N] of BUILD.md. Do not begin Phase [N+1]. After completing each file, state what remains in this phase."

**Reviewing work:**
> "Before continuing, check your implementation against the spec in BUILD.md Phase [N] and the constraints in §3. List any violations."

**Correcting drift:**
> "Stop. You violated constraint [N] in BUILD.md §3 by [specific thing]. Revert that change and re-implement correctly."

**Starting auth module specifically:**
> "We are implementing Phase 2 — the Auth module. This is the API key system. Key points: raw key is shown once and never stored, only SHA-256 hash stored, ApiKeyGuard applies globally via APP_GUARD, @Public() decorator skips it. Implement auth.service.ts first, then the guard, then the controller."
