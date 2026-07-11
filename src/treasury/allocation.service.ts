import { Injectable, Logger } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

/**
 * AllocationService — the Treasury Allocation Engine.
 *
 * Per technical-docs/TREASURY_BUILD.md, allocating an inflow across treasury
 * buckets is a PURELY INTERNAL ledger operation. It must NEVER call Nomba:
 * money already physically sits in the business's Nomba account; a bucket only
 * records logical ownership.
 *
 * A credit writes one immutable BucketLedgerEntry (CREDIT) with a running
 * cumulative balance, keyed by a unique `reference` for idempotency, and emits
 * an ALLOCATE_FUNDS audit entry.
 */
@Injectable()
export class AllocationService {
  private readonly logger = new Logger(AllocationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Credit a treasury bucket from an inflow allocation.
   *
   * Idempotent on `reference`: if an entry with the same reference already
   * exists (e.g. a retried webhook job), the existing balance is returned and
   * no duplicate entry is written.
   *
   * @returns the bucket's cumulative balance (kobo) after this credit
   */
  async credit(params: {
    bucketId: string;
    businessId: string;
    amountKobo: bigint;
    reference: string;
    sourceLedgerEntryId?: string;
    narration?: string;
    sourceAccountRef?: string;
  }): Promise<bigint> {
    const {
      bucketId,
      businessId,
      amountKobo,
      reference,
      sourceLedgerEntryId,
      narration,
      sourceAccountRef,
    } = params;

    const cumulative = await this.runSerializable<bigint>(() =>
      this.prisma.$transaction(
        async (tx): Promise<bigint> => {
          // Idempotency: same reference → no-op, return current balance.
          const existing = await tx.bucketLedgerEntry.findUnique({
            where: { reference },
            select: { cumulativeAmountKobo: true },
          });
          if (existing) {
            return existing.cumulativeAmountKobo;
          }

          const balance = await this.computeBalance(tx, bucketId);
          const newBalance = balance + amountKobo;

          await tx.bucketLedgerEntry.create({
            data: {
              bucketId,
              entryType: 'CREDIT',
              amountKobo,
              cumulativeAmountKobo: newBalance,
              reference,
              sourceLedgerEntryId: sourceLedgerEntryId ?? null,
              narration: narration ?? null,
            },
          });

          return newBalance;
        },
        // Serializable so concurrent credits to the SAME bucket can't both read
        // the same SUM and write a stale cumulativeAmountKobo. Conflicting txns
        // fail with 40001 and are retried by runSerializable().
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    await this.audit.log({
      actor: 'system',
      action: AuditAction.ALLOCATE_FUNDS,
      businessId,
      metadata: {
        bucketId,
        amountKobo: amountKobo.toString(),
        reference,
        sourceAccountRef,
        cumulativeAmountKobo: cumulative.toString(),
      },
    });

    this.logger.log(
      {
        bucketId,
        amountKobo: amountKobo.toString(),
        reference,
      },
      'Treasury allocation credited (internal — no Nomba call)',
    );

    return cumulative;
  }

  /**
   * Run a Serializable transaction, retrying on Postgres serialization failures
   * (SQLSTATE 40001). Two concurrent credits to the same bucket both read the
   * same SUM under snapshot isolation; the loser aborts with 40001 and is
   * replayed here so it re-reads the committed balance. Idempotency-on-reference
   * makes the replay safe.
   */
  private async runSerializable<T>(
    fn: () => Promise<T>,
    maxRetries = 5,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const isSerializationFailure =
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2034';
        if (!isSerializationFailure || attempt >= maxRetries) {
          throw err;
        }
        this.logger.warn(
          { attempt: attempt + 1 },
          'Bucket credit serialization conflict — retrying',
        );
      }
    }
  }

  /**
   * Compute a bucket's balance as SUM(CREDIT) - SUM(DEBIT) within a transaction.
   * Shared helper so allocation, transfer, and withdrawal all agree on the
   * ADR invariant: balance == Σ CREDIT − Σ DEBIT.
   */
  async computeBalance(
    tx: Prisma.TransactionClient,
    bucketId: string,
  ): Promise<bigint> {
    const [credit, debit] = await Promise.all([
      tx.bucketLedgerEntry.aggregate({
        where: { bucketId, entryType: 'CREDIT' },
        _sum: { amountKobo: true },
      }),
      tx.bucketLedgerEntry.aggregate({
        where: { bucketId, entryType: 'DEBIT' },
        _sum: { amountKobo: true },
      }),
    ]);

    return (credit._sum.amountKobo ?? 0n) - (debit._sum.amountKobo ?? 0n);
  }
}
