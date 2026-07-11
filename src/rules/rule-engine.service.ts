import { Injectable, Logger } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NombaClientService } from '../nomba-client/nomba-client.service';
import { AuditService } from '../audit/audit.service';
import { AllocationService } from '../treasury/allocation.service';
import { NotificationService } from '../common/notifications/notification.service';
import { Business } from '@prisma/client';

/**
 * The result of executing a rule action.
 * The caller (WebhookProcessorService) uses this to decide whether to enqueue retry jobs.
 */
export interface ExecutionResult {
  ruleExecutionId: string;
  status: 'COMPLETED' | 'FAILED' | 'RETRYING';
  errorMessage?: string;
  attempt?: number;
  nombaTransactionRef?: string;
  amountNgn?: number;
}

/**
 * A matching rule with its full account context.
 * Returned by evaluate() and consumed by execute().
 */
export interface EvaluatedRule {
  rule: {
    id: string;
    action: string;
    payload: Prisma.JsonValue;
    priority: number;
  };
  account: {
    id: string;
    accountRef: string;
    accountNumber: string;
    nombaAccountId: string;
    businessId: string;
  };
}

@Injectable()
export class RuleEngineService {
  private readonly logger = new Logger(RuleEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly nombaClient: NombaClientService,
    private readonly auditService: AuditService,
    private readonly allocationService: AllocationService,
    private readonly notificationService: NotificationService,
  ) {}

  // ─── Task 7.3: evaluate() ───────────────────────────────────────────────

  /**
   * Evaluate rules for a given account and ledger entry.
   *
   * SEQUENTIAL: return the first rule (by priority ASC) whose condition matches.
   * PARALLEL:   return ALL ACTIVE rules whose conditions match.
   *
   * Rules with status ARCHIVED or FLAGGED_FOR_REVIEW are always skipped.
   */
  async evaluate(params: {
    accountId: string;
    executionModel: 'SEQUENTIAL' | 'PARALLEL';
    amountKobo: bigint;
    cumulativeAmountKobo: bigint;
    eventType: string;
    eventName?: string;
  }): Promise<EvaluatedRule[]> {
    const {
      accountId,
      executionModel,
      amountKobo,
      cumulativeAmountKobo,
      eventType,
      eventName,
    } = params;

    // Fetch all ACTIVE rules for this account, ordered by priority
    const rules = await this.prisma.rule.findMany({
      where: {
        accountId,
        status: 'ACTIVE',
      },
      orderBy: { priority: 'asc' },
      include: {
        account: {
          select: {
            id: true,
            accountRef: true,
            accountNumber: true,
            nombaAccountId: true,
            businessId: true,
          },
        },
      },
    });

    const matching: EvaluatedRule[] = [];

    for (const rule of rules) {
      if (
        !this.matches(rule, {
          amountKobo,
          cumulativeAmountKobo,
          eventType,
          eventName,
        })
      ) {
        continue;
      }

      matching.push({
        rule: {
          id: rule.id,
          action: rule.action,
          payload: rule.payload,
          priority: rule.priority,
        },
        account: rule.account,
      });

      // SEQUENTIAL: stop at first match
      if (executionModel === 'SEQUENTIAL') {
        break;
      }
      // PARALLEL: continue to evaluate all rules
    }

    return matching;
  }

