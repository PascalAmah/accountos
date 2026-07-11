import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AuditAction,
  Prisma,
  SettlementDestinationType,
  SettlementStatus,
} from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NombaClientService } from '../nomba-client/nomba-client.service';
import { AllocationService } from './allocation.service';
import { ErrorCodes } from '../common/constants/error-codes';
import { CreateSettlementDto } from './dto/create-settlement.dto';
import type { Business } from '@prisma/client';

/**
 * SettlementService — orchestrates the durable settlement lifecycle.
 *
 * Per TREASURY_BUILD.md §Settlement Lifecycle:
 *   PENDING → PROCESSING → COMPLETED (with Nomba call + DEBIT)
 *                       → FAILED    (reservation released, no DEBIT)
 *
 * For INTERNAL_BUCKET destinations, the settlement is an internal transfer
 * (no Nomba call) — reuses the existing bucket-transfer path.
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly nombaClient: NombaClientService,
    private readonly allocationService: AllocationService,
  ) {}

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Initiate a settlement lifecycle.
   *
   * TX1 (Serializable, lock bucket):
   *   1. Check available balance (ledgerBalance − reservedKobo)
   *   2. Create Settlement(PENDING) — reserves the amount
   *   3. Audit SETTLEMENT_RESERVED
   *
   * Outside the DB tx (no lock held across HTTP):
   *   4. Mark PROCESSING
   *   5. Call Nomba bankTransfer (or internal transfer if INTERNAL_BUCKET)
   *
   * TX2:
   *   6. On success → write DEBIT, Settlement → COMPLETED, store reference
   *   7. On failure → Settlement → FAILED + failureReason (no DEBIT)
   */
  async initiate(
    bucketRef: string,
    dto: CreateSettlementDto,
    businessId: string,
    business: Business,
    actor: string,
  ) {
    // Resolve bucket
    const bucket = await this.resolveBucket(bucketRef, businessId);
    if (bucket.status !== 'ACTIVE') {
      throw new BadRequestException({
        message: `Bucket is not active (status: ${bucket.status})`,
        code: ErrorCodes.ACCOUNT_NOT_ACTIVE,
      });
    }

    const amountKobo = BigInt(dto.amountKobo);

    // Resolve destination: request DTO wins, else bucket's saved destination
    const destType = (dto.destinationType ??
      bucket.settlementType ??
      'BANK_ACCOUNT') as SettlementDestinationType;

    const destAccountName =
      dto.destinationAccountName ?? bucket.settlementAccountName ?? undefined;
    const destAccountNumber =
      dto.destinationAccountNumber ??
      bucket.settlementAccountNumber ??
      undefined;
    const destBankCode =
      dto.destinationBankCode ?? bucket.settlementBankCode ?? undefined;
    const destBucketRef = dto.destinationBucketRef ?? undefined;

    // ── TX1: Reserve ─────────────────────────────────────────────────────────
    const settlement = await this.prisma.$transaction(
      async (tx) => {
        const locked = await this.lockBucket(tx, bucketRef, businessId);

        // Compute available = ledger balance − reserved
        const ledgerBalance = await this.latestBalance(tx, locked.id);
        const reservedKobo = await this.reservedKobo(tx, locked.id);
        const availableKobo = ledgerBalance - reservedKobo;

        if (availableKobo < amountKobo) {
          throw new UnprocessableEntityException({
            message: `Insufficient available balance. Required: ${dto.amountKobo} kobo, Available: ${availableKobo} kobo`,
            code: ErrorCodes.INSUFFICIENT_BUCKET_BALANCE,
            metadata: {
              requiredKobo: dto.amountKobo,
              availableKobo: Number(availableKobo),
              reservedKobo: Number(reservedKobo),
              ledgerBalanceKobo: Number(ledgerBalance),
            },
          });
        }

        const settlement = await tx.settlement.create({
          data: {
            bucketId: locked.id,
            businessId,
            amountKobo,
            status: 'PENDING',
            destinationType: destType,
            destinationAccountName: destAccountName ?? null,
            destinationAccountNumber: destAccountNumber ?? null,
            destinationBankCode: destBankCode ?? null,
            destinationBucketRef: destBucketRef ?? null,
            initiatedBy: actor,
          },
        });

        await this.audit.log({
          actor,
          action: AuditAction.SETTLEMENT_RESERVED,
          businessId,
          metadata: {
            settlementId: settlement.id,
            bucketRef,
            amountKobo: dto.amountKobo,
            destinationType: destType,
          },
        });

        return settlement;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    // ── Mark PROCESSING ──────────────────────────────────────────────────────
    await this.prisma.settlement.update({
      where: { id: settlement.id },
      data: { status: 'PROCESSING' },
    });

    // ── Execute the transfer outside DB tx ───────────────────────────────────
    try {
      if (destType === 'INTERNAL_BUCKET') {
        if (!destBucketRef) {
          throw new BadRequestException({
            message:
              'destinationBucketRef is required for INTERNAL_BUCKET settlements',
            code: ErrorCodes.VALIDATION_ERROR,
          });
        }
        await this.settleInternal(
          settlement.id,
          bucketRef,
          destBucketRef,
          amountKobo,
          businessId,
          actor,
          dto.narration,
        );
      } else {
        // BANK_ACCOUNT or NOMBA_ACCOUNT: call Nomba
        if (!destAccountNumber || !destBankCode || !destAccountName) {
          throw new BadRequestException({
            message:
              'Bank destination details required — provide destinationAccountNumber, destinationBankCode, and destinationAccountName',
            code: ErrorCodes.VALIDATION_ERROR,
          });
        }

        const transactionRef = `stl_${settlement.id}_${uuidv4().slice(0, 8)}`;
        await this.nombaClient.bankTransfer(business, {
          amount: Number(amountKobo) / 100,
          accountNumber: destAccountNumber,
          accountName: destAccountName,
          bankCode: destBankCode,
          merchantTxRef: transactionRef,
          narration: dto.narration,
        });

        // Nomba succeeded — write DEBIT and mark COMPLETED in a tx
        await this.completeSettlement(
          settlement.id,
          bucketRef,
          amountKobo,
          businessId,
          actor,
          transactionRef,
          dto.narration,
        );
      }

      return {
        settlementId: settlement.id,
        amountKobo: dto.amountKobo,
        status: 'COMPLETED',
      };
    } catch (error: unknown) {
      // Mark FAILED — release reservation (no DEBIT written)
      const errorMessage =
        error instanceof HttpException
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Unknown error';

      await this.prisma.settlement
        .update({
          where: { id: settlement.id },
          data: {
            status: 'FAILED',
            failureReason: errorMessage,
          },
        })
        .catch(() => {});

      await this.audit.log({
        actor: 'system',
        action: AuditAction.SETTLEMENT_FAILED,
        businessId,
        metadata: {
          settlementId: settlement.id,
          bucketRef,
          amountKobo: dto.amountKobo,
          error: errorMessage,
        },
      });

      this.logger.error(
        { settlementId: settlement.id, bucketRef, error: errorMessage },
        'Settlement failed — reservation released, no DEBIT written',
      );

      if (error instanceof HttpException) throw error;

      throw new HttpException(
        {
          message: 'Settlement failed: Nomba API error',
          code: ErrorCodes.NOMBA_API_ERROR,
          metadata: { settlementId: settlement.id, error: errorMessage },
        },
        502,
      );
    }
  }

  /**
   * Get settlements for a bucket, optionally filtered by status.
   */
  async getByBucket(
    bucketRef: string,
    businessId: string,
    options?: { status?: SettlementStatus; page?: number; limit?: number },
  ) {
    const bucket = await this.resolveBucket(bucketRef, businessId);
    const where: Prisma.SettlementWhereInput = { bucketId: bucket.id };
    if (options?.status) where.status = options.status;

    const page = options?.page ?? 1;
    const limit = options?.limit ?? 20;

    const [settlements, total] = await Promise.all([
      this.prisma.settlement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.settlement.count({ where }),
    ]);

    return {
      data: settlements,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Get a single settlement by ID.
   */
  async getById(settlementId: string, businessId: string) {
    const settlement = await this.prisma.settlement.findFirst({
      where: { id: settlementId, businessId },
    });
    if (!settlement) {
      throw new BadRequestException({
        message: 'Settlement not found',
        code: ErrorCodes.VALIDATION_ERROR,
      });
    }
    return settlement;
  }

  // ─── Balance helpers ──────────────────────────────────────────────────────

  /**
   * Latest balance — reads the most recent BucketLedgerEntry's
   * cumulativeAmountKobo (O(1) indexed lookup). Falls back to 0 if no entries.
   */
  async latestBalance(
    tx: Prisma.TransactionClient,
    bucketId: string,
  ): Promise<bigint> {
    const latest = await tx.bucketLedgerEntry.findFirst({
      where: { bucketId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { cumulativeAmountKobo: true },
    });
    return latest?.cumulativeAmountKobo ?? 0n;
  }

  /**
   * Reserved balance — SUM of Settlement.amountKobo where status IN (PENDING, PROCESSING).
   * Derived, not a mutable counter — preserves the immutable-ledger contract.
   */
  async reservedKobo(
    tx: Prisma.TransactionClient,
    bucketId: string,
  ): Promise<bigint> {
    const result = await tx.settlement.aggregate({
      where: { bucketId, status: { in: ['PENDING', 'PROCESSING'] } },
      _sum: { amountKobo: true },
    });
    return result._sum.amountKobo ?? 0n;
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  private async settleInternal(
    settlementId: string,
    sourceRef: string,
    destRef: string,
    amountKobo: bigint,
    businessId: string,
    actor: string,
    narration?: string,
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      const source = await this.lockBucket(tx, sourceRef, businessId);
      const dest = await this.lockBucket(tx, destRef, businessId);

      const sourceBalance = await this.allocationService.computeBalance(
        tx,
        source.id,
      );
      const destBalance = await this.allocationService.computeBalance(
        tx,
        dest.id,
      );

      const ref = `stl_int_${uuidv4()}`;
      await tx.bucketLedgerEntry.create({
        data: {
          bucketId: source.id,
          entryType: 'DEBIT',
          amountKobo,
          cumulativeAmountKobo: sourceBalance - amountKobo,
          reference: `${ref}_out`,
          narration: narration ?? null,
        },
      });
      await tx.bucketLedgerEntry.create({
        data: {
          bucketId: dest.id,
          entryType: 'CREDIT',
          amountKobo,
          cumulativeAmountKobo: destBalance + amountKobo,
          reference: `${ref}_in`,
          narration: narration ?? null,
        },
      });

      // Mark the settlement COMPLETED atomically with the ledger writes —
      // otherwise it stays PROCESSING and reservedKobo double-counts the amount
      // forever (leaking the reservation on top of the DEBIT).
      await tx.settlement.update({
        where: { id: settlementId },
        data: {
          status: 'COMPLETED',
          nombaTransferReference: ref,
          completedAt: new Date(),
        },
      });

      return { ref };
    });

    await this.audit.log({
      actor,
      action: AuditAction.SETTLEMENT_COMPLETED,
      businessId,
      metadata: {
        sourceBucketRef: sourceRef,
        destinationBucketRef: destRef,
        amountKobo: amountKobo.toString(),
        reference: result.ref,
        settlementType: 'INTERNAL_BUCKET',
      },
    });
  }

  private async completeSettlement(
    settlementId: string,
    bucketRef: string,
    amountKobo: bigint,
    businessId: string,
    actor: string,
    nombaReference: string,
    narration?: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockBucket(tx, bucketRef, businessId);
      const balance = await this.latestBalance(tx, locked.id);

      // Write DEBIT BucketLedgerEntry
      await tx.bucketLedgerEntry.create({
        data: {
          bucketId: locked.id,
          entryType: 'DEBIT',
          amountKobo,
          cumulativeAmountKobo: balance - amountKobo,
          reference: `stl_${nombaReference}`,
          narration: narration ?? null,
        },
      });

      // Mark settlement COMPLETED
      await tx.settlement.update({
        where: { id: settlementId },
        data: {
          status: 'COMPLETED',
          nombaTransferReference: nombaReference,
          completedAt: new Date(),
        },
      });
    });

    await this.audit.log({
      actor,
      action: AuditAction.SETTLEMENT_COMPLETED,
      businessId,
      metadata: {
        settlementId,
        bucketRef,
        amountKobo: amountKobo.toString(),
        nombaTransferReference: nombaReference,
      },
    });

    this.logger.log(
      { settlementId, bucketRef, amountKobo: amountKobo.toString() },
      'Settlement completed',
    );
  }

  private async resolveBucket(bucketRef: string, businessId: string) {
    const bucket = await this.prisma.treasuryBucket.findUnique({
      where: { businessId_bucketRef: { businessId, bucketRef } },
    });
    if (!bucket) {
      throw new BadRequestException({
        message: `Treasury bucket '${bucketRef}' not found`,
        code: ErrorCodes.BUCKET_NOT_FOUND,
      });
    }
    return bucket;
  }

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
      throw new BadRequestException({
        message: `Treasury bucket '${bucketRef}' not found`,
        code: ErrorCodes.BUCKET_NOT_FOUND,
      });
    }
    return rows[0];
  }
}
