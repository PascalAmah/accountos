import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, Prisma, RuleAction, RuleTrigger } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ErrorCodes } from '../common/constants/error-codes';
import { validateRuleSet } from '../../rule-schema';
import { ReplaceRuleSetDto } from './dto/replace-rule-set.dto';

@Injectable()
export class RulesService {
  private readonly logger = new Logger(RulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  // ─── replaceRuleSet (PUT /accounts/:ref/rules) ──────────────────────────

  /**
   * Replace an account's rule set:
   * 1. Validate the account exists and belongs to businessId
   * 2. Archive all current ACTIVE rules (SUPERSEDED_BY_UPDATE)
   * 3. Validate the new rule set via validateRuleSet()
   * 4. Enforce percentage-sum ≤ 100 for PARALLEL RELEASE_FUNDS rules (EC-08)
   * 5. Create new rules with snapshotted kycTierAtCreation
   * 6. Write RULES_UPDATED AuditLogEntry
   *
   * Requirement: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 15.3, 15.4
   */
  async replaceRuleSet(
    accountRef: string,
    businessId: string,
    dto: ReplaceRuleSetDto,
  ) {
    // Step 1: Validate account exists and belongs to business
    const account = await this.prisma.account.findFirst({
      where: { accountRef, businessId },
      include: { customer: { select: { kycTier: true } } },
    });

    if (!account) {
      throw new NotFoundException({
        message: 'Account not found',
        code: ErrorCodes.ACCOUNT_NOT_FOUND,
      });
    }

    // Step 2: Validate the new rule set via rule-schema.ts
    const ruleValidation = validateRuleSet({
      accountRef,
      executionModel: dto.executionModel ?? account.executionModel,
      rules: dto.rules,
    });

    if (!ruleValidation.success) {
      throw new BadRequestException({
        message: 'Invalid rule set',
        code: ErrorCodes.INVALID_RULE_SET,
        errors: ruleValidation.errors,
      });
    }

    // Step 3: Enforce percentage-sum ≤ 100 for PARALLEL RELEASE_FUNDS rules (EC-08)
    const executionModel = dto.executionModel ?? account.executionModel;
    if (executionModel === 'PARALLEL') {
      this.enforcePercentageSum(dto.rules);
    }

    // Step 4: Fetch customer's current kycTier for snapshot
    const customer = await this.prisma.customer.findUnique({
      where: { id: account.customerId ?? '' },
      select: { kycTier: true },
    });
    const kycTierAtCreation = customer?.kycTier ?? 'TIER_0';

    // Step 5: Archive all current ACTIVE rules
    await this.prisma.rule.updateMany({
      where: { accountId: account.id, status: 'ACTIVE' },
      data: {
        status: 'ARCHIVED',
        archivedReason: 'SUPERSEDED_BY_UPDATE',
        archivedAt: new Date(),
      },
    });

    // Step 6: Create new rules
    const updatedAccount = await this.prisma.account.update({
      where: { id: account.id },
      data: {
        executionModel,
        rules: {
          create: dto.rules.map((r) => ({
            trigger: toRuleTrigger(r.trigger) as RuleTrigger,
            condition: r.condition as Prisma.InputJsonValue,
            action: toRuleAction(r.action) as RuleAction,
            payload:
              r.payload !== undefined
                ? (r.payload as Prisma.InputJsonValue)
                : Prisma.JsonNull,
            priority: r.priority ?? 0,
            kycTierAtCreation,
          })),
        },
      },
      include: {
        rules: {
          orderBy: { priority: 'asc' },
        },
      },
    });

    // Step 7: Audit
    await this.auditService.log({
      actor: 'system',
      action: AuditAction.RULES_UPDATED,
      accountId: account.id,
      customerId: account.customerId ?? undefined,
      businessId,
      afterState: {
        accountRef,
        executionModel,
        ruleCount: updatedAccount.rules.length,
      },
    });

    this.logger.log(
      {
        accountRef,
        ruleCount: updatedAccount.rules.length,
        executionModel,
      },
      'Rule set replaced',
    );

    return {
      accountRef: updatedAccount.accountRef,
      executionModel: updatedAccount.executionModel,
      rules: updatedAccount.rules.map((r) => ({
        id: r.id,
        trigger: r.trigger,
        condition: r.condition as Record<string, unknown>,
        action: r.action,
        payload: r.payload as Record<string, unknown> | null,
        priority: r.priority,
        status: r.status,
        kycTierAtCreation: r.kycTierAtCreation,
      })),
    };
  }

  // ─── toggleRule (PATCH /accounts/:ref/rules/:ruleId) ────────────────────

  /**
   * Toggle a rule's enabled/disabled state.
   *
   * enabled: true  → set ACTIVE (only if currently FLAGGED_FOR_REVIEW)
   * enabled: false → set ARCHIVED + MANUALLY_ARCHIVED
   *
   * Requirement: 9.4
   */
  async toggleRule(
    accountRef: string,
    ruleId: string,
    businessId: string,
    enabled: boolean,
  ) {
    const rule = await this.resolveRule(accountRef, ruleId, businessId);

    if (enabled) {
      // Only allow re-enabling from FLAGGED_FOR_REVIEW
      if (rule.status !== 'FLAGGED_FOR_REVIEW') {
        throw new BadRequestException({
          message: `Rule is ${rule.status} — only FLAGGED_FOR_REVIEW rules can be re-enabled`,
          code: ErrorCodes.RULE_CONFLICT,
        });
      }

      await this.prisma.rule.update({
        where: { id: ruleId },
        data: { status: 'ACTIVE' },
      });
    } else {
      await this.prisma.rule.update({
        where: { id: ruleId },
        data: {
          status: 'ARCHIVED',
          archivedReason: 'MANUALLY_ARCHIVED',
          archivedAt: new Date(),
        },
      });

      await this.auditService.log({
        actor: 'system',
        action: AuditAction.RULE_ARCHIVED,
        accountId: rule.accountId,
        businessId,
        metadata: {
          ruleId,
          accountRef,
          archivedReason: 'MANUALLY_ARCHIVED',
        },
      });
    }

    const newStatus = enabled ? 'ACTIVE' : 'ARCHIVED';

    this.logger.log({ accountRef, ruleId, newStatus }, 'Rule status toggled');

    return { ruleId, status: newStatus };
  }

  // ─── deleteRule (DELETE /accounts/:ref/rules/:ruleId) ───────────────────

  /**
   * Archive a rule with MANUALLY_ARCHIVED reason.
   * Unlike toggle (which only disables), delete always archives regardless
   * of current status.
   *
   * Requirement: 9.5
   */
  async deleteRule(accountRef: string, ruleId: string, businessId: string) {
    const rule = await this.resolveRule(accountRef, ruleId, businessId);

    await this.prisma.rule.update({
      where: { id: ruleId },
      data: {
        status: 'ARCHIVED',
        archivedReason: 'MANUALLY_ARCHIVED',
        archivedAt: new Date(),
      },
    });

    await this.auditService.log({
      actor: 'system',
      action: AuditAction.RULE_ARCHIVED,
      accountId: rule.accountId,
      businessId,
      metadata: {
        ruleId,
        accountRef,
        archivedReason: 'MANUALLY_ARCHIVED',
      },
    });

    this.logger.log({ accountRef, ruleId }, 'Rule deleted (archived)');

    return { ruleId, status: 'ARCHIVED' as const };
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Resolve a rule by its ID, verifying it belongs to the account and business.
   * Returns the rule record or throws NotFoundException.
   */
  private async resolveRule(
    accountRef: string,
    ruleId: string,
    businessId: string,
  ) {
    const rule = await this.prisma.rule.findFirst({
      where: {
        id: ruleId,
        account: { accountRef, businessId },
      },
    });

    if (!rule) {
      throw new NotFoundException({
        message: 'Rule not found',
        code: ErrorCodes.RULE_NOT_FOUND,
      });
    }

    return rule;
  }

  /**
   * EC-08: For PARALLEL execution model, enforce that the sum of all
   * RELEASE_FUNDS percentages does not exceed 100.
   *
   * Only applies when using percentage-based release (not amountKobo).
   */
  private enforcePercentageSum(
    rules: Array<{
      action: string;
      payload?: Record<string, unknown>;
    }>,
  ): void {
    let totalPercentage = 0;

    for (const r of rules) {
      if (r.action === 'release_funds' && r.payload?.percentage !== undefined) {
        totalPercentage += r.payload.percentage as number;
      }
    }

    if (totalPercentage > 100) {
      throw new BadRequestException({
        message: `Sum of RELEASE_FUNDS percentages (${totalPercentage}%) exceeds 100%`,
        code: ErrorCodes.PERCENTAGE_SUM_EXCEEDS_100,
      });
    }
  }
}

// ─── Lowercase-to-enum helpers ───────────────────────────────────────────────

const TRIGGER_MAP: Record<string, string> = {
  inflow_received: 'INFLOW_RECEIVED',
  time_elapsed: 'TIME_ELAPSED',
  tier_changed: 'TIER_CHANGED',
  custom_event: 'CUSTOM_EVENT',
};

const ACTION_MAP: Record<string, string> = {
  suspend_account: 'SUSPEND_ACCOUNT',
  reactivate_account: 'REACTIVATE_ACCOUNT',
  expire_account: 'EXPIRE_ACCOUNT',
  flag_for_review: 'FLAG_FOR_REVIEW',
  notify_webhook: 'NOTIFY_WEBHOOK',
  release_funds: 'RELEASE_FUNDS',
};

function toRuleTrigger(value: string): string {
  return TRIGGER_MAP[value] ?? value;
}

function toRuleAction(value: string): string {
  return ACTION_MAP[value] ?? value;
}