  /**
   * Check whether a single rule's condition matches the current event.
   */
  private matches(
    rule: { trigger: string; condition: Prisma.JsonValue },
    event: {
      amountKobo: bigint;
      cumulativeAmountKobo: bigint;
      eventType: string;
      eventName?: string;
    },
  ): boolean {
    const condition = rule.condition as Record<string, unknown> | null;
    if (!condition) return false;

    switch (rule.trigger) {
      case 'INFLOW_RECEIVED': {
        const amt = Number(event.amountKobo);
        const cum = Number(event.cumulativeAmountKobo);

        if (
          condition.amount_gte !== undefined &&
          amt < (condition.amount_gte as number)
        )
          return false;
        if (
          condition.amount_lte !== undefined &&
          amt > (condition.amount_lte as number)
        )
          return false;
        if (
          condition.amount_lt !== undefined &&
          amt >= (condition.amount_lt as number)
        )
          return false;
        if (
          condition.amount_eq !== undefined &&
          amt !== (condition.amount_eq as number)
        )
          return false;
        if (
          condition.cumulative_gte !== undefined &&
          cum < (condition.cumulative_gte as number)
        )
          return false;

        return true;
      }

      case 'CUSTOM_EVENT': {
        if (event.eventType === 'NOMBA_INFLOW') return false;
        const condEventName = condition.eventName as string | undefined;
        if (!condEventName || !event.eventName) return false;
        return condEventName === event.eventName;
      }

      // TIME_ELAPSED and TIER_CHANGED are evaluated by the scheduler,
      // not during webhook processing. We return false for those here.
      case 'TIME_ELAPSED':
      case 'TIER_CHANGED':
        return false;

      default:
        return false;
    }
  }

  // ─── Task 7.4: execute() ────────────────────────────────────────────────

  /**
   * Execute the action for a single matched rule.
   *
   * - RELEASE_FUNDS: allocate to a treasury bucket (internal ledger write).
   * - SUSPEND/EXPIRE/REACTIVATE_ACCOUNT: apply the account status transition.
   * - FLAG_FOR_REVIEW: flag the triggering inflow for manual review.
   * - NOTIFY_WEBHOOK: POST to the configured URL (RETRYING on failure).
   *
   * Returns an ExecutionResult. The caller is responsible for enqueuing
   * retry jobs when the status is RETRYING.
   */
  async execute(
    evaluatedRule: EvaluatedRule,
    ledgerEntry: {
      id: string;
      amountKobo: bigint;
      nombaTransactionRef: string;
      nombaEventId: string;
    },
    business: Business,
  ): Promise<ExecutionResult> {
    const rule = evaluatedRule.rule;
    const account = evaluatedRule.account;
    const logMeta = {
      ruleId: rule.id,
      accountRef: account.accountRef,
      ledgerEntryId: ledgerEntry.id,
    };

    // Custom events pass a pseudo ledger entry (id "custom_<eventId>") that is
    // NOT a persisted LedgerEntry row — never use it as an FK.
    const realLedgerEntryId = ledgerEntry.id.startsWith('custom_')
      ? null
      : ledgerEntry.id;

    // Create a RuleExecution record
    const execution = await this.prisma.ruleExecution.create({
      data: {
        ruleId: rule.id,
        accountId: account.id,
        triggeredBy: ledgerEntry.nombaEventId,
        triggeredByLedgerEntryId: realLedgerEntryId,
        status: 'PENDING',
      },
    });

    switch (rule.action) {
      case 'RELEASE_FUNDS': {
        return this.handleReleaseFunds(
          execution.id,
          rule,
          account,
          ledgerEntry,
          business,
          logMeta,
        );
      }

      case 'SUSPEND_ACCOUNT':
        return this.handleStatusChange(
          execution.id,
          account,
          'SUSPENDED',
          ['ACTIVE'],
          AuditAction.ACCOUNT_SUSPENDED,
          logMeta,
        );

      case 'EXPIRE_ACCOUNT':
        return this.handleStatusChange(
          execution.id,
          account,
          'EXPIRED',
          ['ACTIVE', 'SUSPENDED'],
          AuditAction.ACCOUNT_EXPIRED,
          logMeta,
        );

      case 'REACTIVATE_ACCOUNT':
        return this.handleStatusChange(
          execution.id,
          account,
          'ACTIVE',
          ['SUSPENDED'],
          AuditAction.ACCOUNT_REACTIVATED,
          logMeta,
        );

      case 'FLAG_FOR_REVIEW':
        return this.handleFlagForReview(
          execution.id,
          account,
          realLedgerEntryId,
          logMeta,
        );

      case 'NOTIFY_WEBHOOK':
        return this.handleNotifyWebhook(
          execution.id,
          rule,
          account,
          ledgerEntry,
          logMeta,
        );

      default: {
        this.logger.warn(
          { ...logMeta, action: rule.action },
          'Unknown rule action — marking as COMPLETED (no-op)',
        );
        await this.prisma.ruleExecution.update({
          where: { id: execution.id },
          data: { status: 'COMPLETED', completedAt: new Date() },
        });
        return {
          ruleExecutionId: execution.id,
          status: 'COMPLETED',
        };
      }
    }
  }

