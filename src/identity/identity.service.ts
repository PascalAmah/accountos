import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, KycTier, RuleStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { RenameCustomerDto } from './dto/rename-customer.dto';
import { UpdateKycTierDto } from './dto/update-kyc-tier.dto';
import { UpdateKycTierResult } from './dto/update-kyc-tier-result.dto';
import { ErrorCodes } from '../common/constants/error-codes';

@Injectable()
export class IdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Creates a Customer scoped to businessId and writes the initial NameHistoryEntry
   * with previousName: "" per EC-01.
   *
   * KYC tier is derived from the presence of bvnRef:
   *   - bvnRef provided  → TIER_1 (BVN-linked at registration time)
   *   - bvnRef absent    → TIER_0 (unverified)
   * Callers cannot override this — use updateKycTier() for subsequent upgrades.
   */
  async createCustomer(dto: CreateCustomerDto, businessId: string) {
    const derivedTier = dto.bvnRef ? KycTier.TIER_1 : KycTier.TIER_0;

    const customer = await this.prisma.customer.create({
      data: {
        displayName: dto.displayName,
        kycTier: derivedTier,
        bvnRef: dto.bvnRef ?? null,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        kycVerificationProvider: dto.kycVerificationProvider ?? null,
        kycVerificationRef: dto.kycVerificationRef ?? null,
        parentId: dto.parentId ?? null,
        businessId,
        nameHistory: {
          create: {
            previousName: '',
            newName: dto.displayName,
            changedBy: 'system',
          },
        },
      },
      include: {
        nameHistory: true,
      },
    });

    await this.audit.log({
      customerId: customer.id,
      businessId,
      actor: 'system',
      action: AuditAction.CUSTOMER_CREATED,
      afterState: {
        displayName: customer.displayName,
        kycTier: customer.kycTier,
      },
    });

    return customer;
  }

  /**
   * Renames a customer scoped to businessId (EC-01):
   * 1. Loads customer — 404 if not found or not in this business
   * 2. Appends NameHistoryEntry
   * 3. Updates displayName
   * 4. Writes CUSTOMER_RENAMED audit
   */
  async renameCustomer(
    id: string,
    dto: RenameCustomerDto,
    businessId: string,
    actor: string,
  ) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, businessId },
    });

    if (!customer) {
      throw new NotFoundException({
        code: ErrorCodes.CUSTOMER_NOT_FOUND,
        message: `No customer found with id: ${id}`,
      });
    }

    const previousName = customer.displayName;

    const updated = await this.prisma.customer.update({
      where: { id },
      data: {
        displayName: dto.newName,
        nameHistory: {
          create: {
            previousName,
            newName: dto.newName,
            reason: dto.reason ?? null,
            changedBy: actor,
          },
        },
      },
      include: {
        nameHistory: {
          orderBy: { changedAt: 'asc' },
        },
      },
    });

    await this.audit.log({
      customerId: id,
      businessId,
      actor,
      action: AuditAction.CUSTOMER_RENAMED,
      beforeState: { displayName: previousName },
      afterState: { displayName: dto.newName },
      reasonCode: dto.reason,
    });

    return updated;
  }

  /**
   * Updates the KYC tier of a customer scoped to businessId (EC-03):
   * 1. Loads customer — 404 if not found or not in this business
   * 2. Updates kycTier
   * 3. Queries ACTIVE rules where kycTierAtCreation != newTier
   * 4. Sets each flagged rule to FLAGGED_FOR_REVIEW
   * 5. Writes RULE_FLAGGED_KYC_CHANGE audit per rule
   * 6. Writes KYC_TIER_CHANGED audit
   * 7. Returns { customerId, previousTier, newTier, flaggedRuleIds }
   */
  async updateKycTier(
    id: string,
    dto: UpdateKycTierDto,
    businessId: string,
    actor: string,
  ): Promise<UpdateKycTierResult> {
    const customer = await this.prisma.customer.findFirst({
      where: { id, businessId },
    });

    if (!customer) {
      throw new NotFoundException({
        code: ErrorCodes.CUSTOMER_NOT_FOUND,
        message: `No customer found with id: ${id}`,
      });
    }

    const previousTier = customer.kycTier;
    const newTier = dto.kycTier;

    // Update the customer's KYC tier
    await this.prisma.customer.update({
      where: { id },
      data: {
        kycTier: newTier,
        kycVerificationProvider:
          dto.verificationProvider ?? customer.kycVerificationProvider,
        kycVerificationRef: dto.verificationRef ?? customer.kycVerificationRef,
      },
    });

    // Find all ACTIVE rules on this customer's accounts where kycTierAtCreation != newTier
    const staleRules = await this.prisma.rule.findMany({
      where: {
        status: RuleStatus.ACTIVE,
        kycTierAtCreation: { not: newTier },
        account: {
          customerId: id,
          customer: { businessId },
        },
      },
      select: { id: true, accountId: true },
    });

    const flaggedRuleIds: string[] = [];

    if (staleRules.length > 0) {
      // Bulk-update all stale rules to FLAGGED_FOR_REVIEW
      await this.prisma.rule.updateMany({
        where: { id: { in: staleRules.map((r) => r.id) } },
        data: { status: RuleStatus.FLAGGED_FOR_REVIEW },
      });

      // Write a RULE_FLAGGED_KYC_CHANGE audit entry per rule
      for (const rule of staleRules) {
        flaggedRuleIds.push(rule.id);
        await this.audit.log({
          accountId: rule.accountId,
          customerId: id,
          businessId,
          actor,
          action: AuditAction.RULE_FLAGGED_KYC_CHANGE,
          metadata: {
            ruleId: rule.id,
            previousTier,
            newTier,
          },
          reasonCode: dto.reason,
        });
      }
    }

    // Write KYC_TIER_CHANGED audit
    await this.audit.log({
      customerId: id,
      businessId,
      actor,
      action: AuditAction.KYC_TIER_CHANGED,
      beforeState: { kycTier: previousTier },
      afterState: { kycTier: newTier },
      reasonCode: dto.reason,
      metadata: {
        verificationProvider: dto.verificationProvider ?? null,
        verificationRef: dto.verificationRef ?? null,
        flaggedRuleIds,
      },
    });

    return { customerId: id, previousTier, newTier, flaggedRuleIds };
  }

  /**
   * Lists all customers scoped to businessId with pagination.
   */
  async listCustomers(businessId: string, page = 1, limit = 20) {
    const take = Math.min(limit, 100);
    const skip = (page - 1) * take;

    const [customers, total] = await Promise.all([
      this.prisma.customer.findMany({
        where: { businessId },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        select: {
          id: true,
          displayName: true,
          kycTier: true,
          email: true,
          phone: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { accounts: true } },
        },
      }),
      this.prisma.customer.count({ where: { businessId } }),
    ]);

    return {
      data: customers,
      meta: { total, page, limit: take, pages: Math.ceil(total / take) },
    };
  }

  /**
   * Returns 404 if the customer does not belong to this business.
   */
  async getCustomer(id: string, businessId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, businessId },
      include: {
        nameHistory: {
          orderBy: { changedAt: 'asc' },
        },
        accounts: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!customer) {
      throw new NotFoundException({
        code: ErrorCodes.CUSTOMER_NOT_FOUND,
        message: `No customer found with id: ${id}`,
      });
    }

    return customer;
  }
}
