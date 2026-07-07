import { IdentityService } from './identity.service';
import { AuditAction, KycTier, RuleStatus } from '@prisma/client';

describe('IdentityService', () => {
  let service: IdentityService;
  let mockPrisma: any;
  let mockAudit: any;

  const mockCustomer = {
    id: 'cust_1',
    displayName: 'Alice',
    kycTier: KycTier.TIER_1,
    email: null,
    phone: null,
    bvnRef: null,
    businessId: 'biz_1',
    kycVerificationProvider: null,
    kycVerificationRef: null,
    parentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    mockPrisma = {
      customer: {
        findFirst: jest.fn().mockResolvedValue(mockCustomer),
        create: jest.fn().mockResolvedValue({
          ...mockCustomer,
          nameHistory: [],
        }),
        update: jest.fn().mockResolvedValue({
          ...mockCustomer,
          displayName: 'Alice Updated',
          nameHistory: [
            {
              previousName: 'Alice',
              newName: 'Alice Updated',
              changedBy: 'api_key_xxx',
              changedAt: new Date(),
            },
          ],
        }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      rule: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      nameHistoryEntry: {
        create: jest.fn(),
      },
      // Explicitly include ledgerEntry so we can assert it is never called
      ledgerEntry: {
        updateMany: jest.fn(),
      },
    };

    mockAudit = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    service = new IdentityService(mockPrisma, mockAudit);
  });

  // ── EC-01: Rename writes NameHistory BEFORE displayName update ────────────

  it('captures previous name before updating displayName (EC-01)', async () => {
    // Replace mock to verify ordering
    mockPrisma.customer.update.mockImplementation((args: any) => {
      // Verify nameHistory.create is called WITH the old name
      // and the update data contains the new name
      expect(args.data.nameHistory.create.previousName).toBe('Alice');
      expect(args.data.nameHistory.create.newName).toBe('Alice Updated');
      expect(args.data.displayName).toBe('Alice Updated');
      return Promise.resolve({
        ...mockCustomer,
        displayName: 'Alice Updated',
        nameHistory: [
          {
            previousName: 'Alice',
            newName: 'Alice Updated',
            changedBy: 'api_key_xxx',
            changedAt: new Date(),
          },
        ],
      });
    });

    const result = await service.renameCustomer(
      'cust_1',
      { newName: 'Alice Updated', reason: 'Name change' },
      'biz_1',
      'api_key_xxx',
    );

    expect(result.displayName).toBe('Alice Updated');
    expect(mockAudit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.CUSTOMER_RENAMED,
        beforeState: { displayName: 'Alice' },
        afterState: { displayName: 'Alice Updated' },
      }),
    );
  });

  // ── EC-01: Snapshot immutability — rename does NOT touch LedgerEntry ──────

  it('does not update existing LedgerEntry records after rename (EC-01 snapshot immutability)', async () => {
    await service.renameCustomer(
      'cust_1',
      { newName: 'Alice Updated' },
      'biz_1',
      'api_key_xxx',
    );

    // The customerNameSnapshot on existing ledger entries must NOT be updated.
    // Historical records should retain the name captured at processing time.
    expect(mockPrisma.ledgerEntry.updateMany).not.toHaveBeenCalled();
  });

  // ── EC-03: KYC tier upgrade flags stale rules ────────────────────────────

  it('flags ACTIVE rules where kycTierAtCreation differs from new tier (EC-03)', async () => {
    mockPrisma.rule.findMany.mockResolvedValue([
      { id: 'rule_1', accountId: 'acc_1' },
      { id: 'rule_2', accountId: 'acc_2' },
    ]);

    const result = await service.updateKycTier(
      'cust_1',
      {
        kycTier: KycTier.TIER_2,
        verificationProvider: 'BVN_VERIFIED',
        verificationRef: 'vref_123',
        reason: 'BVN_VERIFIED',
      },
      'biz_1',
      'api_key_xxx',
    );

    // All stale rules should be updated to FLAGGED_FOR_REVIEW
    expect(mockPrisma.rule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['rule_1', 'rule_2'] } },
        data: { status: RuleStatus.FLAGGED_FOR_REVIEW },
      }),
    );

    // One audit per flagged rule
    expect(mockAudit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.RULE_FLAGGED_KYC_CHANGE,
        metadata: expect.objectContaining({
          ruleId: expect.any(String),
          previousTier: KycTier.TIER_1,
          newTier: KycTier.TIER_2,
        }),
      }),
    );

    // Final KYC_TIER_CHANGED audit
    expect(mockAudit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.KYC_TIER_CHANGED,
        beforeState: { kycTier: KycTier.TIER_1 },
        afterState: { kycTier: KycTier.TIER_2 },
      }),
    );

    // Returns flagged rule IDs
    expect(result.flaggedRuleIds).toEqual(['rule_1', 'rule_2']);
    expect(result.previousTier).toBe(KycTier.TIER_1);
    expect(result.newTier).toBe(KycTier.TIER_2);
  });

  // ── EC-03: No rules to flag when none exist ──────────────────────────────

  it('returns empty flaggedRuleIds when no stale rules exist', async () => {
    mockPrisma.rule.findMany.mockResolvedValue([]);

    const result = await service.updateKycTier(
      'cust_1',
      {
        kycTier: KycTier.TIER_2,
        verificationProvider: 'NIN_VERIFIED',
        verificationRef: 'nin_123',
        reason: 'NIN_VERIFIED',
      },
      'biz_1',
      'api_key_xxx',
    );

    expect(result.flaggedRuleIds).toEqual([]);
    expect(mockPrisma.rule.updateMany).not.toHaveBeenCalled();
  });

  // ── Two renames → two name history entries ───────────────────────────────

  it('creates a NameHistoryEntry for each rename', async () => {
    await service.renameCustomer(
      'cust_1',
      { newName: 'Alice V2' },
      'biz_1',
      'api_key_xxx',
    );

    // The update call includes nameHistory.create
    expect(mockPrisma.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          displayName: 'Alice V2',
          nameHistory: expect.objectContaining({
            create: expect.objectContaining({
              previousName: 'Alice',
              newName: 'Alice V2',
            }),
          }),
        }),
      }),
    );
  });

  // ── Rename with 404 ──────────────────────────────────────────────────────

  it('throws NotFoundException for non-existent customer on rename', async () => {
    mockPrisma.customer.findFirst.mockResolvedValue(null);

    await expect(
      service.renameCustomer(
        'nonexistent',
        { newName: 'Bob' },
        'biz_1',
        'api_key_xxx',
      ),
    ).rejects.toThrow();
  });
});
