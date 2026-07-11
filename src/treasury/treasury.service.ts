import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuditAction, Business, Prisma } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { NombaClientService } from '../nomba-client/nomba-client.service';
import { AllocationService } from './allocation.service';
import { SettlementService } from './settlement.service';
import { ErrorCodes } from '../common/constants/error-codes';
import { CreateBucketDto } from './dto/create-bucket.dto';
import { RenameBucketDto } from './dto/rename-bucket.dto';
import { WithdrawDto } from './dto/withdraw.dto';
import { TransferBucketDto } from './dto/transfer-bucket.dto';

/**
 * TreasuryService — logical treasury buckets (see technical-docs/TREASURY_BUILD.md).
 *
 * Buckets are internal sub-ledgers, NOT Nomba DVAs. Money physically lives in the
 * business's Nomba account. The only place this service touches Nomba is settlement
 * (withdrawal) to an external bank. Provisioning, allocation, balance, statements,
 * and bucket→bucket transfers are all pure database operations.
 */
@Injectable()
export class TreasuryService {
  private readonly logger = new Logger(TreasuryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly nombaClient: NombaClientService,
    private readonly allocationService: AllocationService,
    private readonly auditService: AuditService,
    private readonly settlementService: SettlementService,
  ) {}

  // ─── provisionBucket (POST /treasury-buckets) ──────────────────────────────