  /**
   * Apply an account status transition (SUSPEND / EXPIRE / REACTIVATE).
   *
   * The transition is only applied from an allowed source status; if the
   * account is already in the target (or another) state it is treated as a
   * completed no-op so a duplicate/late trigger never errors.
   */
  private async handleStatusChange(
    executionId: string,
    account: { id: string; accountRef: string; businessId: string },
    target: 'SUSPENDED' | 'EXPIRED' | 'ACTIVE',
    allowedFrom: Array<'ACTIVE' | 'SUSPENDED'>,
    auditAction: AuditAction,
    logMeta: Record<string, unknown>,
  ): Promise<ExecutionResult> {
    const current = await this.prisma.account.findUnique({
      where: { id: account.id },
      select: { status: true },
    });

    if (
      current &&
      allowedFrom.includes(current.status as 'ACTIVE' | 'SUSPENDED')
    ) {
      await this.prisma.account.update({
        where: { id: account.id },
        data: { status: target },
      });

      await this.auditService.log({
        actor: 'system',
        action: auditAction,
        accountId: account.id,
        businessId: account.businessId,
        beforeState: { status: current.status },
        afterState: { status: target },
        reasonCode: 'RULE_ACTION',
      });

      this.logger.log(
        { ...logMeta, from: current.status, to: target },
        `Rule action applied: ${auditAction}`,
      );
    } else {
      this.logger.log(
        { ...logMeta, current: current?.status, target },
        'Status-change rule is a no-op (account not in an allowed source state)',
      );
    }

    await this.prisma.ruleExecution.update({
      where: { id: executionId },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });

    return { ruleExecutionId: executionId, status: 'COMPLETED' };
  }

  /**
   * FLAG_FOR_REVIEW: mark the triggering inflow as FLAGGED (when it exists) and
   * write an audit trail so a human can review it. No external call.
   */
  private async handleFlagForReview(
    executionId: string,
    account: { id: string; businessId: string },
    ledgerEntryId: string | null,
    logMeta: Record<string, unknown>,
  ): Promise<ExecutionResult> {
    if (ledgerEntryId) {
      await this.prisma.ledgerEntry.update({
        where: { id: ledgerEntryId },
        data: { reconciliationStatus: 'FLAGGED' },
      });
    }

    await this.auditService.log({
      actor: 'system',
      action: AuditAction.RULE_ACTION_COMPLETED,
      accountId: account.id,
      businessId: account.businessId,
      reasonCode: 'FLAG_FOR_REVIEW',
      metadata: { ruleExecutionId: executionId, ledgerEntryId },
    });

    await this.prisma.ruleExecution.update({
      where: { id: executionId },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });

    this.logger.log(logMeta, 'Rule action applied: FLAG_FOR_REVIEW');
    return { ruleExecutionId: executionId, status: 'COMPLETED' };
  }

