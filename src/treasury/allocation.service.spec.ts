import { AllocationService } from './allocation.service';

describe('AllocationService', () => {
  let service: AllocationService;
  let mockPrisma: any;
  let mockAudit: any;
  let tx: any;

  beforeEach(() => {
    tx = {
      bucketLedgerEntry: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'ble_1' }),
        aggregate: jest.fn(),
      },
    };

    mockPrisma = {
      $transaction: jest.fn().mockImplementation((fn: any) => fn(tx)),
    };

    mockAudit = { log: jest.fn().mockResolvedValue(undefined) };

    service = new AllocationService(mockPrisma, mockAudit);
  });

  function mockBalance(credit: bigint, debit: bigint) {
    tx.bucketLedgerEntry.aggregate
      .mockResolvedValueOnce({ _sum: { amountKobo: credit } }) // CREDIT
      .mockResolvedValueOnce({ _sum: { amountKobo: debit } }); // DEBIT
  }

  it('writes a CREDIT entry with cumulative = prior balance + amount', async () => {
    mockBalance(2_000_000n, 0n); // existing balance ₦20,000

    const cumulative = await service.credit({
      bucketId: 'bucket_1',
      businessId: 'biz_1',
      amountKobo: 3_000_000n,
      reference: 'alloc_txn_1_bucket_1',
      sourceLedgerEntryId: 'le_1',
    });

    expect(cumulative).toBe(5_000_000n);
    expect(tx.bucketLedgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entryType: 'CREDIT',
          amountKobo: 3_000_000n,
          cumulativeAmountKobo: 5_000_000n,
          reference: 'alloc_txn_1_bucket_1',
          sourceLedgerEntryId: 'le_1',
        }),
      }),
    );
    expect(mockAudit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ALLOCATE_FUNDS' }),
    );
  });

  it('is idempotent on reference — a duplicate credit is a no-op', async () => {
    tx.bucketLedgerEntry.findUnique.mockResolvedValue({
      cumulativeAmountKobo: 5_000_000n,
    });

    const cumulative = await service.credit({
      bucketId: 'bucket_1',
      businessId: 'biz_1',
      amountKobo: 3_000_000n,
      reference: 'alloc_txn_1_bucket_1',
    });

    expect(cumulative).toBe(5_000_000n);
    expect(tx.bucketLedgerEntry.create).not.toHaveBeenCalled();
  });

  it('computeBalance returns SUM(CREDIT) - SUM(DEBIT) (ADR invariant)', async () => {
    tx.bucketLedgerEntry.aggregate
      .mockResolvedValueOnce({ _sum: { amountKobo: 8_000_000n } })
      .mockResolvedValueOnce({ _sum: { amountKobo: 3_000_000n } });

    const balance = await service.computeBalance(tx, 'bucket_1');
    expect(balance).toBe(5_000_000n);
  });
});