  /**
   * Provision a new treasury bucket. Creates a TreasuryBucket row only — NO Nomba
   * DVA is provisioned (buckets are logical). Optionally stores a default
   * settlement destination.
   */
  async provisionBucket(dto: CreateBucketDto, businessId: string) {
    // Uniqueness is enforced per business by the @@unique([businessId, bucketRef]).
    const existing = await this.prisma.treasuryBucket.findUnique({
      where: { businessId_bucketRef: { businessId, bucketRef: dto.bucketRef } },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException({
        message: `Treasury bucket with ref '${dto.bucketRef}' already exists`,
        code: ErrorCodes.DUPLICATE_ACCOUNT_REF,
      });
    }

    const bucket = await this.prisma.treasuryBucket.create({
      data: {
        bucketRef: dto.bucketRef,
        name: dto.name,
        bucketType: dto.bucketType,
        description: dto.description ?? null,
        businessId,
        settlementType: dto.settlementType ?? null,
        settlementAccountName: dto.settlementAccountName ?? null,
        settlementAccountNumber: dto.settlementAccountNumber ?? null,
        settlementBankCode: dto.settlementBankCode ?? null,
      },
    });

    await this.auditService.log({
      actor: 'system',
      action: AuditAction.TREASURY_BUCKET_CREATED,
      businessId,
      afterState: {
        bucketRef: bucket.bucketRef,
        bucketType: bucket.bucketType,
        name: bucket.name,
        description: bucket.description,
        settlementType: bucket.settlementType,
      },
    });

    this.logger.log(
      { bucketRef: bucket.bucketRef, bucketType: bucket.bucketType },
      'Treasury bucket provisioned (logical — no Nomba DVA)',
    );

    return { ...bucket, balanceKobo: 0n };
  }

  // ─── getBuckets (GET /treasury-buckets) ────────────────────────────────────

  async getBuckets(
    businessId: string,
    filters: { page: number; limit: number; status?: string },
  ) {
    const where: Prisma.TreasuryBucketWhereInput = { businessId };

    if (filters.status) {
      where.status = filters.status as Prisma.EnumAccountStatusFilter['equals'];
    }

    const [buckets, total] = await Promise.all([
      this.prisma.treasuryBucket.findMany({
        where,
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.treasuryBucket.count({ where }),
    ]);

    return {
      data: buckets,
      meta: {
        total,
        page: filters.page,
        limit: filters.limit,
        totalPages: Math.ceil(total / filters.limit),
      },
    };
  }

  // ─── getBucket (GET /treasury-buckets/:ref) ────────────────────────────────

  async getBucket(bucketRef: string, businessId: string) {
    const bucket = await this.resolveBucket(bucketRef, businessId);
    const balance = await this.balanceOf(bucket.id);
    const reserved = await this.prisma.$transaction((tx) =>
      this.settlementService.reservedKobo(tx, bucket.id),
    );
    const available = balance - reserved;
    return {
      ...bucket,
      balanceKobo: balance,
      availableKobo: available,
      reservedKobo: reserved,
    };
  }

  // ─── renameBucket (PATCH /treasury-buckets/:ref) ──────────────────────────

  async renameBucket(
    bucketRef: string,
    dto: RenameBucketDto,
    businessId: string,
  ) {
    const bucket = await this.resolveBucket(bucketRef, businessId);

    const updated = await this.prisma.treasuryBucket.update({
      where: { id: bucket.id },
      data: { name: dto.name },
    });

    this.logger.log(
      { bucketRef, previousName: bucket.name, newName: dto.name },
      'Treasury bucket renamed',
    );

    return updated;
  }

  // ─── closeBucket (DELETE /treasury-buckets/:ref) ──────────────────────────

  /**
   * Close a treasury bucket. Buckets are logical, so there is no Nomba DVA to
   * expire and no in-flight rule executions attached to a bucket. Closing simply
   * marks the bucket CLOSED with an audit entry. A bucket with a non-zero balance
   * cannot be closed — settle or transfer it out first.
   */
  async closeBucket(bucketRef: string, businessId: string, actor: string) {
    const bucket = await this.resolveBucket(bucketRef, businessId);

    if (bucket.status === 'CLOSED') {
      throw new BadRequestException({
        message: 'Treasury bucket is already closed',
        code: ErrorCodes.ACCOUNT_ALREADY_CLOSED,
      });
    }

    const balance = await this.balanceOf(bucket.id);
    const reserved = await this.prisma.$transaction((tx) =>
      this.settlementService.reservedKobo(tx, bucket.id),
    );
    if (balance !== 0n || reserved !== 0n) {
      throw new BadRequestException({
        message: `Treasury bucket has a non-zero balance (${balance} kobo) or pending reservations (${reserved} kobo) — settle or transfer funds before closing`,
        code: ErrorCodes.INSUFFICIENT_BUCKET_BALANCE,
      });
    }

    const updated = await this.prisma.treasuryBucket.update({
      where: { id: bucket.id },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        closedReason: 'Treasury bucket closed via API',
      },
    });

    await this.auditService.log({
      actor,
      action: AuditAction.TREASURY_BUCKET_CLOSED,
      businessId,
      beforeState: { status: bucket.status },
      afterState: {
        status: 'CLOSED',
        closedAt: updated.closedAt?.toISOString(),
      },
      reasonCode: 'BUCKET_CLOSED',
    });

    this.logger.log({ bucketRef }, 'Treasury bucket closed');
    return updated;
  }

  // ─── getBalance (GET /treasury-buckets/:ref/balance) ──────────────────────

  async getBalance(bucketRef: string, businessId: string) {
    const bucket = await this.resolveBucket(bucketRef, businessId);
    const balance = await this.balanceOf(bucket.id);
    const reserved = await this.prisma.$transaction((tx) =>
      this.settlementService.reservedKobo(tx, bucket.id),
    );
    return {
      bucketRef: bucket.bucketRef,
      balanceKobo: balance,
      availableKobo: balance - reserved,
      reservedKobo: reserved,
    };
  }

  // ─── getStatement (GET /treasury-buckets/:ref/statement) ──────────────────

  async getStatement(
    bucketRef: string,
    businessId: string,
    filters: {
      from?: string;
      to?: string;
      entryType?: string;
      cursor?: string;
      limit?: number;
    },
  ) {
    const bucket = await this.resolveBucket(bucketRef, businessId);

    const where: Prisma.BucketLedgerEntryWhereInput = { bucketId: bucket.id };

    if (filters.from || filters.to) {
      where.createdAt = {};
      if (filters.from) where.createdAt.gte = new Date(filters.from);
      if (filters.to) where.createdAt.lte = new Date(filters.to);
    }

    if (filters.entryType) {
      where.entryType =
        filters.entryType as Prisma.EnumBucketEntryTypeFilter['equals'];
    }

    const take = Math.min(filters.limit ?? 50, 100);
    const entries = await this.prisma.bucketLedgerEntry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      ...(filters.cursor ? { skip: 1, cursor: { id: filters.cursor } } : {}),
    });

    return {
      data: entries,
      nextCursor:
        entries.length === take ? entries[entries.length - 1].id : null,
    };
  }

  // ─── transferBetweenBuckets (POST /treasury-buckets/:ref/transfer) ────────

