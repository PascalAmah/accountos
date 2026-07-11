import { RuleEngineService } from './rule-engine.service';

describe('RuleEngineService', () => {
  let service: RuleEngineService;
  let mockPrisma: any;
  let mockNombaClient: any;
  let mockAuditService: any;
  let mockAllocationService: any;
  let mockNotificationService: any;

  const baseRule = {
    id: 'r1',
    trigger: 'INFLOW_RECEIVED',
    condition: { amount_gte: 5_000_000 },
    action: 'SUSPEND_ACCOUNT',
    payload: null,
    priority: 0,
    status: 'ACTIVE',
    account: {
      id: 'acc_1',
      accountRef: 'cust-001',
      accountNumber: '1234567890',
      nombaAccountId: 'nomba_1',
      businessId: 'biz_1',
    },
  };

  beforeEach(() => {
    mockPrisma = {
      rule: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      ruleExecution: {
        create: jest.fn().mockResolvedValue({
          id: 're_1',
          status: 'PENDING',
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      account: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }),
        update: jest.fn().mockResolvedValue({}),
      },
      ledgerEntry: {
        update: jest.fn().mockResolvedValue({}),
      },
      treasuryBucket: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'bucket_1', status: 'ACTIVE' }),
      },
    };

    mockNombaClient = {
      transferFunds: jest.fn(),
      bankTransfer: jest.fn(),
    };

    mockAuditService = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    mockAllocationService = {
      credit: jest.fn().mockResolvedValue(3_000_000n),
      computeBalance: jest.fn(),
    };

    mockNotificationService = {
      deliver: jest.fn().mockResolvedValue({ ok: true, status: 200 }),
    };

    service = new RuleEngineService(
      mockPrisma,
      mockNombaClient,
      mockAuditService,
      mockAllocationService,
      mockNotificationService,
    );
  });

  // ── SEQUENTIAL: returns only first match ──────────────────────────────────

  it('returns only the first matching rule in SEQUENTIAL mode (EC-05)', async () => {
    mockPrisma.rule.findMany.mockResolvedValue([
      {
        ...baseRule,
        id: 'r1',
        priority: 0,
        condition: { amount_gte: 1 },
      },
      {
        ...baseRule,
        id: 'r2',
        priority: 1,
        condition: { amount_gte: 1 },
      },
    ]);

    const results = await service.evaluate({
      accountId: 'acc_1',
      executionModel: 'SEQUENTIAL',
      amountKobo: 5_000_000n,
      cumulativeAmountKobo: 5_000_000n,
      eventType: 'NOMBA_INFLOW',
    });

    expect(results).toHaveLength(1);
    expect(results[0].rule.id).toBe('r1');
  });

  it('falls through to second rule when first does not match (SEQUENTIAL)', async () => {
    mockPrisma.rule.findMany.mockResolvedValue([
      {
        ...baseRule,
        id: 'r1',
        priority: 0,
        condition: { amount_gte: 10_000_000 }, // does NOT match 5_000_000
      },
      {
        ...baseRule,
        id: 'r2',
        priority: 1,
        condition: { amount_gte: 1_000_000 }, // MATCHES
      },
    ]);

    const results = await service.evaluate({
      accountId: 'acc_1',
      executionModel: 'SEQUENTIAL',
      amountKobo: 5_000_000n,
      cumulativeAmountKobo: 5_000_000n,
      eventType: 'NOMBA_INFLOW',
    });

    expect(results).toHaveLength(1);
    expect(results[0].rule.id).toBe('r2');
  });

  // ── PARALLEL: returns all matches ─────────────────────────────────────────

  it('returns all matching rules in PARALLEL mode (EC-05)', async () => {
    mockPrisma.rule.findMany.mockResolvedValue([
      {
        ...baseRule,
        id: 'r1',
        priority: 0,
        condition: { amount_gte: 1 },
      },
      {
        ...baseRule,
        id: 'r2',
        priority: 1,
        condition: { amount_gte: 1 },
      },
    ]);

    const results = await service.evaluate({
      accountId: 'acc_1',
      executionModel: 'PARALLEL',
      amountKobo: 5_000_000n,
      cumulativeAmountKobo: 5_000_000n,
      eventType: 'NOMBA_INFLOW',
    });

    expect(results).toHaveLength(2);
  });

  // ── Condition: amount_gte ─────────────────────────────────────────────────

  it('matches when amount meets amount_gte threshold', async () => {
    mockPrisma.rule.findMany.mockResolvedValue([
      { ...baseRule, condition: { amount_gte: 5_000_000 } },
    ]);

    const results = await service.evaluate({
      accountId: 'acc_1',
      executionModel: 'SEQUENTIAL',
      amountKobo: 5_000_000n,
      cumulativeAmountKobo: 5_000_000n,
      eventType: 'NOMBA_INFLOW',
    });

    expect(results).toHaveLength(1);
  });

  it('does not match when amount is below amount_gte', async () => {
    mockPrisma.rule.findMany.mockResolvedValue([
      { ...baseRule, condition: { amount_gte: 5_000_000 } },
    ]);

    const results = await service.evaluate({
      accountId: 'acc_1',
      executionModel: 'SEQUENTIAL',
      amountKobo: 4_999_999n,
      cumulativeAmountKobo: 4_999_999n,
      eventType: 'NOMBA_INFLOW',
    });

    expect(results).toHaveLength(0);
  });

  // ── Condition: cumulative_gte ─────────────────────────────────────────────

  it('matches when cumulative meets cumulative_gte threshold', async () => {
    mockPrisma.rule.findMany.mockResolvedValue([
      { ...baseRule, condition: { cumulative_gte: 60_000_000 } },
    ]);

    const results = await service.evaluate({
      accountId: 'acc_1',
      executionModel: 'SEQUENTIAL',
      amountKobo: 1_000_000n,
      cumulativeAmountKobo: 60_000_000n,
      eventType: 'NOMBA_INFLOW',
    });

    expect(results).toHaveLength(1);
  });

  it('does not match when cumulative is below cumulative_gte', async () => {
    mockPrisma.rule.findMany.mockResolvedValue([
      { ...baseRule, condition: { cumulative_gte: 60_000_000 } },
    ]);

    const results = await service.evaluate({
      accountId: 'acc_1',
      executionModel: 'SEQUENTIAL',
      amountKobo: 1_000_000n,
      cumulativeAmountKobo: 59_999_999n,
      eventType: 'NOMBA_INFLOW',
    });

    expect(results).toHaveLength(0);
  });

  // ── Custom event matching ─────────────────────────────────────────────────

  it('matches custom event when eventName equals rule condition', async () => {
    mockPrisma.rule.findMany.mockResolvedValue([
      {
        ...baseRule,
        id: 'r_escrow',
        trigger: 'CUSTOM_EVENT',
        condition: { eventName: 'delivery_confirmed' },
        action: 'RELEASE_FUNDS',
      },
    ]);

    const results = await service.evaluate({
      accountId: 'acc_1',
      executionModel: 'SEQUENTIAL',
      amountKobo: 0n,
      cumulativeAmountKobo: 0n,
      eventType: 'CUSTOM_EVENT',
      eventName: 'delivery_confirmed',
    });

    expect(results).toHaveLength(1);
  });

  it('does not match custom event with different eventName', async () => {
    mockPrisma.rule.findMany.mockResolvedValue([
      {
        ...baseRule,
        id: 'r_escrow',
        trigger: 'CUSTOM_EVENT',
        condition: { eventName: 'delivery_confirmed' },
        action: 'RELEASE_FUNDS',
      },
    ]);

    const results = await service.evaluate({
      accountId: 'acc_1',
      executionModel: 'SEQUENTIAL',
      amountKobo: 0n,
      cumulativeAmountKobo: 0n,
      eventType: 'CUSTOM_EVENT',
      eventName: 'dispute_raised',
    });

    expect(results).toHaveLength(0);
  });

  // ── Rule status filtering ─────────────────────────────────────────────────

  it('skips ARCHIVED rules', async () => {
    // ARCHIVED rules are filtered at the database level via where.status: 'ACTIVE'
    // so we test via the mock — findMany is called with ACTIVE filter,
    // and ARCHIVED rules would never be returned
    const results = await service.evaluate({
      accountId: 'acc_1',
      executionModel: 'SEQUENTIAL',
      amountKobo: 5_000_000n,
      cumulativeAmountKobo: 5_000_000n,
      eventType: 'NOMBA_INFLOW',
    });

    // Verify the query filters for ACTIVE only
    expect(mockPrisma.rule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'ACTIVE' }),
      }),
    );
    expect(results).toHaveLength(0);
  });

  // ── TIME_ELAPSED / TIER_CHANGED are never matched during webhook processing

  it('never matches TIME_ELAPSED triggers during webhook processing', async () => {
    mockPrisma.rule.findMany.mockResolvedValue([
      {
        ...baseRule,
        id: 'r_time',
        trigger: 'TIME_ELAPSED',
        condition: { no_inflow_for_days: 7 },
        action: 'SUSPEND_ACCOUNT',
      },
    ]);

    const results = await service.evaluate({
      accountId: 'acc_1',
      executionModel: 'SEQUENTIAL',
      amountKobo: 5_000_000n,
      cumulativeAmountKobo: 5_000_000n,
      eventType: 'NOMBA_INFLOW',
    });

    expect(results).toHaveLength(0);
  });

  it('never matches TIER_CHANGED triggers during webhook processing', async () => {
    mockPrisma.rule.findMany.mockResolvedValue([
      {
        ...baseRule,
        id: 'r_tier',
        trigger: 'TIER_CHANGED',
        condition: { fromTier: 'TIER_1', toTier: 'TIER_2' },
        action: 'FLAG_FOR_REVIEW',
      },
    ]);

    const results = await service.evaluate({
      accountId: 'acc_1',
      executionModel: 'SEQUENTIAL',
      amountKobo: 5_000_000n,
      cumulativeAmountKobo: 5_000_000n,
      eventType: 'NOMBA_INFLOW',
    });

    expect(results).toHaveLength(0);
  });

  // ── Null condition ────────────────────────────────────────────────────────

  it('returns false for rules with null condition', async () => {
    mockPrisma.rule.findMany.mockResolvedValue([
      {
        ...baseRule,
        id: 'r_null',
        condition: null,
      },
    ]);

    const results = await service.evaluate({
      accountId: 'acc_1',
      executionModel: 'SEQUENTIAL',
      amountKobo: 5_000_000n,
      cumulativeAmountKobo: 5_000_000n,
      eventType: 'NOMBA_INFLOW',
    });

    expect(results).toHaveLength(0);
  });

  // ── execute(): RELEASE_FUNDS allocates internally (no Nomba) ───────────────

  const business = { id: 'biz_1', name: 'Biz' } as any;
  const ledgerEntry = {
    id: 'le_1',
    amountKobo: 5_000_000n, // ₦50,000
    nombaTransactionRef: 'txn_1',
    nombaEventId: 'evt_1',
  };

  it('RELEASE_FUNDS credits a treasury bucket in BigInt kobo without any Nomba call', async () => {
    const evaluatedRule = {
      rule: {
        id: 'r_release',
        action: 'RELEASE_FUNDS',
        payload: { destinationAccountRef: 'payroll', percentage: 60 },
        priority: 0,
      },
      account: {
        id: 'acc_1',
        accountRef: 'cust-001',
        accountNumber: '123',
        nombaAccountId: 'nomba_1',
        businessId: 'biz_1',
      },
    };

    const result = await service.execute(evaluatedRule, ledgerEntry, business);

    expect(result.status).toBe('COMPLETED');
    // 60% of 5,000,000 kobo = 3,000,000 kobo (exact BigInt math, no /100)
    expect(mockAllocationService.credit).toHaveBeenCalledWith(
      expect.objectContaining({
        bucketId: 'bucket_1',
        amountKobo: 3_000_000n,
        sourceLedgerEntryId: 'le_1',
      }),
    );
    // No money leaves Nomba during allocation.
    expect(mockNombaClient.transferFunds).not.toHaveBeenCalled();
    expect(mockNombaClient.bankTransfer).not.toHaveBeenCalled();
  });

  it('RELEASE_FUNDS fails when the destination bucket does not exist', async () => {
    mockPrisma.treasuryBucket.findFirst.mockResolvedValue(null);

    const evaluatedRule = {
      rule: {
        id: 'r_release',
        action: 'RELEASE_FUNDS',
        payload: { destinationAccountRef: 'missing', percentage: 50 },
        priority: 0,
      },
      account: {
        id: 'acc_1',
        accountRef: 'cust-001',
        accountNumber: '123',
        nombaAccountId: 'nomba_1',
        businessId: 'biz_1',
      },
    };

    const result = await service.execute(evaluatedRule, ledgerEntry, business);

    expect(result.status).toBe('FAILED');
    expect(mockAllocationService.credit).not.toHaveBeenCalled();
  });

  // ── execute(): wired status + notify actions (C1) ─────────────────────────

  function releaseAccount() {
    return {
      id: 'acc_1',
      accountRef: 'cust-001',
      accountNumber: '123',
      nombaAccountId: 'nomba_1',
      businessId: 'biz_1',
    };
  }

  it('SUSPEND_ACCOUNT sets the account status to SUSPENDED', async () => {
    const evaluatedRule = {
      rule: {
        id: 'r_susp',
        action: 'SUSPEND_ACCOUNT',
        payload: null,
        priority: 0,
      },
      account: releaseAccount(),
    };

    const result = await service.execute(evaluatedRule, ledgerEntry, business);

    expect(result.status).toBe('COMPLETED');
    expect(mockPrisma.account.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'acc_1' },
        data: { status: 'SUSPENDED' },
      }),
    );
    expect(mockAuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ACCOUNT_SUSPENDED' }),
    );
  });

  it('REACTIVATE_ACCOUNT is a no-op when the account is not SUSPENDED', async () => {
    mockPrisma.account.findUnique.mockResolvedValue({ status: 'ACTIVE' });

    const evaluatedRule = {
      rule: {
        id: 'r_react',
        action: 'REACTIVATE_ACCOUNT',
        payload: null,
        priority: 0,
      },
      account: releaseAccount(),
    };

    const result = await service.execute(evaluatedRule, ledgerEntry, business);

    expect(result.status).toBe('COMPLETED');
    expect(mockPrisma.account.update).not.toHaveBeenCalled();
  });

  it('FLAG_FOR_REVIEW flags the triggering ledger entry', async () => {
    const evaluatedRule = {
      rule: {
        id: 'r_flag',
        action: 'FLAG_FOR_REVIEW',
        payload: null,
        priority: 0,
      },
      account: releaseAccount(),
    };

    const result = await service.execute(evaluatedRule, ledgerEntry, business);

    expect(result.status).toBe('COMPLETED');
    expect(mockPrisma.ledgerEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'le_1' },
        data: { reconciliationStatus: 'FLAGGED' },
      }),
    );
  });

  it('NOTIFY_WEBHOOK delivers to the configured url and completes on 2xx', async () => {
    const evaluatedRule = {
      rule: {
        id: 'r_notify',
        action: 'NOTIFY_WEBHOOK',
        payload: { url: 'https://example.test/hook' },
        priority: 0,
      },
      account: releaseAccount(),
    };

    const result = await service.execute(evaluatedRule, ledgerEntry, business);

    expect(result.status).toBe('COMPLETED');
    expect(mockNotificationService.deliver).toHaveBeenCalledWith(
      'https://example.test/hook',
      expect.objectContaining({ accountRef: 'cust-001' }),
    );
  });

  it('NOTIFY_WEBHOOK marks RETRYING when delivery fails', async () => {
    mockNotificationService.deliver.mockResolvedValue({
      ok: false,
      error: 'timeout',
    });

    const evaluatedRule = {
      rule: {
        id: 'r_notify',
        action: 'NOTIFY_WEBHOOK',
        payload: { url: 'https://example.test/hook' },
        priority: 0,
      },
      account: releaseAccount(),
    };

    const result = await service.execute(evaluatedRule, ledgerEntry, business);

    expect(result.status).toBe('RETRYING');
    expect(result.attempt).toBe(1);
  });
});
