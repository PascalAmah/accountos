import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { NombaClientService } from '../nomba-client/nomba-client.service';
import { LedgerService } from '../ledger/ledger.service';
import { ErrorCodes } from '../common/constants/error-codes';
import { CreateBucketDto } from './dto/create-bucket.dto';
import { RenameBucketDto } from './dto/rename-bucket.dto';
import { WithdrawDto } from './dto/withdraw.dto';

@Injectable()
export class TreasuryService {
  private readonly logger = new Logger(TreasuryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly nombaClient: NombaClientService,
    private readonly ledgerService: LedgerService,
    private readonly auditService: AuditService,
  ) {}

  // ─── provisionBucket (POST /treasury-buckets) ──────────────────────────────

  /**
   * Provision a new treasury bucket (Account with accountType: TREASURY_BUCKET).
   *
   * Flow:
   * 1. Validate bucketRef uniqueness for the business
   * 2. Validate bucketType is a valid enum value
   * 3. Call NombaClientService.provisionDva (mock-safe)
   * 4. Create Account record with accountType: TREASURY_BUCKET
   * 5. Write TREASURY_BUCKET_CREATED AuditLogEntry
   */
  async provisionBucket(dto: CreateBucketDto, businessId: string) {
    // ── Step 1: Uniqueness check ────────────────────────────────────────────
    const existing = await this.prisma.account.findUnique({
      where: { accountRef: dto.bucketRef },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException({
        message: `Treasury bucket with ref '${dto.bucketRef}' already exists`,
        code: ErrorCodes.DUPLICATE_ACCOUNT_REF,
      });
    }

    // ── Step 2: Validate bucketType (enum validation via class-validator) ────
    // class-validator handles the enum check on the DTO; this is just a safety guard.
    const validBucketTypes = [
      'PAYROLL',
      'TAX_RESERVE',
      'OPERATIONS',
      'MARKETING',
      'SAVINGS',
      'CUSTOM',
    ];
    if (!validBucketTypes.includes(dto.bucketType)) {
      throw new BadRequestException({
        message: `Invalid bucketType '${dto.bucketType}'. Must be one of: ${validBucketTypes.join(', ')}`,
        code: ErrorCodes.VALIDATION_ERROR,
      });
    }

    // ── Step 3: Resolve business ─────────────────────────────────────────────
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
    });

    if (!business) {
      throw new NotFoundException({
        message: 'Business not found',
        code: ErrorCodes.BUSINESS_NOT_FOUND,
      });
    }

    // ── Step 4: Provision DVA at Nomba ───────────────────────────────────────
    const nombaResult = await this.nombaClient.provisionDva(business, {
      accountRef: dto.bucketRef,
      accountName: dto.name,
    });

    // ── Step 5: Create Account record ────────────────────────────────────────
    const account = await this.prisma.account.create({
      data: {
        accountRef: dto.bucketRef,
        nombaAccountId: nombaResult.accountRef,
        accountNumber: nombaResult.accountNumber,
        bankName: nombaResult.bankName,
        accountNameAtCreation: dto.name,
        accountType: 'TREASURY_BUCKET',
        bucketType: dto.bucketType,
        description: dto.description ?? null,
        customerId: null, // treasury buckets are not customer-owned
        businessId,
        executionModel: 'SEQUENTIAL', // default; treasury buckets rarely use rules
      },
    });

    // ── Step 6: Audit ────────────────────────────────────────────────────────
    await this.auditService.log({
      actor: 'system',
      action: AuditAction.TREASURY_BUCKET_CREATED,
      accountId: account.id,
      businessId,
      afterState: {
        accountRef: account.accountRef,
        accountNumber: account.accountNumber,
        bucketType: account.bucketType,
        accountNameAtCreation: account.accountNameAtCreation,
        description: account.description,
      },
    });

    this.logger.log(
      {
        accountRef: account.accountRef,
        bucketType: account.bucketType,
      },
      'Treasury bucket provisioned',
    );