  /**
   * Move value from one bucket to another as a pure internal ledger operation.
   * Debits the source and credits the destination atomically. Never calls Nomba.
   */
  async transferBetweenBuckets(
    sourceBucketRef: string,
    dto: TransferBucketDto,
    businessId: string,
    actor: string,
  ) {
    if (dto.destinationBucketRef === sourceBucketRef) {
      throw new BadRequestException({
        message: 'Source and destination buckets must differ',
        code: ErrorCodes.VALIDATION_ERROR,
      });
    }

    const amountKobo = BigInt(dto.amountKobo);

    const result = await this.prisma.$transaction(async (tx) => {
      const source = await this.lockBucket(tx, sourceBucketRef, businessId);
      const destination = await this.lockBucket(
        tx,
        dto.destinationBucketRef,
        businessId,
      );

      if (source.status !== 'ACTIVE') {
        throw new BadRequestException({
          message: `Source bucket is not active (status: ${source.status})`,
          code: ErrorCodes.ACCOUNT_NOT_ACTIVE,
        });
      }
      if (destination.status !== 'ACTIVE') {
        throw new BadRequestException({
          message: `Destination bucket is not active (status: ${destination.status})`,
          code: ErrorCodes.ACCOUNT_NOT_ACTIVE,
        });
      }

      const sourceBalance = await this.allocationService.computeBalance(
        tx,
        source.id,
      );
      if (sourceBalance < amountKobo) {
        throw new UnprocessableEntityException({
          message: `Insufficient bucket balance. Required: ${dto.amountKobo} kobo, Available: ${sourceBalance} kobo`,
          code: ErrorCodes.INSUFFICIENT_BUCKET_BALANCE,
        });
      }

      const ref = `xfer_${uuidv4()}`;
      const destBalance = await this.allocationService.computeBalance(
        tx,
        destination.id,
      );

      await tx.bucketLedgerEntry.create({
        data: {
          bucketId: source.id,
          entryType: 'DEBIT',
          amountKobo,
          cumulativeAmountKobo: sourceBalance - amountKobo,
          reference: `${ref}_out`,
          narration: dto.narration,
        },
      });

      await tx.bucketLedgerEntry.create({
        data: {
          bucketId: destination.id,
          entryType: 'CREDIT',
          amountKobo,
          cumulativeAmountKobo: destBalance + amountKobo,
          reference: `${ref}_in`,
          narration: dto.narration,
        },
      });

      return {
        ref,
        sourceId: source.id,
        destinationId: destination.id,
        sourceBalance: sourceBalance - amountKobo,
        destinationBalance: destBalance + amountKobo,
      };
    });

    await this.auditService.log({
      actor,
      action: AuditAction.BUCKET_TRANSFER,
      businessId,
      metadata: {
        reference: result.ref,
        sourceBucketRef,
        destinationBucketRef: dto.destinationBucketRef,
        amountKobo: dto.amountKobo,
      },
    });

    this.logger.log(
      {
        sourceBucketRef,
        destinationBucketRef: dto.destinationBucketRef,
        amountKobo: dto.amountKobo,
      },
      'Bucket-to-bucket transfer completed (internal)',
    );

    return {
      reference: result.ref,
      amountKobo: dto.amountKobo,
      sourceBalanceKobo: result.sourceBalance,
      destinationBalanceKobo: result.destinationBalance,
      status: 'COMPLETED',
    };
  }

  // ─── withdraw (POST /treasury-buckets/:ref/withdraw) ──────────────────────

