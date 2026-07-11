# Treasury Layer Architecture Decision (ADR)

**Status:** Approved  
**Version:** 1.0  
**Module:** Treasury  
**Owner:** AccountOS Core

---

# Purpose

The Treasury Layer is **not** a replacement for Nomba Virtual Accounts.

AccountOS uses Nomba Virtual Accounts **only as collection endpoints**.

Treasury Buckets are an **internal accounting abstraction** that represents the logical ownership and allocation of funds after they have been received.

This separation between **physical money movement** and **logical money ownership** is a fundamental architectural principle of AccountOS and must never be violated.

---

# Core Principle

Separate **physical money movement** from **logical money ownership**.

```
Customer
    │
    ▼
Nomba Virtual Account
    │
    ▼
Payment Webhook
    │
    ▼
Immutable Ledger Entry
    │
    ▼
Rule Engine
    │
    ▼
Treasury Allocation Engine
    │
    ├── Savings Bucket
    ├── Escrow Bucket
    ├── Tax Bucket
    ├── Operating Bucket
    └── Reserve Bucket
```

Money physically exists only inside the Business's Nomba account.

Treasury Buckets simply describe how that money is allocated internally.

---

# Treasury Overview

The Treasury module provides businesses with programmable internal fund management.

It allows businesses to:

- Allocate incoming payments into logical buckets
- Track balances independently
- Move balances between buckets
- Define settlement destinations
- Automate settlements using rules
- Maintain immutable accounting records
- Produce complete audit trails

Treasury does **not** store money.

Treasury stores accounting state.

---

# Treasury Bucket

A Treasury Bucket is an internal ledger account.

It represents an allocation of funds.

A bucket is **not**:

- a bank account
- a wallet
- a Nomba Virtual Account

A bucket contains:

- Name
- Type
- Currency
- Balance
- Available Balance
- Reserved Balance
- Rules
- Settlement Destination (optional)
- Immutable Bucket Ledger

Example

```
Operating

Balance:
₦2,500,000
```

---

# Bucket Types

Examples include:

- Operating
- Savings
- Escrow
- Platform Fees
- Reserve
- Payroll
- Tax
- Investment
- Rent
- School Fees

Businesses may create unlimited bucket types.

---

# Creating a Bucket

A bucket may optionally include a settlement destination.

Example

```ts
Bucket

name

currency

type

autoSettle

settlementDestination (optional)
```

Settlement destinations are optional because some buckets are permanent holding buckets.

---

# Settlement Destination

Settlement destinations describe **where money should eventually be transferred.**

Supported destination types:

```ts
SettlementDestination

type

BANK_ACCOUNT

NOMBA_ACCOUNT

INTERNAL_BUCKET

WEBHOOK
```

For bank accounts:

```ts
SettlementDestination

type: BANK_ACCOUNT

accountName

accountNumber

bankCode
```

Examples

Landlord

↓

Personal Bank Account

Merchant

↓

Business Account

Tax

↓

Government Account

Reserve

↓

Internal Bucket

---

# Allocation Engine

Every successful inflow follows this pipeline:

```
Customer Pays

↓

Nomba Virtual Account

↓

Webhook

↓

Immutable Ledger Entry

↓

Rule Engine

↓

Allocation Engine

↓

Bucket Ledger

↓

Bucket Balance Update
```

The Allocation Engine decides how funds are distributed.

Supported allocation strategies:

- Fixed Amount
- Percentage Split
- Remaining Balance
- Conditional Allocation

Example

```
Receive ₦100,000

↓

70% → Rent Bucket

20% → Maintenance Bucket

10% → Platform Fees
```

No Nomba API is called.

---

# Bucket Ledger

Each bucket maintains its own immutable ledger.

Example

```ts
BucketLedgerEntry

id

bucketId

type

CREDIT

DEBIT

amount

reference

sourceLedgerEntryId

createdAt
```

Every allocation creates ledger entries.

Ledger entries are append-only.

They are never updated or deleted.

---

# Bucket Balances

Each bucket maintains:

```ts
balance

availableBalance

reservedBalance
```

Example

```
Balance

₦500,000

Available

₦450,000

Reserved

₦50,000
```

Reserved funds cannot be transferred until settlement completes or fails.

---

# Bucket Transfers

Buckets support internal transfers.

Example

```
Operating

↓

Reserve
```

Internal transfers must:

- Debit source bucket
- Credit destination bucket
- Create Bucket Ledger entries
- Write Audit Logs

Internal transfers must **never** call Nomba.

---

# Settlement Overview

Settlement is the process of transferring funds from a Treasury Bucket to its final destination.

Settlement is the **only** Treasury operation that moves money outside the business's Nomba account.

Every settlement begins by creating a Settlement record.

---

# Settlement Entity

```ts
Settlement

id

bucketId

businessId

amount

currency

status

PENDING

PROCESSING

COMPLETED

FAILED

CANCELLED

destinationType

BANK_ACCOUNT

NOMBA_ACCOUNT

INTERNAL_BUCKET

WEBHOOK

destinationAccountName

destinationAccountNumber

destinationBankCode

nombaTransferReference

failureReason

initiatedBy

createdAt

completedAt
```

---

# Settlement Lifecycle

