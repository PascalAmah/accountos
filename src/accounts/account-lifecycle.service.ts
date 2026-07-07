import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  KycTier,
  Prisma,
  RuleAction,
  RuleTrigger,
  AccountStatus,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { NombaClientService } from '../nomba-client/nomba-client.service';
import { LedgerService } from '../ledger/ledger.service';
import { ErrorCodes } from '../common/constants/error-codes';
import { validateRuleSet } from '../../rule-schema';
import { ProvisionAccountDto } from './dto/provision-account.dto';
import { UpdateStatusDto } from './dto/update-status.dto';

@Injectable()
export class AccountLifecycleService {
  private readonly logger = new Logger(AccountLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly nombaClient: NombaClientService,
    private readonly ledgerService: LedgerService,
    private readonly auditService: AuditService,
  ) {}

  // ─── provisionAccount (POST /accounts) ───────────────────────────────────

  /**
   * Provision a new virtual account for a customer or treasury bucket.
   *
   * Flow:
   * 1. Validate the rule set via rule-schema.ts
   * 2. Resolve the customer (skip if TREASURY_BUCKET — no customer linked)
   * 3. Call Nomba to provision the DVA (all account types get a DVA)
   * 4. Create Account + Rules in a single Prisma transaction
   * 5. Write ACCOUNT_PROVISIONED AuditLogEntry
   * 6. Return the account with its rule set
   */
  async provisionAccount(dto: ProvisionAccountDto, businessId: string) {
    // Step 1: Validate the rule set via rule-schema.ts
    const ruleValidation = validateRuleSet({
      accountRef: dto.accountRef,
      executionModel: dto.executionModel ?? 'SEQUENTIAL',
      rules: dto.rules,
    });

    if (!ruleValidation.success) {
      throw new BadRequestException({
        message: 'Invalid rule set',
        code: ErrorCodes.INVALID_RULE_SET,
        errors: ruleValidation.errors,
      });
    }

    // Step 2: Check for duplicate accountRef
    const existing = await this.prisma.account.findUnique({
      where: { accountRef: dto.accountRef },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException({
        message: `Account with ref '${dto.accountRef}' already exists`,
        code: ErrorCodes.DUPLICATE_ACCOUNT_REF,
      });
    }

    // Step 3: Resolve customer (only for customer accounts)
    let customer: {
      id: string;
      kycTier: string;
      bvnRef: string | null;
    } | null = null;

    if (dto.accountType !== 'TREASURY_BUCKET') {
      if (!dto.customerId) {
        throw new BadRequestException({
          message: 'customerId is required for non-treasury accounts',
          code: ErrorCodes.VALIDATION_ERROR,
        });
      }

      customer = await this.prisma.customer.findFirst({
        where: { id: dto.customerId, businessId },
        select: { id: true, kycTier: true, bvnRef: true },
      });

      if (!customer) {
        throw new NotFoundException({
          message: 'Customer not found',
          code: ErrorCodes.CUSTOMER_NOT_FOUND,
        });
      }
    }

    // Step 4: Call Nomba DVA provisioning for ALL account types (treasury buckets are DVAs too)
    let nombaResult: {
      accountRef: string;
      accountNumber: string;
      bankName: string;
      accountName: string;
      bankAccountName: string;
    } | null = null;

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
    });

    if (!business) {
      throw new NotFoundException({
        message: 'Business not found',
        code: ErrorCodes.BUSINESS_NOT_FOUND,
      });
    }

    nombaResult = await this.nombaClient.provisionDva(business, {
      accountRef: dto.accountRef,
      accountName: dto.accountName,
      bvn: customer?.bvnRef ?? undefined,
    });

    // Step 5: Create Account + Rules in transaction
    const account = await this.prisma.account.create({
      data: {
        accountRef: dto.accountRef,
        nombaAccountId: nombaResult.accountRef,
        accountNumber: nombaResult.accountNumber,
        bankName: nombaResult.bankName,
        accountNameAtCreation: dto.accountName,
        executionModel: dto.executionModel ?? 'SEQUENTIAL',
        accountType: dto.accountType ?? 'CUSTOMER_ACCOUNT',
        bucketType: dto.bucketType ?? null,
        description: dto.description ?? null,
        customerId: customer?.id ?? null,
        businessId,
        rules: {
          create: dto.rules.map((r) => ({
            trigger: toRuleTrigger(r.trigger),
            condition: r.condition as Prisma.InputJsonValue,
            action: toRuleAction(r.action),
            payload:
              r.payload !== undefined
                ? (r.payload as Prisma.InputJsonValue)
                : Prisma.JsonNull,
            priority: r.priority ?? 0,
            kycTierAtCreation: (customer?.kycTier ?? KycTier.TIER_1) as KycTier,
          })),
        },
      },
      include: {
        rules: {
          orderBy: { priority: 'asc' },
        },
      },
    });