  /**
   * NOTIFY_WEBHOOK: POST the event to the rule's configured URL. On failure,
   * mark RETRYING so the caller enqueues a retry job (same path as RELEASE_FUNDS).
   */
  private async handleNotifyWebhook(
    executionId: string,
    rule: { payload: Prisma.JsonValue },
    account: { id: string; accountRef: string; businessId: string },
    ledgerEntry: { nombaTransactionRef: string; nombaEventId: string },
    logMeta: Record<string, unknown>,
  ): Promise<ExecutionResult> {
    const payload = (rule.payload ?? {}) as Record<string, unknown>;
    const url = payload.url as string | undefined;

    if (!url) {
      await this.markExecutionFailed(executionId, 'NOTIFY_WEBHOOK missing url');
      return {
        ruleExecutionId: executionId,
        status: 'FAILED',
        errorMessage: 'NOTIFY_WEBHOOK missing url',
      };
    }

    const body = {
      event: 'rule.notify_webhook',
      accountRef: account.accountRef,
      transactionRef: ledgerEntry.nombaTransactionRef,
      eventId: ledgerEntry.nombaEventId,
      ruleExecutionId: executionId,
    };

    const result = await this.notificationService.deliver(url, body);

    if (result.ok) {
      await this.prisma.ruleExecution.update({
        where: { id: executionId },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          nombaApiResponse: {
            delivered: true,
            status: result.status,
          },
        },
      });

      await this.auditService.log({
        actor: 'system',
        action: AuditAction.RULE_ACTION_COMPLETED,
        accountId: account.id,
        businessId: account.businessId,
        reasonCode: 'NOTIFY_WEBHOOK',
        metadata: { ruleExecutionId: executionId, url, status: result.status },
      });

      this.logger.log({ ...logMeta, url }, 'NOTIFY_WEBHOOK delivered');
      return { ruleExecutionId: executionId, status: 'COMPLETED' };
    }

    // Delivery failed — mark RETRYING; the caller enqueues the retry job.
    await this.prisma.ruleExecution.update({
      where: { id: executionId },
      data: {
        status: 'RETRYING',
        attempt: 1,
        errorMessage: result.error,
        nextRetryAt: new Date(Date.now() + 60_000),
      },
    });

