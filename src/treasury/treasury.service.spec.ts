import { TreasuryService } from './treasury.service';
import { UnprocessableEntityException, HttpException } from '@nestjs/common';

describe('TreasuryService', () => {
  let service: TreasuryService;
  let mockPrisma: any;
  let mockNombaClient: any;
  let mockAllocationService: any;
  let mockAuditService: any;
  let mockSettlementService: any;

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
  } as any;

  const mockBucket = {
    id: 'bucket_1',
    bucketRef: 'ops-bucket',
    name: 'Ops Bucket',
    bucketType: 'OPERATIONS',
    description: null,
    status: 'ACTIVE',
    businessId: 'biz_1',
    settlementType: null,
    settlementAccountName: null,
    settlementAccountNumber: null,
    settlementBankCode: null,
    closedAt: null,
    closedReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Balance the AllocationService.computeBalance mock returns.
  let currentBalance: bigint;

  const validBankDetails = {
    destinationAccountNumber: '0123456789',
    destinationBankCode: '044',
    destinationAccountName: 'Vendor Ltd',
  };

  beforeEach(() => {
    currentBalance = 10_000_000n; // ₦100,000

    mockPrisma = {
      treasuryBucket: {
        findUnique: jest.fn().mockResolvedValue(mockBucket),
      },
      bucketLedgerEntry: {
        create: jest.fn().mockResolvedValue({ id: 'ble_1' }),
      },
      // $transaction runs the callback with a tx client that supports the
      // row lock ($queryRaw) and bucketLedgerEntry.create.
      $transaction: jest.fn().mockImplementation((fn: any) =>
        fn({
          $queryRaw: jest
            .fn()
            .mockResolvedValue([
              { id: mockBucket.id, status: mockBucket.status },
            ]),
          bucketLedgerEntry: mockPrisma.bucketLedgerEntry,
        }),
      ),
    };

    mockNombaClient = {
      bankTransfer: jest.fn().mockResolvedValue({
        transactionRef: 'nomba_bank_txn_1',
        status: 'SUCCESS',
        amount: 50_000,
        fee: 100,
      }),
    };

    mockAllocationService = {
      computeBalance: jest.fn().mockImplementation(() => currentBalance),
    };

    mockAuditService = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    mockSettlementService = {
      reservedKobo: jest.fn().mockResolvedValue(0n),
    };

    service = new TreasuryService(
      mockPrisma,
      mockNombaClient,
      mockAllocationService,
      mockAuditService,
      mockSettlementService,
    );
  });

  // ── EC-07: Insufficient balance ───────────────────────────────────────────

  it('rejects withdrawal when balance is insufficient (EC-07) with no Nomba call', async () => {
    currentBalance = 4_000_000n; // ₦40,000

    await expect(
      service.withdraw(
        'ops-bucket',
        { amountKobo: 5_000_000, narration: 'Test', ...validBankDetails },
        'biz_1',
        mockBusiness,
      ),
    ).rejects.toThrow(UnprocessableEntityException);

    // Settlement to the external bank must NOT be attempted.
    expect(mockNombaClient.bankTransfer).not.toHaveBeenCalled();
  });

  // ── EC-07: Sufficient balance settles to external bank ───────────────────

  it('settles to an external bank via bankTransfer (Naira) when balance is sufficient', async () => {
    const result = await service.withdraw(
      'ops-bucket',
      { amountKobo: 5_000_000, narration: 'Payout', ...validBankDetails },
      'biz_1',
      mockBusiness,
    );

    expect(result.status).toBe('COMPLETED');
    expect(result.amountKobo).toBe(5_000_000);

    // Exactly one bankTransfer with the amount converted to NAIRA (kobo / 100).
    expect(mockNombaClient.bankTransfer).toHaveBeenCalledTimes(1);
    expect(mockNombaClient.bankTransfer).toHaveBeenCalledWith(
      mockBusiness,
      expect.objectContaining({
        amount: 50_000, // 5_000_000 kobo / 100
        accountNumber: '0123456789',
        bankCode: '044',
        accountName: 'Vendor Ltd',
      }),
    );

    // A DEBIT entry is written on the bucket ledger.
    expect(mockPrisma.bucketLedgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entryType: 'DEBIT',
          amountKobo: 5_000_000n,
        }),
      }),
    );

    expect(mockAuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'TREASURY_WITHDRAWAL_COMPLETED' }),
    );
  });

  // ── Withdrawal falls back to saved BANK_ACCOUNT settlement destination ────

  it('falls back to the saved settlement destination when bank fields are omitted', async () => {
    mockPrisma.treasuryBucket.findUnique.mockResolvedValue({
      ...mockBucket,
      settlementType: 'BANK_ACCOUNT',
      settlementAccountNumber: '9998887776',
      settlementBankCode: '058',
      settlementAccountName: 'Saved Payout',
    });

    await service.withdraw(
      'ops-bucket',
      { amountKobo: 1_000_000, narration: 'Payout' },
      'biz_1',
      mockBusiness,
    );

    expect(mockNombaClient.bankTransfer).toHaveBeenCalledWith(
      mockBusiness,
      expect.objectContaining({
        accountNumber: '9998887776',
        bankCode: '058',
        accountName: 'Saved Payout',
      }),
    );
  });

  // ── Missing bank details with no saved settlement → 400 ──────────────────

  it('rejects withdrawal when no destination bank details are available', async () => {
    await expect(
      service.withdraw(
        'ops-bucket',
        { amountKobo: 1_000_000, narration: 'Payout' },
        'biz_1',
        mockBusiness,
      ),
    ).rejects.toThrow();
    expect(mockNombaClient.bankTransfer).not.toHaveBeenCalled();
  });

  // ── Atomic rollback on Nomba failure ─────────────────────────────────────

  it('surfaces a 502 and logs FAILED when the bank transfer fails', async () => {
    mockNombaClient.bankTransfer.mockRejectedValue(
      new Error('Nomba API unavailable'),
    );

    await expect(
      service.withdraw(
        'ops-bucket',
        { amountKobo: 5_000_000, narration: 'Payout', ...validBankDetails },
        'biz_1',
        mockBusiness,
      ),
    ).rejects.toThrow(HttpException);

    expect(mockAuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'TREASURY_WITHDRAWAL_FAILED' }),
    );

    // ADR #13: the bucket must never be debited when the transfer did not
    // complete. Nomba runs before the DEBIT, so a rejection means no ledger
    // entry was ever written.
    expect(mockPrisma.bucketLedgerEntry.create).not.toHaveBeenCalled();
  });

  // ── Rejects inactive bucket ──────────────────────────────────────────────

  it('rejects withdrawal from a non-ACTIVE bucket', async () => {
    mockPrisma.treasuryBucket.findUnique.mockResolvedValue({
      ...mockBucket,
      status: 'SUSPENDED',
    });

    await expect(
      service.withdraw(
        'ops-bucket',
        { amountKobo: 1_000_000, narration: 'Test', ...validBankDetails },
        'biz_1',
        mockBusiness,
      ),
    ).rejects.toThrow();
  });

  // ── Rejects non-existent bucket ──────────────────────────────────────────

  it('throws NotFoundException for a non-existent bucket', async () => {
    mockPrisma.treasuryBucket.findUnique.mockResolvedValue(null);

    await expect(
      service.withdraw(
        'nonexistent',
        { amountKobo: 1_000_000, narration: 'Test', ...validBankDetails },
        'biz_1',
        mockBusiness,
      ),
    ).rejects.toThrow();
  });

  // ── Provisioning is logical: NO Nomba DVA ────────────────────────────────

  it('provisions a bucket with no Nomba call', async () => {
    mockPrisma.treasuryBucket.findUnique.mockResolvedValue(null); // uniqueness check
    mockPrisma.treasuryBucket.create = jest.fn().mockResolvedValue(mockBucket);

    const result = await service.provisionBucket(
      {
        bucketRef: 'ops-bucket',
        name: 'Ops Bucket',
        bucketType: 'OPERATIONS',
      },
      'biz_1',
    );

    expect(result.balanceKobo).toBe(0n);
    // No Nomba method exists on the client mock beyond bankTransfer; assert it stayed untouched.
    expect(mockNombaClient.bankTransfer).not.toHaveBeenCalled();
    expect(mockPrisma.treasuryBucket.create).toHaveBeenCalled();
  });
});
