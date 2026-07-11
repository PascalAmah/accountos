import { SettlementService } from './settlement.service';
import { UnprocessableEntityException, HttpException } from '@nestjs/common';

/**
 * SettlementService unit tests.
 *
 * These cover the durable settlement lifecycle and, in particular, guard the two
 * defects found during review:
 *   1. INTERNAL_BUCKET settlements must be marked COMPLETED (else the reservation
 *      leaks forever and available balance is double-reduced).
 *   2. On Nomba failure, NO DEBIT is written and the settlement is marked FAILED
 *      (reservation released) — preserving ADR #13.
 */
describe('SettlementService', () => {
  let service: SettlementService;
  let mockPrisma: any;
  let mockAudit: any;
  let mockNomba: any;
  let mockAllocation: any;
  let tx: any;

  const mockBusiness = { id: 'biz_1', name: 'TestBiz' } as any;

  const mockBucket = {
    id: 'bucket_1',
    bucketRef: 'ops-bucket',
    status: 'ACTIVE',
    businessId: 'biz_1',
    settlementType: null,
    settlementAccountName: null,
    settlementAccountNumber: null,
    settlementBankCode: null,
  };

  // Ledger balance latestBalance() returns; reserved defaults to 0.
  let ledgerBalance: bigint;
  let reserved: bigint;

  const bankDto = {
    amountKobo: 5_000_000,
    narration: 'Payout',
    destinationAccountNumber: '0123456789',
    destinationBankCode: '044',
    destinationAccountName: 'Vendor Ltd',
  } as any;

  beforeEach(() => {
    ledgerBalance = 10_000_000n; // ₦100,000
    reserved = 0n;

    tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ id: mockBucket.id, status: mockBucket.status }]),
      bucketLedgerEntry: {
        create: jest.fn().mockResolvedValue({ id: 'ble_1' }),
        findFirst: jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve({ cumulativeAmountKobo: ledgerBalance }),
          ),
      },
      settlement: {
        create: jest.fn().mockResolvedValue({ id: 'stl_1' }),
        update: jest.fn().mockResolvedValue({ id: 'stl_1' }),
        aggregate: jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve({ _sum: { amountKobo: reserved } }),
          ),
      },
    };

    mockPrisma = {
      treasuryBucket: {
        findUnique: jest.fn().mockResolvedValue(mockBucket),
      },
      settlement: {
        update: jest.fn().mockResolvedValue({ id: 'stl_1' }),
      },
      $transaction: jest.fn().mockImplementation((fn: any) => fn(tx)),
    };

    mockAudit = { log: jest.fn().mockResolvedValue(undefined) };
    mockNomba = { bankTransfer: jest.fn().mockResolvedValue({ id: 'nmb_1' }) };
    mockAllocation = {
      computeBalance: jest
        .fn()
        .mockImplementation(() => Promise.resolve(ledgerBalance)),
    };

    service = new SettlementService(
      mockPrisma,
      mockAudit,
      mockNomba,
      mockAllocation,
    );
  });

  it('completes a BANK_ACCOUNT settlement: Nomba called once, DEBIT written, COMPLETED', async () => {
    const result = await service.initiate(
      'ops-bucket',
      bankDto,
      'biz_1',
      mockBusiness,
      'actor_1',
    );

    expect(mockNomba.bankTransfer).toHaveBeenCalledTimes(1);
    // DEBIT written only after Nomba success (completeSettlement tx)
    const debit = tx.bucketLedgerEntry.create.mock.calls.find(
      (c: any[]) => c[0].data.entryType === 'DEBIT',
    );
    expect(debit).toBeDefined();
    // Settlement marked COMPLETED with the Nomba reference
    const completed = tx.settlement.update.mock.calls.find(
      (c: any[]) => c[0].data.status === 'COMPLETED',
    );
    expect(completed).toBeDefined();
    expect(result.status).toBe('COMPLETED');
  });

  it('on Nomba failure: writes NO DEBIT and marks the settlement FAILED (ADR #13)', async () => {
    mockNomba.bankTransfer.mockRejectedValueOnce(new Error('Nomba down'));

    await expect(
      service.initiate('ops-bucket', bankDto, 'biz_1', mockBusiness, 'actor_1'),
    ).rejects.toBeInstanceOf(HttpException);

    // No DEBIT ledger entry was ever written
    const debit = tx.bucketLedgerEntry.create.mock.calls.find(
      (c: any[]) => c[0].data.entryType === 'DEBIT',
    );
    expect(debit).toBeUndefined();
    // Settlement moved to FAILED (reservation released)
    expect(mockPrisma.settlement.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });

  it('INTERNAL_BUCKET settlement is marked COMPLETED (reservation not leaked) and calls no Nomba', async () => {
    const internalDto = {
      amountKobo: 3_000_000,
      narration: 'Move to reserve',
      destinationType: 'INTERNAL_BUCKET',
      destinationBucketRef: 'reserve-bucket',
    } as any;

    await service.initiate(
      'ops-bucket',
      internalDto,
      'biz_1',
      mockBusiness,
      'actor_1',
    );

    expect(mockNomba.bankTransfer).not.toHaveBeenCalled();
    // Regression guard: the settlement row must be moved off PROCESSING.
    const completed = tx.settlement.update.mock.calls.find(
      (c: any[]) => c[0].data.status === 'COMPLETED',
    );
    expect(completed).toBeDefined();
  });

  it('rejects when available balance (ledger − reserved) is insufficient (422)', async () => {
    ledgerBalance = 4_000_000n; // ₦40,000 < ₦50,000 requested
    reserved = 0n;

    await expect(
      service.initiate('ops-bucket', bankDto, 'biz_1', mockBusiness, 'actor_1'),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(mockNomba.bankTransfer).not.toHaveBeenCalled();
  });

  it('counts in-flight reservations: available = ledger − reserved', async () => {
    ledgerBalance = 6_000_000n; // ₦60,000
    reserved = 4_000_000n; // ₦40,000 already reserved → ₦20,000 available < ₦50,000

    await expect(
      service.initiate('ops-bucket', bankDto, 'biz_1', mockBusiness, 'actor_1'),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});
