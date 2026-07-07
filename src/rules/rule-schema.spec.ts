import { validateRuleSet } from '../../rule-schema';

describe('validateRuleSet', () => {
  // ── Valid rule sets ──────────────────────────────────────────────────────

  it('accepts a valid ajo rule set (SEQUENTIAL, inflow_received → suspend + notify)', () => {
    const result = validateRuleSet({
      accountRef: 'ajo-group-04-member-012',
      executionModel: 'SEQUENTIAL',
      rules: [
        {
          trigger: 'inflow_received',
          condition: { amount_gte: 5_000_000 },
          action: 'suspend_account',
          priority: 0,
        },
        {
          trigger: 'inflow_received',
          condition: { cumulative_gte: 60_000_000 },
          action: 'notify_webhook',
          payload: { url: 'https://yourbusiness.com/hooks/pot-complete' },
          priority: 1,
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
  });

  it('accepts a valid escrow rule set (custom_event + time_elapsed → release_funds, flag_for_review)', () => {
    const result = validateRuleSet({
      accountRef: 'order-88213-escrow',
      executionModel: 'SEQUENTIAL',
      rules: [
        {
          trigger: 'custom_event',
          condition: { eventName: 'delivery_confirmed' },
          action: 'release_funds',
          payload: { destinationAccountRef: 'seller-4471' },
          priority: 0,
        },
        {
          trigger: 'custom_event',
          condition: { eventName: 'dispute_raised' },
          action: 'flag_for_review',
          priority: 1,
        },
        {
          trigger: 'time_elapsed',
          condition: { no_event_for_days: 7, eventName: 'dispute_raised' },
          action: 'release_funds',
          payload: { destinationAccountRef: 'seller-4471' },
          priority: 2,
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('accepts a valid treasury split (PARALLEL, 3× release_funds at 60/25/15)', () => {
    const result = validateRuleSet({
      accountRef: 'business-main',
      executionModel: 'PARALLEL',
      rules: [
        {
          trigger: 'inflow_received',
          condition: { amount_gte: 1 },
          action: 'release_funds',
          payload: { destinationAccountRef: 'ops-bucket', percentage: 60 },
          priority: 0,
        },
        {
          trigger: 'inflow_received',
          condition: { amount_gte: 1 },
          action: 'release_funds',
          payload: { destinationAccountRef: 'savings-bucket', percentage: 25 },
          priority: 1,
        },
        {
          trigger: 'inflow_received',
          condition: { amount_gte: 1 },
          action: 'release_funds',
          payload: { destinationAccountRef: 'tax-bucket', percentage: 15 },
          priority: 2,
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  // ── Invalid rule sets ────────────────────────────────────────────────────

  it('accepts PARALLEL release_funds with percentages summing to exactly 100 (valid boundary)', () => {
    const result = validateRuleSet({
      accountRef: 'fully-allocated',
      executionModel: 'PARALLEL',
      rules: [
        {
          trigger: 'inflow_received',
          condition: { amount_gte: 1 },
          action: 'release_funds',
          payload: { destinationAccountRef: 'a', percentage: 60 },
          priority: 0,
        },
        {
          trigger: 'inflow_received',
          condition: { amount_gte: 1 },
          action: 'release_funds',
          payload: { destinationAccountRef: 'b', percentage: 25 },
          priority: 1,
        },
        {
          trigger: 'inflow_received',
          condition: { amount_gte: 1 },
          action: 'release_funds',
          payload: { destinationAccountRef: 'c', percentage: 15 },
          priority: 2,
        },
      ],
    });

    // Each individual rule is structurally valid — schema accepts it.
    // Cross-rule percentage sum enforcement (EC-08) is handled at the
    // service layer (RulesService.enforcePercentageSum) and tested in
    // rules.service.spec.ts.
    expect(result.success).toBe(true);
  });

  it('rejects percentage and amountKobo both set on one release_funds rule', () => {
    const result = validateRuleSet({
      accountRef: 'conflicting-params',
      executionModel: 'SEQUENTIAL',
      rules: [
        {
          trigger: 'inflow_received',
          condition: { amount_gte: 1 },
          action: 'release_funds',
          payload: {
            destinationAccountRef: 'dst',
            percentage: 50,
            amountKobo: 1_000_000,
          },
          priority: 0,
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some((e) => e.includes('mutually exclusive'))).toBe(
      true,
    );
  });

  it('rejects inflow_received condition with zero keys (empty object)', () => {
    const result = validateRuleSet({
      accountRef: 'empty-condition',
      executionModel: 'SEQUENTIAL',
      rules: [
        {
          trigger: 'inflow_received',
          condition: {},
          action: 'suspend_account',
          priority: 0,
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(
      result.errors?.some((e) => e.includes('at least one operator')),
    ).toBe(true);
  });

  it('rejects time_elapsed with no_event_for_days but no eventName', () => {
    const result = validateRuleSet({
      accountRef: 'missing-event-name',
      executionModel: 'SEQUENTIAL',
      rules: [
        {
          trigger: 'time_elapsed',
          condition: { no_event_for_days: 7 },
          action: 'suspend_account',
          priority: 0,
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.errors?.some((e) => e.includes('eventName'))).toBe(true);
  });

  it('rejects time_elapsed with neither no_inflow_for_days nor no_event_for_days', () => {
    const result = validateRuleSet({
      accountRef: 'missing-days',
      executionModel: 'SEQUENTIAL',
      rules: [
        {
          trigger: 'time_elapsed',
          condition: {},
          action: 'suspend_account',
          priority: 0,
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(
      result.errors?.some(
        (e) =>
          e.includes('no_inflow_for_days') || e.includes('no_event_for_days'),
      ),
    ).toBe(true);
  });

  it('rejects unknown trigger string', () => {
    const result = validateRuleSet({
      accountRef: 'bad-trigger',
      executionModel: 'SEQUENTIAL',
      rules: [
        {
          trigger: 'unknown_trigger',
          condition: { amount_gte: 1 },
          action: 'suspend_account',
          priority: 0,
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects empty rules array', () => {
    const result = validateRuleSet({
      accountRef: 'no-rules',
      executionModel: 'SEQUENTIAL',
      rules: [],
    });

    expect(result.success).toBe(false);
    expect(result.errors?.some((e) => e.includes('at least one rule'))).toBe(
      true,
    );
  });

  it('rejects notify_webhook with invalid url (not a URL string)', () => {
    const result = validateRuleSet({
      accountRef: 'missing-webhook-url',
      executionModel: 'SEQUENTIAL',
      rules: [
        {
          trigger: 'inflow_received',
          condition: { amount_gte: 1 },
          action: 'notify_webhook',
          payload: { url: 'not-a-valid-url' },
          priority: 0,
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.errors?.some((e) => e.toLowerCase().includes('url'))).toBe(
      true,
    );
  });

  it('rejects non-integer amount values', () => {
    const result = validateRuleSet({
      accountRef: 'float-amount',
      executionModel: 'SEQUENTIAL',
      rules: [
        {
          trigger: 'inflow_received',
          condition: { amount_gte: 1.5 },
          action: 'suspend_account',
          priority: 0,
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});
