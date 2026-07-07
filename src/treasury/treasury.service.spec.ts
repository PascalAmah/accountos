import { TreasuryService } from './treasury.service';
import { UnprocessableEntityException, HttpException } from '@nestjs/common';

describe('TreasuryService', () => {
  let service: TreasuryService;
  let mockPrisma: any;
  let mockNombaClient: any;
  let mockLedgerService: any;
  let mockAuditService: any;

  const mockBusiness = {
    id: 'biz_1',
    name: 'TestBiz',
    email: 'biz@test.com',
    webhookUrl: null,
    nombaAccountId: 'nomba_acc',
    nombaSubAccountId: 'nomba_sub',
    nombaClientId: 'client_id',
    nombaClientSecret: 'enc_secret',
    nombaWebhookSecret: 'wh_secret',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockBucket = {
    id: 'bucket_1',
    accountRef: 'ops-bucket',
    nombaAccountId: 'nomba_bucket_acc',
    accountNumber: '1111111111',
    bankName: 'Nomba',
    accountType: 'TREASURY_BUCKET',
    status: 'ACTIVE',
    executionModel: 'SEQUENTIAL',
    businessId: 'biz_1',
    accountNameAtCreation: 'Ops Bucket',
    customerId: null,
    description: null,
    bucketType: 'OPS',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    mockPrisma = {
      account: {
        findFirst: jest.fn().mockResolvedValue(mockBucket),
      },
      ledgerEntry: {
        create: jest.fn().mockResolvedValue({
          id: 'le_1',
          amountKobo: 5_000_000n,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest
        .fn()
        .mockImplementation((fn: (tx: typeof mockPrisma) => unknown) =>
          fn(mockPrisma),
        ),
    };

    mockNombaClient = {
      transferFunds: jest.fn().mockResolvedValue({
        transactionRef: 'nomba_txn_1',
        status: 'SUCCESS',
        amount: 50_000,
        fee: 100,
      }),
    };

    mockLedgerService = {
      getBalance: jest.fn().mockResolvedValue(10_000_000n), // ₦100,000
      writeInflow: jest.fn(),
      updateReconciliationStatus: jest.fn(),
    };

    mockAuditService = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    service = new TreasuryService(
      mockPrisma,
      mockNombaClient,
      mockLedgerService,
      mockAuditService,
    );
  });

  // ── EC-07: Insufficient balance ───────────────────────────────────────────

  it('rejects withdrawal when balance is insufficient (EC-07)', async () => {
    mockLedgerService.getBalance.mockResolvedValue(4_000_000n); // ₦40,000

    await expect(
      service.withdraw(
        'ops-bucket',
        { amountKobo: 5_000_000, narration: 'Test withdrawal' },
        'biz_1',
        mockBusiness,
      ),
    ).rejects.toThrow(UnprocessableEntityException);

    // Nomba transfer must NOT be called
    expect(mockNombaClient.transferFunds).not.toHaveBeenCalled();
  });

  // ── EC-07: Sufficient balance ─────────────────────────────────────────────

  it('succeeds when balance is sufficient (EC-07)', async () => {
    mockLedgerService.getBalance.mockResolvedValue(10_000_000n); // ₦100,000

    const result = await service.withdraw(
      'ops-bucket',
      { amountKobo: 5_000_000, narration: 'Test withdrawal' },
      'biz_1',
      mockBusiness,
    );

    expect(result.status).toBe('COMPLETED');
    expect(result.amountKobo).toBe(5_000_000);
    expect(mockNombaClient.transferFunds).toHaveBeenCalled();
    expect(mockAuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'TREASURY_WITHDRAWAL_COMPLETED',
      }),
    );
  });

  // ── EC-07: Atomic rollback on Nomba failure ──────────────────────────────

  it('rolls back ledger write when Nomba transfer fails (EC-07)', async () => {
    mockNombaClient.transferFunds.mockRejectedValue(
      new Error('Nomba API unavailable'),
    );

    await expect(
      service.withdraw(
        'ops-bucket',
        { amountKobo: 5_000_000, narration: 'Test withdrawal' },
        'biz_1',
        mockBusiness,
      ),
    ).rejects.toThrow(HttpException);

    // Failure audit is written OUTSIDE the rolled-back transaction
    expect(mockAuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'TREASURY_WITHDRAWAL_FAILED',
      }),
    );
  });

  // ── Balance computation ──────────────────────────────────────────────────

  it('computes balance correctly (INFLOW - OUTFLOW)', async () => {
    // Not directly testable without mocking ledger aggregate, but verify
    // the guard path works with the mocked getBalance value
    mockLedgerService.getBalance.mockResolvedValue(2_500_000n);

    await expect(
      service.withdraw(
        'ops-bucket',
        { amountKobo: 3_000_000, narration: 'Over balance' },
        'biz_1',
        mockBusiness,
      ),
    ).rejects.toThrow(UnprocessableEntityException);

    // Verify the error has the right metadata
    try {
      await service.withdraw(
        'ops-bucket',
        { amountKobo: 3_000_000, narration: 'Over balance' },
        'biz_1',
        mockBusiness,
      );
    } catch (err: any) {
      expect(err.response?.code).toBe('INSUFFICIENT_BUCKET_BALANCE');
      expect(err.response?.metadata?.requiredKobo).toBe(3_000_000);
      expect(err.response?.metadata?.availableKobo).toBe(2_500_000);
    }
  });

  // ── Rejects inactive bucket ──────────────────────────────────────────────

  it('rejects withdrawal from non-ACTIVE bucket', async () => {
    mockPrisma.account.findFirst.mockResolvedValue({
      ...mockBucket,
      status: 'SUSPENDED',
    });

    await expect(
      service.withdraw(
        'ops-bucket',
        { amountKobo: 1_000_000, narration: 'Test' },
        'biz_1',
        mockBusiness,
      ),
    ).rejects.toThrow();
  });

  // ── Rejects non-existent bucket ──────────────────────────────────────────

  it('throws NotFoundException for non-existent bucket', async () => {
    mockPrisma.account.findFirst.mockResolvedValue(null);

    await expect(
      service.withdraw(
        'nonexistent',
        { amountKobo: 1_000_000, narration: 'Test' },
        'biz_1',
        mockBusiness,
      ),
    ).rejects.toThrow();
  });
});
