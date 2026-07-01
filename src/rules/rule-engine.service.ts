import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NombaClientService } from '../nomba-client/nomba-client.service';
import { AuditService } from '../audit/audit.service';
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
   * For RELEASE_FUNDS with percentage: compute transferAmount from the
   * ledger entry's amountKobo. Resolve destinationAccountRef to nombaAccountId,
   * call NombaClientService.transferFunds.
   *
   * Returns an ExecutionResult. The caller is responsible for enqueuing
   * retry jobs based on the result status.
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

    // Create a RuleExecution record
    const execution = await this.prisma.ruleExecution.create({
      data: {
        ruleId: rule.id,
        accountId: account.id,
        triggeredBy: ledgerEntry.nombaEventId,
        triggeredByLedgerEntryId: ledgerEntry.id,
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
      case 'FLAG_FOR_REVIEW':
      case 'NOTIFY_WEBHOOK':
      case 'EXPIRE_ACCOUNT':
      case 'REACTIVATE_ACCOUNT': {
        // These are handled by other parts of the system or are no-ops
        // during webhook processing (e.g. reactivate is cyclic reset).
        await this.prisma.ruleExecution.update({
          where: { id: execution.id },
          data: { status: 'COMPLETED', completedAt: new Date() },
        });

        return {
          ruleExecutionId: execution.id,
          status: 'COMPLETED',
        };
      }

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
   * Handle RELEASE_FUNDS action.
   *
   * - If payload contains percentage, compute transferAmount from ledger entry amount.
   * - If payload contains amountKobo, use it directly.
   * - Resolve destinationAccountRef to Nomba account ID (scoped to businessId).
   * - Call NombaClientService.transferFunds.
   */
  private async handleReleaseFunds(
    executionId: string,
    rule: { payload: Prisma.JsonValue },
    account: { id: string; nombaAccountId: string; businessId: string },
    ledgerEntry: {
      id: string;
      amountKobo: bigint;
      nombaTransactionRef: string;
    },
    business: Business,
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

    // Resolve destination account (scoped to businessId)
    const destinationAccount = await this.prisma.account.findFirst({
      where: {
        accountRef: destinationAccountRef,
        businessId: account.businessId,
      },
      select: { nombaAccountId: true },
    });

    if (!destinationAccount) {
      this.logger.warn(
        { ...logMeta, destinationAccountRef },
        'Destination account not found — marking FAILED',
      );
      const errorMsg = `Destination account '${destinationAccountRef}' not found`;
      await this.markExecutionFailed(executionId, errorMsg);
      return {
        ruleExecutionId: executionId,
        status: 'FAILED',
        errorMessage: errorMsg,
      };
    }

    // Compute transfer amount
    let transferAmountKobo: number;
    if (percentage !== undefined) {
      transferAmountKobo = Math.floor(
        (percentage / 100) * Number(ledgerEntry.amountKobo),
      );
    } else if (amountKobo !== undefined) {
      transferAmountKobo = amountKobo;
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

    try {
      const result = await this.nombaClient.transferFunds(business, {
        amount: transferAmountKobo / 100,
        receiverAccountId: destinationAccount.nombaAccountId,
        merchantTxRef: `release_${ledgerEntry.nombaTransactionRef}`,
        narration: `Rule release: ${ledgerEntry.nombaTransactionRef}`,
      });

      await this.prisma.ruleExecution.update({
        where: { id: executionId },
        data: {
          status: 'COMPLETED',
          nombaApiResponse: result as unknown as Prisma.InputJsonValue,
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
          transactionRef: result.transactionRef,
          amountNgn: result.amount,
          fee: result.fee,
          destinationAccountRef,
        },
      });

      this.logger.log(
        {
          ...logMeta,
          transferAmountKobo,
          transactionRef: result.transactionRef,
        },
        'RELEASE_FUNDS completed',
      );

      return {
        ruleExecutionId: executionId,
        status: 'COMPLETED',
        nombaTransactionRef: result.transactionRef,
        amountNgn: result.amount,
      };
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error ? err.message : 'Unknown Nomba transfer error';

      // Mark as RETRYING — the caller will enqueue the retry job
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
        'RELEASE_FUNDS failed — marked RETRYING',
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
