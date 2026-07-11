import { WebhookProcessorService } from './webhook.processor';
import { Job } from 'bullmq';

describe('WebhookProcessorService', () => {
  let service: WebhookProcessorService;
  let mockPrisma: any;
  let mockLedgerService: any;
  let mockAuditService: any;
  let mockRuleEngine: any;
  let mockRetryQueue: any;

  const mockPayload = {
    eventId: 'evt_abc123',
    transactionRef: 'txn_xyz456',
    accountNumber: '1234567890',
    amountKobo: 5_000_000, // ₦50,000
    senderName: 'Alice',
    eventType: 'NOMBA_INFLOW',
  };

  const mockAccount = {
    id: 'acc_1',
    accountRef: 'cust-001',
    accountNumber: '1234567890',
    businessId: 'biz_1',
    status: 'ACTIVE',
    executionModel: 'SEQUENTIAL',
    customer: { displayName: 'Alice', kycTier: 'TIER_1' },
  };

  const mockBusiness = {
    id: 'biz_1',
    name: 'TestBiz',
    email: 'biz@test.com',
    webhookUrl: null,
    nombaAccountId: 'nomba_acc',
    nombaSubAccountId: 'nomba_sub',
    nombaClientId: 'client_id',
    nombaClientSecret: 'encrypted_secret',
    nombaWebhookSecret: 'wh_secret',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    mockPrisma = {
      processedEvent: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      account: {
        findUnique: jest.fn().mockResolvedValue(mockAccount),
      },
      ledgerEntry: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'le_1',
          amountKobo: 5_000_000n,
          nombaTransactionRef: 'txn_xyz456',
          nombaEventId: 'evt_abc123',
        }),
      },
      business: {
        findUnique: jest.fn().mockResolvedValue(mockBusiness),
      },
    };

    mockLedgerService = {
      writeInflow: jest.fn().mockResolvedValue(10_000_000n),
      updateReconciliationStatus: jest.fn().mockResolvedValue(undefined),
    };

    mockAuditService = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    mockRuleEngine = {
      evaluate: jest.fn().mockResolvedValue([]),
      execute: jest.fn().mockResolvedValue({ status: 'COMPLETED' }),
    };

    mockRetryQueue = {
      add: jest.fn().mockResolvedValue({ id: 'retry-job-1' }),
    };

    service = new WebhookProcessorService(
      mockPrisma,
      mockLedgerService,
      mockAuditService,
      mockRuleEngine,
      mockRetryQueue,
    );
  });

  // ── Helper to create a mock BullMQ Job ────────────────────────────────────

  function makeJob(data = mockPayload): Job<typeof mockPayload> {
    return { data, id: 'job-1' } as any;
  }

  // ── EC-04: Duplicate event ────────────────────────────────────────────────

  it('discards duplicate events (EC-04)', async () => {
    mockPrisma.processedEvent.findUnique.mockResolvedValue({
      eventId: 'evt_abc123',
    });

    await service.process(makeJob());

    expect(mockAuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DUPLICATE_EVENT_DISCARDED' }),
    );
    // No ledger write, no rule evaluation
    expect(mockLedgerService.writeInflow).not.toHaveBeenCalled();
    expect(mockRuleEngine.evaluate).not.toHaveBeenCalled();
  });

  // ── Unknown account ───────────────────────────────────────────────────────

  it('handles unknown account gracefully', async () => {
    mockPrisma.account.findUnique.mockResolvedValue(null);

    await service.process(makeJob());

    expect(mockAuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'UNKNOWN_ACCOUNT_WEBHOOK' }),
    );
    expect(mockLedgerService.writeInflow).not.toHaveBeenCalled();
    expect(mockRuleEngine.evaluate).not.toHaveBeenCalled();
  });

  // ── SUSPENDED gate ────────────────────────────────────────────────────────

  it('flags inflow for SUSPENDED accounts without evaluating rules', async () => {
    mockPrisma.account.findUnique.mockResolvedValue({
      ...mockAccount,
      status: 'SUSPENDED',
    });

    await service.process(makeJob());

    expect(mockLedgerService.writeInflow).toHaveBeenCalledWith(
      expect.objectContaining({ amountKobo: 5_000_000 }),
      'FLAGGED',
    );
    expect(mockRuleEngine.evaluate).not.toHaveBeenCalled();
  });

  // ── CLOSED account ────────────────────────────────────────────────────────

  it('discards inflow for CLOSED accounts', async () => {
    mockPrisma.account.findUnique.mockResolvedValue({
      ...mockAccount,
      status: 'CLOSED',
    });

    await service.process(makeJob());

    expect(mockLedgerService.writeInflow).not.toHaveBeenCalled();
    expect(mockRuleEngine.evaluate).not.toHaveBeenCalled();
    expect(mockAuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'INFLOW_RECEIVED',
        metadata: expect.objectContaining({ status: 'CLOSED' }),
      }),
    );
  });

  // ── EXPIRED account ───────────────────────────────────────────────────────

  it('discards inflow for EXPIRED accounts', async () => {
    mockPrisma.account.findUnique.mockResolvedValue({
      ...mockAccount,
      status: 'EXPIRED',
    });

    await service.process(makeJob());

    expect(mockLedgerService.writeInflow).not.toHaveBeenCalled();
    expect(mockRuleEngine.evaluate).not.toHaveBeenCalled();
    expect(mockAuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ status: 'EXPIRED' }),
      }),
    );
  });

  // ── Happy path: rules matched ─────────────────────────────────────────────

  it('writes ledger BEFORE evaluating rules, creates ProcessedEvent LAST', async () => {
    const callOrder: string[] = [];

    mockLedgerService.writeInflow.mockImplementation(() => {
      callOrder.push('ledger');
      return Promise.resolve(10_000_000n);
    });

    mockRuleEngine.evaluate.mockImplementation(() => {
      callOrder.push('evaluate');
      return Promise.resolve([
        {
          rule: {
            id: 'r1',
            action: 'SUSPEND_ACCOUNT',
            payload: null,
            priority: 0,
          },
          account: {
            id: mockAccount.id,
            accountRef: mockAccount.accountRef,
            accountNumber: mockAccount.accountNumber,
            nombaAccountId: 'nomba_1',
            businessId: mockAccount.businessId,
          },
        },
      ]);
    });

    mockRuleEngine.execute.mockImplementation(() => {
      callOrder.push('execute');
      return Promise.resolve({ status: 'COMPLETED', ruleExecutionId: 're_1' });
    });

    mockPrisma.processedEvent.create.mockImplementation(() => {
      callOrder.push('processedEvent');
      return Promise.resolve({});
    });

    await service.process(makeJob());

    // Ordering: ledger → evaluate → execute → processedEvent
    expect(callOrder.indexOf('ledger')).toBeLessThan(
      callOrder.indexOf('evaluate'),
    );
    expect(callOrder.indexOf('evaluate')).toBeLessThan(
      callOrder.indexOf('processedEvent'),
    );

    // ProcessedEvent.create IS called
    expect(mockPrisma.processedEvent.create).toHaveBeenCalled();
    // Reconciliation updated to MATCHED
    expect(mockLedgerService.updateReconciliationStatus).toHaveBeenCalledWith(
      'txn_xyz456',
      'MATCHED',
    );
  });

  // ── Happy path: no rules matched ──────────────────────────────────────────

  it('marks UNMATCHED when no rules match', async () => {
    mockRuleEngine.evaluate.mockResolvedValue([]);

    await service.process(makeJob());

    expect(mockLedgerService.updateReconciliationStatus).toHaveBeenCalledWith(
      'txn_xyz456',
      'UNMATCHED',
    );
    expect(mockPrisma.processedEvent.create).toHaveBeenCalled();
  });

  // ── Custom event: no ledger write ─────────────────────────────────────────

  it('skips ledger write for custom events', async () => {
    const customPayload = {
      ...mockPayload,
      eventType: 'delivery_confirmed',
    };

    await service.process(makeJob(customPayload));

    // No ledger entry written for custom events
    expect(mockLedgerService.writeInflow).not.toHaveBeenCalled();
    // But rules ARE evaluated
    expect(mockRuleEngine.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'delivery_confirmed',
        amountKobo: 0n,
      }),
    );
    expect(mockPrisma.processedEvent.create).toHaveBeenCalled();
  });

  // ── Name snapshot captured at processing time ─────────────────────────────

  it('captures customer name snapshot from the database at processing time', async () => {
    mockPrisma.account.findUnique.mockResolvedValue({
      ...mockAccount,
      customer: { displayName: 'Alice Renamed', kycTier: 'TIER_2' },
    });

    await service.process(makeJob());

    expect(mockLedgerService.writeInflow).toHaveBeenCalledWith(
      expect.objectContaining({
        customerNameSnapshot: 'Alice Renamed',
        kycTierAtTime: 'TIER_2',
      }),
      expect.any(String),
    );
  });
});