  /**
   * Settle funds out of a treasury bucket to an EXTERNAL bank account.
   *
   * This is the only Nomba call in the treasury layer. Flow:
   *   1. Resolve destination bank details (request body, else saved settlement).
   *   2. Inside a serializable transaction, lock the bucket row (FOR UPDATE),
   *      re-check the balance (EC-07), and write a DEBIT settlement entry.
   *   3. Call Nomba bankTransfer (Naira). On success commit; on failure roll back
   *      the DEBIT and surface the error.
   */
  async withdraw(
    bucketRef: string,
    dto: WithdrawDto,
    businessId: string,
    business: Business,
  ) {
    const bucket = await this.resolveBucket(bucketRef, businessId);

    if (bucket.status !== 'ACTIVE') {
      throw new BadRequestException({
        message: `Treasury bucket is not active (current status: ${bucket.status})`,
        code: ErrorCodes.ACCOUNT_NOT_ACTIVE,
      });
    }

    // Resolve destination bank details: request body wins, else saved settlement.
    const accountNumber =
      dto.destinationAccountNumber ??
      bucket.settlementAccountNumber ??
      undefined;
    const bankCode =
      dto.destinationBankCode ?? bucket.settlementBankCode ?? undefined;
    const accountName =
      dto.destinationAccountName ?? bucket.settlementAccountName ?? undefined;

    if (!accountNumber || !bankCode || !accountName) {
      throw new BadRequestException({
        message:
          'Destination bank details required — provide destinationAccountNumber, destinationBankCode, and destinationAccountName, or configure a BANK_ACCOUNT settlement destination on the bucket',
        code: ErrorCodes.VALIDATION_ERROR,
      });
    }

    const amountKobo = BigInt(dto.amountKobo);
    const transactionRef = `wdr_${uuidv4()}`;

    await this.auditService.log({
      actor: 'system',
      action: AuditAction.TREASURY_WITHDRAWAL_INITIATED,
      businessId,
      afterState: {
        amountKobo: dto.amountKobo,
        transactionRef,
        narration: dto.narration,
        bucketRef,
      },
    });

    try {
      await this.prisma.$transaction(
        async (tx) => {
          const locked = await this.lockBucket(tx, bucketRef, businessId);

          const balance = await this.allocationService.computeBalance(
            tx,
            locked.id,
          );
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

          // ADR #13: settle to the external bank FIRST. The per-bucket FOR UPDATE
          // lock is still held, so no concurrent withdrawal can race the balance.
          // The one Nomba call: settle to the external bank (amount in Naira).
          await this.nombaClient.bankTransfer(business, {
            amount: Number(amountKobo) / 100,
            accountNumber,
            accountName,
            bankCode,
            merchantTxRef: transactionRef,
            narration: dto.narration,
          });

          // Only debit the bucket once Nomba has confirmed the transfer. If the
          // call above threw, this never runs and the transaction rolls back —
          // the bucket is never debited for a transfer that did not complete.
          await tx.bucketLedgerEntry.create({
            data: {
              bucketId: locked.id,
              entryType: 'DEBIT',
              amountKobo,
              cumulativeAmountKobo: balance - amountKobo,
              reference: transactionRef,
              narration: dto.narration,
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );

      await this.auditService.log({
        actor: 'system',
        action: AuditAction.TREASURY_WITHDRAWAL_COMPLETED,
        businessId,
        afterState: { amountKobo: dto.amountKobo, transactionRef, bucketRef },
      });

      this.logger.log(
        { bucketRef, amountKobo: dto.amountKobo, transactionRef },
        'Treasury withdrawal settled to external bank',
      );

      return {
        transactionRef,
        amountKobo: dto.amountKobo,
        status: 'COMPLETED',
      };
    } catch (error: unknown) {
      // EC-07: balance failure surfaces as 422 (no Nomba call, DEBIT rolled back)
      if (error instanceof UnprocessableEntityException) {
        throw error;
      }

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

      await this.auditService.log({
        actor: 'system',
        action: AuditAction.TREASURY_WITHDRAWAL_FAILED,
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

  // ─── Internal helpers ─────────────────────────────────────────────────────

  /** Resolve a bucket scoped to the business, or throw 404. */
  private async resolveBucket(bucketRef: string, businessId: string) {
    const bucket = await this.prisma.treasuryBucket.findUnique({
      where: { businessId_bucketRef: { businessId, bucketRef } },
    });

    if (!bucket) {
      throw new NotFoundException({
        message: `Treasury bucket '${bucketRef}' not found`,
        code: ErrorCodes.BUCKET_NOT_FOUND,
      });
    }

    return bucket;
  }

  /**
   * Lock a bucket row FOR UPDATE inside a transaction to serialize concurrent
   * balance-mutating operations (withdrawal, transfer) and prevent overdraw.
   */
  private async lockBucket(
    tx: Prisma.TransactionClient,
    bucketRef: string,
    businessId: string,
  ): Promise<{ id: string; status: string }> {
    const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT "id", "status"::text AS "status"
      FROM "TreasuryBucket"
      WHERE "bucketRef" = ${bucketRef} AND "businessId" = ${businessId}
      FOR UPDATE
    `;

    if (rows.length === 0) {
      throw new NotFoundException({
        message: `Treasury bucket '${bucketRef}' not found`,
        code: ErrorCodes.BUCKET_NOT_FOUND,
      });
    }

    return rows[0];
  }

  /** Balance = SUM(CREDIT) - SUM(DEBIT). */
  private async balanceOf(bucketId: string): Promise<bigint> {
    return this.prisma.$transaction((tx) =>
      this.allocationService.computeBalance(tx, bucketId),
    );
  }
}
