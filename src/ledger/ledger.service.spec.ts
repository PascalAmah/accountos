import { LedgerService } from './ledger.service';

describe('LedgerService.writeInflow (H3 — concurrency safety)', () => {
  let service: LedgerService;
  let mockPrisma: any;
  let tx: any;
  let calls: string[];

  beforeEach(() => {
    calls = [];

    tx = {
      // Records ordering so we can assert the lock is taken before the SUM.
      $queryRaw: jest.fn().mockImplementation(() => {
        calls.push('lock');
        return Promise.resolve([{ id: 'acc_1' }]);
      }),
      ledgerEntry: {
        aggregate: jest.fn().mockImplementation(() => {
          calls.push('aggregate');
          return Promise.resolve({ _sum: { amountKobo: 2_000_000n } });
        }),
        create: jest.fn().mockImplementation(() => {
          calls.push('create');
          return Promise.resolve({ id: 'le_1' });
        }),
      },
    };

    mockPrisma = {
      $transaction: jest.fn().mockImplementation((fn: any) => fn(tx)),
    };

    service = new LedgerService(mockPrisma);
  });

  const dto = {
    accountId: 'acc_1',
    nombaTransactionRef: 'txn_1',
    nombaEventId: 'evt_1',
    amountKobo: 3_000_000,
    customerNameSnapshot: 'Alice',
    kycTierAtTime: 'TIER_1',
  } as any;

  it('locks the account row FOR UPDATE before aggregating the prior total', async () => {
    await service.writeInflow(dto);

    // Order must be: lock → aggregate → create
    expect(calls).toEqual(['lock', 'aggregate', 'create']);
    expect(tx.$queryRaw).toHaveBeenCalled();
  });

  it('returns cumulative = prior total + amount', async () => {
    const cumulative = await service.writeInflow(dto);
    expect(cumulative).toBe(5_000_000n); // 2,000,000 prior + 3,000,000
    expect(tx.ledgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          amountKobo: 3_000_000n,
          cumulativeAmountKobo: 5_000_000n,
        }),
      }),
    );
  });
});