    // Step 6: Audit
    await this.auditService.log({
      actor: 'system',
      action: AuditAction.ACCOUNT_CREATED,
      accountId: account.id,
      customerId: customer?.id ?? undefined,
      businessId,
      afterState: {
        accountRef: account.accountRef,
        accountType: account.accountType,
        bucketType: account.bucketType,
        executionModel: account.executionModel,
        ruleCount: account.rules.length,
      },
    });

    this.logger.log(
      {
        accountRef: account.accountRef,
        accountType: account.accountType,
        ruleCount: account.rules.length,
      },
      'Account provisioned',
    );

    return account;
  }

  // ─── listAccounts (GET /accounts) ────────────────────────────────────────

  /**
   * Paginated list of accounts for a business, with optional status filter.
   */
  async listAccounts(
    businessId: string,
    filters: { status?: string; page: number; limit: number },
  ) {
    const where: Prisma.AccountWhereInput = { businessId };

    if (filters.status) {
      where.status = filters.status as AccountStatus;
    }

    const [accounts, total] = await Promise.all([
      this.prisma.account.findMany({
        where,
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
        orderBy: { createdAt: 'desc' },
        include: {
          customer: {
            select: { id: true, displayName: true, kycTier: true },
          },
          rules: {
            where: { status: 'ACTIVE' },
            orderBy: { priority: 'asc' },
          },
          _count: {
            select: { ledgerEntries: true },
          },
        },
      }),
      this.prisma.account.count({ where }),
    ]);

    return {
      data: accounts,
      meta: {
        total,
        page: filters.page,
        limit: filters.limit,
        totalPages: Math.ceil(total / filters.limit),
      },
    };
  }

  // ─── getAccountState (GET /accounts/:accountRef/state) ───────────────────

  /**
   * Get the rich state of an account: account data, customer info,
   * active rules, and ledger summary.
   */
  async getAccountState(accountRef: string, businessId: string) {
    const account = await this.prisma.account.findFirst({
      where: { accountRef, businessId },
      include: {
        customer: {
          select: {
            id: true,
            displayName: true,
            email: true,
            phone: true,
            kycTier: true,
          },
        },
        rules: {
          where: { status: 'ACTIVE' },
          orderBy: { priority: 'asc' },
        },
      },
    });

    if (!account) {
      throw new NotFoundException({
        message: 'Account not found',
        code: ErrorCodes.ACCOUNT_NOT_FOUND,
      });
    }

    // Ledger summary
    const ledgerSummary = await this.ledgerService.getSummaryByAccountRef(
      accountRef,
      businessId,
    );

    return {
      ...account,
      ledgerSummary,
    };
  }

  // ─── updateStatus (PATCH /accounts/:accountRef/status) ───────────────────

  /**
   * Manually override an account's status with guard checks.
   *
   * Allowed transitions:
   *   ACTIVE    → SUSPENDED
   *   ACTIVE    → EXPIRED
   *   SUSPENDED → ACTIVE
   *
   * Terminal states (EXPIRED, CLOSED) cannot transition to anything else.
   */
  async updateStatus(
    accountRef: string,
    dto: UpdateStatusDto,
    businessId: string,
    actor: string,
  ) {
    const account = await this.prisma.account.findFirst({
      where: { accountRef, businessId },
    });

    if (!account) {
      throw new NotFoundException({
        message: 'Account not found',
        code: ErrorCodes.ACCOUNT_NOT_FOUND,
      });
    }

    // Guard: CLOSED and EXPIRED are terminal — they cannot be set via PATCH
    // (CLOSED is only reachable via DELETE /accounts/:ref; EXPIRED via Nomba lifecycle)
    if (dto.status === 'CLOSED' || dto.status === 'EXPIRED') {
      throw new BadRequestException({
        message: `Cannot set status to '${dto.status}' via status override — use the account close endpoint instead`,
        code: ErrorCodes.ACCOUNT_TERMINAL_STATE,
      });
    }

    // Guard: already in a terminal state — no further changes allowed
    if (account.status === 'CLOSED' || account.status === 'EXPIRED') {
      throw new BadRequestException({
        message: `Account is in terminal state '${account.status}' — no further status changes allowed`,
        code: ErrorCodes.ACCOUNT_TERMINAL_STATE,
      });
    }

    // Guard: valid transitions matrix (only non-terminal targets allowed here)
    const validTransitions: Record<string, string[]> = {
      ACTIVE: ['SUSPENDED'],
      SUSPENDED: ['ACTIVE'],
    };

    const allowed = validTransitions[account.status] ?? [];
    if (!allowed.includes(dto.status)) {
      throw new BadRequestException({
        message: `Invalid status transition from '${account.status}' to '${dto.status}'`,
        code: ErrorCodes.ACCOUNT_TERMINAL_STATE,
      });
    }

    const beforeState = {
      status: account.status,
    };

    const updated = await this.prisma.account.update({
      where: { id: account.id },
      data: {
        status: dto.status,
      },
    });

    // Audit
    await this.auditService.log({
      actor,
      action: AuditAction.ACCOUNT_STATUS_OVERRIDE,
      accountId: account.id,
      customerId: account.customerId ?? undefined,
      businessId,
      beforeState,
      afterState: { status: updated.status, reason: dto.reason },
      reasonCode: dto.reason,
    });

    this.logger.log(
      {
        accountRef,
        fromStatus: account.status,
        toStatus: dto.status,
        actor,
      },
      'Account status updated',
    );

    return updated;
  }

  // ─── closeAccount (DELETE /accounts/:accountRef) ─────────────────────────

  /**
   * EC-02: Close an account.
   *
   * Steps:
   * 1. Load the account (scoped to business)
   * 2. Assert it is not already CLOSED or in a terminal state
   * 3. Archive all PENDING/RETRYING RuleExecutions (EC-02)
   * 4. Call Nomba to expire the DVA
   * 5. Set status to CLOSED with timestamp and reason
   * 6. Audit
   */
  async closeAccount(
    accountRef: string,
    businessId: string,
    actor: string,
    business: {
      id: string;
      nombaAccountId: string | null;
      nombaSubAccountId: string | null;
      nombaClientId: string | null;
      nombaClientSecret: string | null;
      nombaWebhookSecret: string | null;
      webhookUrl: string | null;
      name: string;
      email: string;
      createdAt: Date;
      updatedAt: Date;
    },
  ) {
    const account = await this.prisma.account.findFirst({
      where: { accountRef, businessId },
    });

    if (!account) {
      throw new NotFoundException({
        message: 'Account not found',
        code: ErrorCodes.ACCOUNT_NOT_FOUND,
      });
    }

    if (account.status === 'CLOSED') {
      throw new BadRequestException({
        message: 'Account is already closed',
        code: ErrorCodes.ACCOUNT_ALREADY_CLOSED,
      });
    }

    if (account.status === 'EXPIRED') {
      throw new BadRequestException({
        message: `Account is in terminal state '${account.status}' — cannot be closed`,
        code: ErrorCodes.ACCOUNT_TERMINAL_STATE,
      });
    }

    // ── EC-02: Archive all PENDING and RETRYING RuleExecutions ────────────
    // Must happen before expiring the DVA so we have a record of what was in-flight.
    const { count: archivedCount } = await this.prisma.ruleExecution.updateMany(
      {
        where: {
          accountId: account.id,
          status: { in: ['PENDING', 'RETRYING'] },
        },
        data: {
          status: 'ARCHIVED',
          archivedReason: 'CLOSED_BEFORE_COMPLETION',
        },
      },
    );

    this.logger.log(
      { accountRef, archivedCount },
      'Archived pending/retrying rule executions (EC-02)',
    );

    // Expire at Nomba (treasury buckets are DVAs too)
    await this.nombaClient.expireAccount(business, account.nombaAccountId);

    const beforeState = {
      status: account.status,
    };

    const updated = await this.prisma.account.update({
      where: { id: account.id },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        closedReason: 'Account closed via API',
      },
    });

    // Audit
    await this.auditService.log({
      actor,
      action: AuditAction.ACCOUNT_CLOSED,
      accountId: account.id,
      customerId: account.customerId ?? undefined,
      businessId,
      beforeState,
      afterState: {
        status: 'CLOSED',
        closedAt: updated.closedAt?.toISOString(),
        archivedExecutionCount: archivedCount,
      },
      reasonCode: 'ACCOUNT_CLOSED',
    });

    this.logger.log(
      {
        accountRef,
        accountType: account.accountType,
        actor,
        archivedCount,
      },
      'Account closed',
    );

    return updated;
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

function toRuleTrigger(trigger: string): RuleTrigger {
  return (TRIGGER_MAP[trigger] ?? trigger) as RuleTrigger;
}

function toRuleAction(action: string): RuleAction {
  return (ACTION_MAP[action] ?? action) as RuleAction;
}