    return account;
  }

  // ─── getBuckets (GET /treasury-buckets) ────────────────────────────────────

  /**
   * Paginated list of treasury buckets (accountType: TREASURY_BUCKET)
   * scoped to the authenticated business.
   */
  async getBuckets(
    businessId: string,
    filters: { page: number; limit: number; status?: string },
  ) {
    const where: Prisma.AccountWhereInput = {
      businessId,
      accountType: 'TREASURY_BUCKET',
    };

    if (filters.status) {
      where.status = filters.status as Prisma.EnumAccountStatusFilter['equals'];
    }

    const [accounts, total] = await Promise.all([
      this.prisma.account.findMany({
        where,
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.account.count({ where }),
    ]);

    return {
      data: accounts,
      meta: {
        total,
        page: filters.page,
        limit: filters.limit,
        totalPages: Math.ceil(total / filters.limit),
      },
    };
  }

  // ─── getBucket (GET /treasury-buckets/:ref) ────────────────────────────────

  /**
   * Get a single treasury bucket with balance summary.
   * 404 if not found or not belonging to the business.
   */
  async getBucket(bucketRef: string, businessId: string) {
    const account = await this.prisma.account.findFirst({
      where: {
        accountRef: bucketRef,
        businessId,
        accountType: 'TREASURY_BUCKET',
      },
    });

    if (!account) {
      throw new NotFoundException({
        message: `Treasury bucket '${bucketRef}' not found`,
        code: ErrorCodes.ACCOUNT_NOT_FOUND,
      });
    }

    const balance = await this.ledgerService.getBalance(account.id);

    return {
      ...account,
      balanceKobo: balance,
    };
  }

  // ─── renameBucket (PATCH /treasury-buckets/:ref) ──────────────────────────

  /**
   * Update the display name of a treasury bucket.
   * Updates accountNameAtCreation to reflect the new name.
   */
  async renameBucket(
    bucketRef: string,
    dto: RenameBucketDto,
    businessId: string,
  ) {
    const account = await this.prisma.account.findFirst({
      where: {
        accountRef: bucketRef,
        businessId,
        accountType: 'TREASURY_BUCKET',
      },
    });

    if (!account) {
      throw new NotFoundException({
        message: `Treasury bucket '${bucketRef}' not found`,
        code: ErrorCodes.ACCOUNT_NOT_FOUND,
      });
    }

    const updated = await this.prisma.account.update({
      where: { id: account.id },
      data: { accountNameAtCreation: dto.name },
    });

    this.logger.log(
      {
        accountRef: bucketRef,
        previousName: account.accountNameAtCreation,
        newName: dto.name,
      },
      'Treasury bucket renamed',
    );

    return updated;
  }

  // ─── closeBucket (DELETE /treasury-buckets/:ref) ──────────────────────────

  /**
   * Close a treasury bucket (EC-02 pattern).
   *
   * Steps:
   * 1. Load the bucket (scoped to business + accountType filter)
   * 2. Assert it is not already CLOSED or in a terminal state
   * 3. Archive all PENDING/RETRYING RuleExecutions
   * 4. Call Nomba to expire the DVA
   * 5. Set status to CLOSED
   * 6. Write TREASURY_BUCKET_CLOSED AuditLogEntry
   */
  async closeBucket(
    bucketRef: string,
    businessId: string,
    actor: string,
    business: {
      id: string;
      nombaAccountId: string | null;
      nombaSubAccountId: string | null;
      nombaClientId: string | null;
      nombaClientSecret: string | null;
      nombaWebhookSecret: string | null;
      webhookUrl: string | null;
      name: string;
      email: string;
      createdAt: Date;
      updatedAt: Date;
    },
  ) {
    const account = await this.prisma.account.findFirst({
      where: {
        accountRef: bucketRef,
        businessId,
        accountType: 'TREASURY_BUCKET',
      },
    });

    if (!account) {
      throw new NotFoundException({
        message: `Treasury bucket '${bucketRef}' not found`,
        code: ErrorCodes.ACCOUNT_NOT_FOUND,
      });
    }

    if (account.status === 'CLOSED') {
      throw new BadRequestException({
        message: 'Treasury bucket is already closed',
        code: ErrorCodes.ACCOUNT_ALREADY_CLOSED,
      });
    }

    if (account.status === 'EXPIRED') {
      throw new BadRequestException({
        message: `Treasury bucket is in terminal state '${account.status}' — cannot be closed`,
        code: ErrorCodes.ACCOUNT_TERMINAL_STATE,
      });
    }

    // ── EC-02: Archive all PENDING and RETRYING RuleExecutions ────────────
    const { count: archivedCount } = await this.prisma.ruleExecution.updateMany(
      {
        where: {
          accountId: account.id,
          status: { in: ['PENDING', 'RETRYING'] },
        },
        data: {
          status: 'ARCHIVED',
          archivedReason: 'CLOSED_BEFORE_COMPLETION',
        },
      },
    );

    this.logger.log(
      { bucketRef, archivedCount },
      'Archived pending/retrying rule executions on bucket close (EC-02)',
    );

    // Expire at Nomba
    await this.nombaClient.expireAccount(business, account.nombaAccountId);

    const beforeState = {
      status: account.status,
    };

    const updated = await this.prisma.account.update({
      where: { id: account.id },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        closedReason: 'Treasury bucket closed via API',
      },
    });

    // Audit
    await this.auditService.log({
      actor,
      action: AuditAction.TREASURY_BUCKET_CLOSED,
      accountId: account.id,
      businessId,
      beforeState,
      afterState: {
        status: 'CLOSED',
        closedAt: updated.closedAt?.toISOString(),
        archivedExecutionCount: archivedCount,
      },
      reasonCode: 'BUCKET_CLOSED',
    });

    this.logger.log({ bucketRef, archivedCount }, 'Treasury bucket closed');

    return updated;
  }

  // ─── getBalance (GET /treasury-buckets/:ref/balance) ──────────────────────

  /**
   * Get the current balance of a treasury bucket.
   * Computed as SUM(INFLOW) - SUM(MATCHED OUTFLOW) — no Nomba API call.
   */
  async getBalance(bucketRef: string, businessId: string) {
    const account = await this.prisma.account.findFirst({
      where: {
        accountRef: bucketRef,
        businessId,
        accountType: 'TREASURY_BUCKET',
      },
      select: { id: true, accountRef: true },
    });

    if (!account) {
      throw new NotFoundException({
        message: `Treasury bucket '${bucketRef}' not found`,
        code: ErrorCodes.ACCOUNT_NOT_FOUND,
      });
    }

    const balance = await this.ledgerService.getBalance(account.id);

    return {
      accountRef: account.accountRef,
      balanceKobo: balance,
    };
  }

  // ─── getStatement (GET /treasury-buckets/:ref/statement) ──────────────────

  /**
   * Get a paginated statement of ledger entries for a treasury bucket.
   * Filters by optional from/to dates and direction.
   */
  async getStatement(
    bucketRef: string,
    businessId: string,
    filters: {
      from?: string;
      to?: string;
      direction?: string;
      cursor?: string;
      limit?: number;
    },
  ) {
    const account = await this.prisma.account.findFirst({
      where: {
        accountRef: bucketRef,
        businessId,
        accountType: 'TREASURY_BUCKET',
      },
      select: { id: true },
    });

    if (!account) {
      throw new NotFoundException({
        message: `Treasury bucket '${bucketRef}' not found`,
        code: ErrorCodes.ACCOUNT_NOT_FOUND,
      });
    }

    // Build the query directly to support direction filter
    const where: Prisma.LedgerEntryWhereInput = { accountId: account.id };

    if (filters.from || filters.to) {
      where.receivedAt = {};
      if (filters.from) where.receivedAt.gte = new Date(filters.from);
      if (filters.to) where.receivedAt.lte = new Date(filters.to);
    }

    if (filters.direction) {
      where.direction =
        filters.direction as Prisma.EnumLedgerDirectionFilter['equals'];
    }

    const take = filters.limit ?? 50;
    const entries = await this.prisma.ledgerEntry.findMany({
      where,
      orderBy: { receivedAt: 'desc' },
      take: Math.min(take, 100),
      ...(filters.cursor ? { skip: 1, cursor: { id: filters.cursor } } : {}),
    });

    return {
      data: entries,
      nextCursor:
        entries.length === take ? entries[entries.length - 1].id : null,
    };
  }

  // ─── withdraw (POST /treasury-buckets/:ref/withdraw) ──────────────────────

  /**
   * Withdraw funds from a treasury bucket with balance-checked atomicity.
   *
   * Flow:
   * 1. getBalance → if insufficient: 422 INSUFFICIENT_BUCKET_BALANCE (no DB write)
   * 2. Write TREASURY_WITHDRAWAL_INITIATED AuditLogEntry BEFORE transaction
   * 3. Prisma $transaction: write OUTFLOW LedgerEntry, call Nomba transferFunds
   * 4. On Nomba success: update LedgerEntry reconciliationStatus = MATCHED,
   *    write TREASURY_WITHDRAWAL_COMPLETED AuditLogEntry
   * 5. On Nomba failure: rollback entire transaction,
   *    write TREASURY_WITHDRAWAL_FAILED AuditLogEntry, re-throw
   *
   * All amounts stored as BigInt; never Decimal or Float.
   */
  async withdraw(
    bucketRef: string,
    dto: WithdrawDto,
    businessId: string,
    business: {
      id: string;
      nombaAccountId: string | null;
      nombaSubAccountId: string | null;
      nombaClientId: string | null;
      nombaClientSecret: string | null;
      nombaWebhookSecret: string | null;
      webhookUrl: string | null;
      name: string;
      email: string;
      createdAt: Date;
      updatedAt: Date;
    },
  ) {
    // ── Step 0: Resolve the bucket ──────────────────────────────────────────
    const account = await this.prisma.account.findFirst({
      where: {
        accountRef: bucketRef,
        businessId,
        accountType: 'TREASURY_BUCKET',
      },
    });

    if (!account) {
      throw new NotFoundException({
        message: `Treasury bucket '${bucketRef}' not found`,
        code: ErrorCodes.ACCOUNT_NOT_FOUND,
      });
    }

    if (account.status !== 'ACTIVE') {
      throw new BadRequestException({
        message: `Treasury bucket is not active (current status: ${account.status})`,
        code: ErrorCodes.ACCOUNT_NOT_ACTIVE,
      });
    }

    // ── Step 1: Balance check (EC-07) ───────────────────────────────────────
    const balance = await this.ledgerService.getBalance(account.id);
    const amountKobo = BigInt(dto.amountKobo);

    if (balance < amountKobo) {
      throw new UnprocessableEntityException({
        message: `Insufficient bucket balance. Required: ${dto.amountKobo} kobo, Available: ${balance} kobo`,
        code: ErrorCodes.INSUFFICIENT_BUCKET_BALANCE,
        metadata: {
          requiredKobo: dto.amountKobo,
          availableKobo: Number(balance),
        },
      });
    }

    const transactionRef = `wdr_${uuidv4()}`;

    // ── Step 2: Write TREASURY_WITHDRAWAL_INITIATED audit entry BEFORE txn ──
    await this.auditService.log({
      actor: 'system',
      action: AuditAction.TREASURY_WITHDRAWAL_INITIATED,
      accountId: account.id,
      businessId,
      afterState: {
        amountKobo: dto.amountKobo,
        transactionRef,
        narration: dto.narration,
        bucketRef,
      },
    });

    // ── Step 3: Execute withdrawal inside a Prisma transaction ──────────────
    try {
      await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // Write OUTFLOW LedgerEntry
        const ledgerEntry = await tx.ledgerEntry.create({
          data: {
            accountId: account.id,
            nombaTransactionRef: transactionRef,
            nombaEventId: transactionRef,
            direction: 'OUTFLOW',
            amountKobo,
            currency: 'NGN',
            narration: dto.narration,
            customerNameSnapshot: business.name,
            kycTierAtTime: 'TIER_1',
            cumulativeAmountKobo: 0n,
            reconciliationStatus: 'PENDING',
            receivedAt: new Date(),
          },
        });

        // Call Nomba to transfer funds
        await this.nombaClient.transferFunds(business, {
          receiverAccountId: account.nombaAccountId,
          merchantTxRef: transactionRef,
          amount: Number(amountKobo),
          narration: dto.narration,
        });

        // Update reconciliation status on success
        await tx.ledgerEntry.update({
          where: { id: ledgerEntry.id },
          data: { reconciliationStatus: 'MATCHED' },
        });
      });

      // ── Step 4: Nomba success path ────────────────────────────────────────
      await this.auditService.log({
        actor: 'system',
        action: AuditAction.TREASURY_WITHDRAWAL_COMPLETED,
        accountId: account.id,
        businessId,
        afterState: {
          amountKobo: dto.amountKobo,
          transactionRef,
          bucketRef,
        },
      });

      this.logger.log(
        { bucketRef, amountKobo: dto.amountKobo, transactionRef },
        'Treasury withdrawal completed',
      );

      return {
        transactionRef,
        amountKobo: dto.amountKobo,
        status: 'COMPLETED',
      };
    } catch (error: unknown) {
      // ── Step 5: Nomba failure path — transaction rolled back automatically ──
      const errorMessage =
        error instanceof HttpException
          ? error.message
          : 'Nomba transfer failed';

      this.logger.error(
        {
          bucketRef,
          amountKobo: dto.amountKobo,
          transactionRef,
          error: errorMessage,
        },
        'Treasury withdrawal failed — transaction rolled back',
      );

      // Write failure audit entry (outside the rolled-back transaction)
      await this.auditService.log({
        actor: 'system',
        action: AuditAction.TREASURY_WITHDRAWAL_FAILED,
        accountId: account.id,
        businessId,
        afterState: {
          amountKobo: dto.amountKobo,
          transactionRef,
          bucketRef,
          error: errorMessage,
        },
      });

      if (error instanceof HttpException) {
        throw error;
      }

      throw new HttpException(
        {
          message: 'Treasury withdrawal failed: Nomba API error',
          code: ErrorCodes.NOMBA_API_ERROR,
          metadata: { transactionRef, error: errorMessage },
        },
        502,
      );
    }
  }
}