    this.logger.warn(
      { ...logMeta, url, error: result.error },
      'NOTIFY_WEBHOOK delivery failed — marked RETRYING',
    );
    return {
      ruleExecutionId: executionId,
      status: 'RETRYING',
      errorMessage: result.error,
      attempt: 1,
    };
  }

  /**
   * Handle RELEASE_FUNDS action.
   *
   * RELEASE_FUNDS allocates part of an inflow to a treasury bucket. Per
   * TREASURY_BUILD.md this is a PURELY INTERNAL ledger operation — it never
   * calls Nomba. The money already sits in the business's Nomba account; we
   * only record logical ownership by crediting the destination bucket.
   *
   * - If payload contains percentage, compute the credit from the inflow amount.
   * - If payload contains amountKobo, use it directly (kobo).
   * - Resolve destinationAccountRef to a TreasuryBucket (scoped to businessId).
   */
  private async handleReleaseFunds(
    executionId: string,
    rule: { payload: Prisma.JsonValue },
    account: {
      id: string;
      accountRef: string;
      nombaAccountId: string;
      businessId: string;
    },
    ledgerEntry: {
      id: string;
      amountKobo: bigint;
      nombaTransactionRef: string;
    },
    _business: Business,
    logMeta: Record<string, unknown>,
  ): Promise<ExecutionResult> {
    const payload = (rule.payload ?? {}) as Record<string, unknown>;
    const destinationAccountRef = payload.destinationAccountRef as string;
    const percentage = payload.percentage as number | undefined;
    const amountKobo = payload.amountKobo as number | undefined;

    if (!destinationAccountRef) {
      this.logger.warn(
        logMeta,
        'RELEASE_FUNDS missing destinationAccountRef — marking FAILED',
      );
      await this.markExecutionFailed(
        executionId,
        'Missing destinationAccountRef',
      );
      return {
        ruleExecutionId: executionId,
        status: 'FAILED',
        errorMessage: 'Missing destinationAccountRef',
      };
    }

    // Resolve destination treasury bucket (scoped to businessId)
    const destinationBucket = await this.prisma.treasuryBucket.findFirst({
      where: {
        bucketRef: destinationAccountRef,
        businessId: account.businessId,
      },
      select: { id: true, status: true },
    });

    if (!destinationBucket) {
      this.logger.warn(
        { ...logMeta, destinationAccountRef },
        'Destination treasury bucket not found — marking FAILED',
      );
      const errorMsg = `Destination treasury bucket '${destinationAccountRef}' not found`;
      await this.markExecutionFailed(executionId, errorMsg);
      return {
        ruleExecutionId: executionId,
        status: 'FAILED',
        errorMessage: errorMsg,
      };
    }

    if (destinationBucket.status !== 'ACTIVE') {
      const errorMsg = `Destination treasury bucket '${destinationAccountRef}' is ${destinationBucket.status}`;
      this.logger.warn({ ...logMeta, destinationAccountRef }, errorMsg);
      await this.markExecutionFailed(executionId, errorMsg);
      return {
        ruleExecutionId: executionId,
        status: 'FAILED',
        errorMessage: errorMsg,
      };
    }

    // Compute credit amount in kobo (BigInt — no Naira conversion; no money leaves Nomba)
    let creditAmountKobo: bigint;
    if (percentage !== undefined) {
      creditAmountKobo =
        (BigInt(Math.round(percentage * 100)) * ledgerEntry.amountKobo) /
        10000n;
    } else if (amountKobo !== undefined) {
      creditAmountKobo = BigInt(amountKobo);
    } else {
      this.logger.warn(
        logMeta,
        'RELEASE_FUNDS missing percentage and amountKobo — marking FAILED',
      );
      const errorMsg = 'RELEASE_FUNDS requires percentage or amountKobo';
      await this.markExecutionFailed(executionId, errorMsg);
      return {
        ruleExecutionId: executionId,
        status: 'FAILED',
        errorMessage: errorMsg,
      };
    }

    if (creditAmountKobo <= 0n) {
      // Nothing to allocate (e.g. percentage of a zero-amount event) — complete as no-op.
      await this.prisma.ruleExecution.update({
        where: { id: executionId },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
      return { ruleExecutionId: executionId, status: 'COMPLETED' };
    }

    try {
      // Idempotency key: one allocation per (ledger entry, bucket).
      const reference = `alloc_${ledgerEntry.nombaTransactionRef}_${destinationBucket.id.slice(0, 8)}`;

      const cumulative = await this.allocationService.credit({
        bucketId: destinationBucket.id,
        businessId: account.businessId,
        amountKobo: creditAmountKobo,
        reference,
        sourceLedgerEntryId: ledgerEntry.id,
        narration: `RELEASE_FUNDS allocation from ${account.accountRef}`,
        sourceAccountRef: account.accountRef,
      });

      await this.prisma.ruleExecution.update({
        where: { id: executionId },
        data: {
          status: 'COMPLETED',
          nombaApiResponse: {
            allocated: true,
            bucketRef: destinationAccountRef,
            amountKobo: creditAmountKobo.toString(),
            bucketBalanceKobo: cumulative.toString(),
          },
          completedAt: new Date(),
        },
      });

      await this.auditService.log({
        actor: 'system',
        action: 'RULE_ACTION_COMPLETED',
        accountId: account.id,
        businessId: account.businessId,
        metadata: {
          ruleExecutionId: executionId,
          reference,
          amountKobo: creditAmountKobo.toString(),
          destinationAccountRef,
        },
      });

      this.logger.log(
        {
          ...logMeta,
          creditAmountKobo: creditAmountKobo.toString(),
          destinationAccountRef,
        },
        'RELEASE_FUNDS allocated to treasury bucket (internal)',
      );

      return {
        ruleExecutionId: executionId,
        status: 'COMPLETED',
      };
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error ? err.message : 'Unknown allocation error';

      // Internal allocation failure (e.g. transient DB error) — retryable.
      await this.prisma.ruleExecution.update({
        where: { id: executionId },
        data: {
          status: 'RETRYING',
          attempt: 1,
          errorMessage,
          nextRetryAt: new Date(Date.now() + 60_000),
        },
      });

      this.logger.warn(
        { ...logMeta, errorMessage },
        'RELEASE_FUNDS allocation failed — marked RETRYING',
      );

      return {
        ruleExecutionId: executionId,
        status: 'RETRYING',
        errorMessage,
        attempt: 1,
      };
    }
  }

  private async markExecutionFailed(
    executionId: string,
    errorMessage: string,
  ): Promise<void> {
    await this.prisma.ruleExecution.update({
      where: { id: executionId },
      data: { status: 'FAILED', errorMessage },
    });
  }
}
