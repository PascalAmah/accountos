import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RulesService } from './rules.service';

describe('RulesService', () => {
  let service: RulesService;
  let mockPrisma: any;
  let mockAuditService: any;

  const mockAccount = {
    id: 'acc_1',
    accountRef: 'school-fees',
    businessId: 'biz_1',
    executionModel: 'PARALLEL',
    customerId: 'cust_1',
    customer: { kycTier: 'TIER_1' },
  };

  beforeEach(() => {
    mockPrisma = {
      account: {
        findFirst: jest.fn().mockResolvedValue(mockAccount),
        update: jest.fn().mockResolvedValue({
          ...mockAccount,
          rules: [],
        }),
      },
      customer: {
        findUnique: jest.fn().mockResolvedValue({ kycTier: 'TIER_1' }),
      },
      rule: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    mockAuditService = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    service = new RulesService(mockPrisma as any, mockAuditService as any);
  });

  // ── EC-08: Percentage sum > 100 is rejected ──────────────────────────────

  it('rejects PARALLEL release_funds rules with percentage sum > 100 (EC-08)', async () => {
    await expect(
      service.replaceRuleSet('school-fees', 'biz_1', {
        executionModel: 'PARALLEL',
        rules: [
          {
            trigger: 'inflow_received',
            condition: { amount_gte: 1 },
            action: 'release_funds',
            payload: { destinationAccountRef: 'payroll', percentage: 60 },
            priority: 0,
          },
          {
            trigger: 'inflow_received',
            condition: { amount_gte: 1 },
            action: 'release_funds',
            payload: { destinationAccountRef: 'tax', percentage: 25 },
            priority: 1,
          },
          {
            trigger: 'inflow_received',
            condition: { amount_gte: 1 },
            action: 'release_funds',
            payload: { destinationAccountRef: 'savings', percentage: 20 }, // sum = 105
            priority: 2,
          },
        ],
      }),
    ).rejects.toThrow(BadRequestException);

    // Prisma should NOT have been called — rejected before DB write
    expect(mockPrisma.rule.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.account.update).not.toHaveBeenCalled();
  });

  it('rejects PARALLEL release_funds with percentage sum exactly 101 (EC-08 boundary)', async () => {
    await expect(
      service.replaceRuleSet('school-fees', 'biz_1', {
        executionModel: 'PARALLEL',
        rules: [
          {
            trigger: 'inflow_received',
            condition: { amount_gte: 1 },
            action: 'release_funds',
            payload: { destinationAccountRef: 'a', percentage: 51 },
            priority: 0,
          },
          {
            trigger: 'inflow_received',
            condition: { amount_gte: 1 },
            action: 'release_funds',
            payload: { destinationAccountRef: 'b', percentage: 50 },
            priority: 1,
          },
        ],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('accepts PARALLEL release_funds with percentage sum exactly 100 (EC-08 valid boundary)', async () => {
    mockPrisma.account.update.mockResolvedValue({
      ...mockAccount,
      rules: [
        { id: 'r1', trigger: 'INFLOW_RECEIVED', action: 'RELEASE_FUNDS', priority: 0, status: 'ACTIVE', kycTierAtCreation: 'TIER_1', condition: {}, payload: { percentage: 60 } },
        { id: 'r2', trigger: 'INFLOW_RECEIVED', action: 'RELEASE_FUNDS', priority: 1, status: 'ACTIVE', kycTierAtCreation: 'TIER_1', condition: {}, payload: { percentage: 40 } },
      ],
    });

    await expect(
      service.replaceRuleSet('school-fees', 'biz_1', {
        executionModel: 'PARALLEL',
        rules: [
          {
            trigger: 'inflow_received',
            condition: { amount_gte: 1 },
            action: 'release_funds',
            payload: { destinationAccountRef: 'payroll', percentage: 60 },
            priority: 0,
          },
          {
            trigger: 'inflow_received',
            condition: { amount_gte: 1 },
            action: 'release_funds',
            payload: { destinationAccountRef: 'savings', percentage: 40 },
            priority: 1,
          },
        ],
      }),
    ).resolves.toBeDefined();
  });

  it('does not enforce percentage sum for SEQUENTIAL execution model', async () => {
    // SEQUENTIAL with release_funds > 100% total is fine because only
    // the first matching rule fires — they don't compound
    mockPrisma.account.findFirst.mockResolvedValue({
      ...mockAccount,
      executionModel: 'SEQUENTIAL',
    });

    mockPrisma.account.update.mockResolvedValue({
      ...mockAccount,
      executionModel: 'SEQUENTIAL',
      rules: [],
    });

    await expect(
      service.replaceRuleSet('school-fees', 'biz_1', {
        executionModel: 'SEQUENTIAL',
        rules: [
          {
            trigger: 'inflow_received',
            condition: { amount_gte: 1 },
            action: 'release_funds',
            payload: { destinationAccountRef: 'a', percentage: 80 },
            priority: 0,
          },
          {
            trigger: 'inflow_received',
            condition: { amount_gte: 1 },
            action: 'release_funds',
            payload: { destinationAccountRef: 'b', percentage: 80 },
            priority: 1,
          },
        ],
      }),
    ).resolves.toBeDefined();
  });

  it('includes error code PERCENTAGE_SUM_EXCEEDS_100 in the rejection (EC-08)', async () => {
    try {
      await service.replaceRuleSet('school-fees', 'biz_1', {
        executionModel: 'PARALLEL',
        rules: [
          {
            trigger: 'inflow_received',
            condition: { amount_gte: 1 },
            action: 'release_funds',
            payload: { destinationAccountRef: 'a', percentage: 70 },
            priority: 0,
          },
          {
            trigger: 'inflow_received',
            condition: { amount_gte: 1 },
            action: 'release_funds',
            payload: { destinationAccountRef: 'b', percentage: 40 },
            priority: 1,
          },
        ],
      });
      fail('Should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.response?.code).toBe('PERCENTAGE_SUM_EXCEEDS_100');
    }
  });

  // ── Rejects unknown account ──────────────────────────────────────────────

  it('throws NotFoundException for unknown accountRef', async () => {
    mockPrisma.account.findFirst.mockResolvedValue(null);

    await expect(
      service.replaceRuleSet('nonexistent', 'biz_1', {
        executionModel: 'SEQUENTIAL',
        rules: [
          {
            trigger: 'inflow_received',
            condition: { amount_gte: 1 },
            action: 'suspend_account',
            priority: 0,
          },
        ],
      }),
    ).rejects.toThrow(NotFoundException);
  });
});
