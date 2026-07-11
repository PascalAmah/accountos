import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WriteInflowDto } from './dto/write-inflow.dto';
import { WriteOutflowDto } from './dto/write-outflow.dto';
import { LedgerFiltersDto } from './dto/ledger-filters.dto';
import { Prisma, ReconciliationStatus } from '@prisma/client';
import { ErrorCodes } from '../common/constants/error-codes';

@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Look up an account by accountRef scoped to a business.
   * Returns the account ID or throws NotFoundException.
   */
  private async resolveAccountId(
    accountRef: string,
    businessId: string,
  ): Promise<string> {
    const account = await this.prisma.account.findFirst({
      where: { accountRef, businessId },
      select: { id: true },
    });

    if (!account) {
      throw new NotFoundException({
        message: 'Account not found',
        code: ErrorCodes.ACCOUNT_NOT_FOUND,
      });
    }

    return account.id;
  }

  /**
   * Write an INFLOW LedgerEntry with customer name + KYC snapshots
   * and cumulative amount computation, all inside a single Prisma transaction.
   *
   * INSERT-ONLY: no UPDATE or DELETE path exists for LedgerEntry records.
   *
   * @returns the cumulative amount KOBO after this inflow
   */
  async writeInflow(
    dto: WriteInflowDto,
    reconciliationStatus: ReconciliationStatus = 'PENDING',
  ): Promise<bigint> {
    const cumulativeAmountKobo = await this.prisma.$transaction(async (tx) => {
      // Lock the account row FOR UPDATE so concurrent inflows to the SAME
      // account serialize here. Without this, two concurrent inflows both read
      // the same prior SUM and write duplicate cumulativeAmountKobo values,
      // which can make cumulative_gte rules misfire or be missed. Different
      // accounts are unaffected — they lock different rows.
      await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${dto.accountId} FOR UPDATE`;

      const aggregate = await tx.ledgerEntry.aggregate({
        where: {
          accountId: dto.accountId,
          direction: 'INFLOW',
        },
        _sum: { amountKobo: true },
      });

      const priorTotal = aggregate._sum.amountKobo ?? 0n;

      await tx.ledgerEntry.create({
        data: {
          accountId: dto.accountId,
          nombaTransactionRef: dto.nombaTransactionRef,
          nombaEventId: dto.nombaEventId,
          direction: 'INFLOW',
          amountKobo: BigInt(dto.amountKobo),
          currency: 'NGN',
          senderName: dto.senderName ?? null,
          senderAccountNumber: dto.senderAccountNumber ?? null,
          senderBankCode: dto.senderBankCode ?? null,
          narration: dto.narration ?? null,
          customerNameSnapshot: dto.customerNameSnapshot ?? 'Unknown',
          kycTierAtTime: dto.kycTierAtTime ?? 'TIER_0',
          cumulativeAmountKobo: priorTotal + BigInt(dto.amountKobo),
          reconciliationStatus,
          receivedAt: new Date(),
        },
      });

      return priorTotal + BigInt(dto.amountKobo);
    });

    return cumulativeAmountKobo;
  }

  /**
   * Write an OUTFLOW LedgerEntry (e.g. treasury withdrawal).
   * INSERT-ONLY.
   */
  async writeOutflow(dto: WriteOutflowDto) {
    return this.prisma.ledgerEntry.create({
      data: {
        accountId: dto.accountId,
        nombaTransactionRef: dto.nombaTransactionRef,
        nombaEventId: dto.nombaTransactionRef,
        direction: 'OUTFLOW',
        amountKobo: BigInt(dto.amountKobo),
        currency: 'NGN',
        narration: dto.narration,
        customerNameSnapshot: dto.customerNameSnapshot ?? 'System',
        kycTierAtTime: dto.kycTierAtTime ?? 'TIER_0',
        cumulativeAmountKobo: dto.cumulativeAmountKobo ?? 0n,
        reconciliationStatus: 'PENDING',
        receivedAt: new Date(),
      },
    });
  }

  /**
   * Paginated ledger entries for an account, filterable by date range
   * and reconciliation status. Resolves the account by accountRef
   * scoped to the given business.
   */
  async getEntriesByAccountRef(
    accountRef: string,
    businessId: string,
    filters: LedgerFiltersDto,
  ) {
    const accountId = await this.resolveAccountId(accountRef, businessId);
    return this.getEntries(accountId, filters);
  }

  /**
   * Paginated ledger entries for an account, filterable by date range
   * and reconciliation status. Assumes accountId is already resolved.
   */
  async getEntries(accountId: string, filters: LedgerFiltersDto) {
    const where: Prisma.LedgerEntryWhereInput = { accountId };

    if (filters.from || filters.to) {
      where.receivedAt = {};
      if (filters.from) where.receivedAt.gte = new Date(filters.from);
      if (filters.to) where.receivedAt.lte = new Date(filters.to);
    }

    if (filters.reconciliationStatus) {
      where.reconciliationStatus = filters.reconciliationStatus;
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

  /**
   * Aggregate summary for an account: total inflows, total amount,
   * and breakdown by reconciliation status.
   * Resolves the account by accountRef scoped to the given business.
   */
  async getSummaryByAccountRef(accountRef: string, businessId: string) {
    const accountId = await this.resolveAccountId(accountRef, businessId);
    return this.getSummary(accountId);
  }

  /**
   * Aggregate summary for an account: total inflows, total amount,
   * and breakdown by reconciliation status.
   * Assumes accountId is already resolved.
   */
  async getSummary(accountId: string) {
    const [totalInflows, totalAmount, breakdown, lastInflow] =
      await Promise.all([
        this.prisma.ledgerEntry.count({
          where: { accountId, direction: 'INFLOW' },
        }),
        this.prisma.ledgerEntry.aggregate({
          where: { accountId, direction: 'INFLOW' },
          _sum: { amountKobo: true },
        }),
        this.prisma.ledgerEntry.groupBy({
          by: ['reconciliationStatus'],
          where: { accountId, direction: 'INFLOW' },
          _count: true,
        }),
        this.prisma.ledgerEntry.findFirst({
          where: { accountId, direction: 'INFLOW' },
          orderBy: { receivedAt: 'desc' },
          select: { receivedAt: true },
        }),
      ]);

    const reconciliationBreakdown: Record<string, number> = {};
    for (const row of breakdown) {
      reconciliationBreakdown[row.reconciliationStatus] = row._count;
    }

    return {
      totalInflows,
      totalAmountKobo: totalAmount._sum.amountKobo ?? 0n,
      lastInflowAt: lastInflow?.receivedAt ?? null,
      reconciliationBreakdown,
    };
  }

  /**
   * Update the reconciliation status of a ledger entry by transaction ref.
   */
  async updateReconciliationStatus(
    nombaTransactionRef: string,
    status: ReconciliationStatus,
  ): Promise<void> {
    await this.prisma.ledgerEntry.update({
      where: { nombaTransactionRef },
      data: { reconciliationStatus: status },
    });
  }

  /**
   * Compute current balance as SUM(INFLOW) - SUM(OUTFLOW).
   * No Nomba API call — the ledger is the source of truth.
   */
  async getBalance(accountId: string): Promise<bigint> {
    const [inflow, outflow] = await Promise.all([
      this.prisma.ledgerEntry.aggregate({
        where: { accountId, direction: 'INFLOW' },
        _sum: { amountKobo: true },
      }),
      this.prisma.ledgerEntry.aggregate({
        where: {
          accountId,
          direction: 'OUTFLOW',
          reconciliationStatus: 'MATCHED',
        },
        _sum: { amountKobo: true },
      }),
    ]);

    return (inflow._sum.amountKobo ?? 0n) - (outflow._sum.amountKobo ?? 0n);
  }

  /**
   * Export ledger entries as CSV string.
   * Resolves the account by accountRef scoped to the given business.
   */
  async exportCsvByAccountRef(
    accountRef: string,
    businessId: string,
  ): Promise<string> {
    const accountId = await this.resolveAccountId(accountRef, businessId);
    return this.exportCsv(accountId);
  }

  /**
   * Export ledger entries as CSV string.
   * Assumes accountId is already resolved.
   */
  async exportCsv(accountId: string): Promise<string> {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { accountId },
      orderBy: { receivedAt: 'asc' },
    });

    const header =
      'entryId,nombaTransactionRef,direction,amountNgn,currency,senderName,customerNameSnapshot,kycTierAtTime,reconciliationStatus,receivedAt';
    const rows = entries.map((e) =>
      [
        e.id,
        e.nombaTransactionRef,
        e.direction,
        Number(e.amountKobo / 100n),
        e.currency,
        e.senderName ?? '',
        e.customerNameSnapshot,
        e.kycTierAtTime,
        e.reconciliationStatus,
        e.receivedAt.toISOString(),
      ]
        .map((v) => this.csvCell(v))
        .join(','),
    );

    return [header, ...rows].join('\n');
  }

  /**
   * Render a single CSV cell safely.
   *
   * Prevents CSV injection: values beginning with =, +, -, @ (or tab/CR) are
   * treated as formulas by spreadsheet software, so they are prefixed with a
   * single quote. Values are always double-quoted and embedded quotes doubled,
   * so commas/newlines/quotes in names or narrations can't corrupt the layout.
   */
  private csvCell(value: unknown): string {
    let s = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(s)) {
      s = `'${s}`;
    }
    return `"${s.replace(/"/g, '""')}"`;
  }
}
