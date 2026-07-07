import { RuleEngineService } from './rule-engine.service';

describe('RuleEngineService', () => {
  let service: RuleEngineService;
  let mockPrisma: any;
  let mockNombaClient: any;
  let mockAuditService: any;

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
      },
    };

    mockNombaClient = {
      transferFunds: jest.fn(),
    };

    mockAuditService = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    service = new RuleEngineService(
      mockPrisma as any,
      mockNombaClient as any,
      mockAuditService as any,
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
});