```
Business Requests Settlement
            │
            ▼
Create Settlement (PENDING)
            │
            ▼
Reserve Bucket Balance
            │
            ▼
Resolve Settlement Destination
            │
            ▼
Call Nomba Transfer API
            │
            ▼
      ┌───────────────┴───────────────┐
      │                               │
      ▼                               ▼
 SUCCESS                         FAILURE
      │                               │
      ▼                               ▼
Debit Bucket Ledger           Release Reserved Funds
      │                               │
      ▼                               ▼
Update Bucket Balance         Settlement → FAILED
      │                               │
      ▼                               ▼
Settlement → COMPLETED       Retry (optional)
      │
      ▼
Write Audit Log
```

---

# Settlement Flow

Example

Customer pays

₦100,000

↓

Virtual Account

↓

Ledger Entry

↓

Allocation Engine

↓

Rent Bucket

Balance

₦100,000

↓

Business requests settlement

↓

Settlement created

↓

Reserve

₦100,000

↓

Call Nomba Transfer API

↓

Money transferred

↓

Debit Bucket

↓

Settlement Completed

↓

Audit Log

---

# Balance Reservation

When settlement begins:

```
availableBalance -= amount

reservedBalance += amount
```

Money remains inside the business's Nomba account.

The reservation simply prevents double spending.

---

# Successful Settlement

If Nomba returns success:

- Create Bucket Ledger Debit
- Reduce Reserved Balance
- Reduce Bucket Balance
- Store Nomba Transfer Reference
- Mark Settlement as COMPLETED
- Write Audit Log

---

# Failed Settlement

If settlement fails:

- Restore Available Balance
- Reduce Reserved Balance
- Mark Settlement FAILED
- Store Failure Reason
- Retry if configured

No ledger debit is created until settlement succeeds.

---

# Settlement Destination Resolution

When a settlement starts:

1. Check whether the bucket already has a settlement destination.

2. If yes, use it.

3. Otherwise require the destination in the settlement request.

Example

```
Bucket

↓

Settlement Destination Exists?

↓

YES

↓

Use Stored Destination

↓

Transfer
```

Otherwise

```
Settlement Request

↓

Destination Provided

↓

Transfer
```

---

# Internal Bucket Settlement

If destination type equals:

```
INTERNAL_BUCKET
```

AccountOS must:

- Debit Source Bucket
- Credit Destination Bucket
- Create Ledger Entries
- Write Audit Logs

No Nomba API is called.

---

# Dedicated Virtual Accounts

Buckets should **not** receive dedicated Nomba Virtual Accounts by default.

Dedicated Virtual Accounts are an advanced optional capability.

Use only when a bucket must directly receive payments.

Examples:

- Merchant Collection Bucket
- School Department Collection
- Escrow Collection Account

Default

```
Bucket

×

No Virtual Account
```

Optional

```
Bucket

↓

Dedicated Nomba Virtual Account
```

---

# Complete Payment Lifecycle

```
Customer
    │
    ▼
Pays Money
    │
    ▼
Nomba Virtual Account
    │
    ▼
Webhook Received
    │
    ▼
Immutable Ledger
    │
    ▼
Rule Engine
    │
    ▼
Allocation Engine
    │
    ▼
Bucket Ledger
    │
    ▼
Bucket Balance
    │
    ▼
Settlement Requested
    │
    ▼
Settlement Created
    │
    ▼
Nomba Transfer API
    │
    ▼
Destination Bank
    │
    ▼
Settlement Completed
    │
    ▼
Audit Log
```

---

# Nomba Integration Rules

Nomba APIs may only be used for:

- Creating Virtual Accounts
- Managing Virtual Accounts
- Receiving Payment Webhooks
- Executing External Settlements

Nomba APIs must **never** be called during:

- Bucket Allocation
- Bucket Balance Updates
- Internal Bucket Transfers
- Bucket Ledger Writes

---

# Architectural Constraints

The Treasury module must obey these rules:

1. Buckets are logical accounting constructs.

2. Buckets do not physically own money.

3. Money physically exists only inside the business's Nomba account.

4. Every payment first becomes a Ledger Entry.

5. Ledger Entries are immutable.

6. Bucket Ledger Entries are immutable.

7. Bucket balances are derived from Bucket Ledger Entries.

8. Internal bucket transfers never call Nomba.

9. Allocation Engine never calls Nomba.

10. Settlement is the only Treasury operation that transfers money externally.

11. Every external settlement must have a Settlement record.

12. Every settlement must produce Audit Logs.

13. Never debit a bucket until the transfer succeeds.

14. Reserve balances before calling external APIs.

15. Never mutate historical accounting records.

---

# Treasury Module Structure

```
src/
└── treasury/
    ├── treasury.module.ts
    ├── treasury.controller.ts
    ├── treasury.service.ts
    ├── allocation-engine.service.ts
    ├── settlement.service.ts
    ├── bucket.service.ts
    ├── bucket-transfer.service.ts
    ├── reconciliation.service.ts
    ├── dto/
    ├── entities/
    ├── interfaces/
    ├── guards/
    └── utils/
```

---

# Design Philosophy

AccountOS separates **physical money movement** from **logical money ownership**.

- **Nomba** manages real money movement.
- **AccountOS Ledger** records immutable financial events.
- **Treasury** determines ownership and allocation.
- **Rules Engine** automates business logic.
- **Settlement Engine** orchestrates payouts.
- **Audit Trail** guarantees complete traceability.

This architecture enables AccountOS to function as a programmable financial operating system rather than a simple virtual account manager.