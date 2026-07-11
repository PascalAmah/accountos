import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { AllocationService } from '../../treasury/allocation.service';
import { NotificationService } from '../notifications/notification.service';
import { AlertService } from '../notifications/alert.service';
import { RETRY_QUEUE } from './queue.constants';

interface RetryPayload {
  ruleExecutionId: string;
  attempt?: number; // legacy; BullMQ's job.attemptsMade is authoritative
  maxAttempts: number;
  errorMessage?: string;
}

/**
 * Outcome of one re-execution attempt.
 * - ok: the action succeeded → mark COMPLETED.
 * - terminal: a non-retryable failure (bad config / missing data) → mark FAILED
 *   immediately, no further retries.
 * - otherwise: a transient failure → retry via BullMQ until maxAttempts.
 */
interface AttemptOutcome {
  ok: boolean;
  terminal?: boolean;
  error?: string;
  /** extra audit metadata on success */
  meta?: Record<string, unknown>;
}

/**
 * Re-executes rule actions (RELEASE_FUNDS allocation, NOTIFY_WEBHOOK delivery)
 * that failed on their first attempt.
 *
 * BACKOFF OWNERSHIP (M5): retry timing is owned ENTIRELY by BullMQ — the job is
 * enqueued with `attempts` + exponential `backoff`, and this processor simply
 * re-throws on a transient failure so BullMQ re-queues with its own delay.
 * `job.attemptsMade` is the single source of truth for the attempt count; the
 * DB `attempt`/`nextRetryAt` fields are written for observability only.
 */
@Injectable()
@Processor(RETRY_QUEUE)
export class RetryProcessorService extends WorkerHost {
  private readonly logger = new Logger(RetryProcessorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly allocationService: AllocationService,
    private readonly notificationService: NotificationService,
    private readonly alertService: AlertService,
  ) {
    super();
  }

  /**
   * Dead-letter queue handler — fires when a job exhausts all BullMQ retry
   * attempts. Moves the payload to an audit entry as dead-letter so it can be
   * inspected later, and raises a critical alert.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<RetryPayload>, error: Error) {
    const { ruleExecutionId, maxAttempts } = job.data;
    // BullMQ calls 'failed' event even on intermediate failures — only treat
    // as dead-letter when attempts are truly exhausted.
    if (job.attemptsMade < maxAttempts) {
      return;
    }

    this.logger.error(
      {
        ruleExecutionId,
        attemptsMade: job.attemptsMade,
        maxAttempts,
        error: error.message,
      },
      'DLQ: job exhausted all retries — writing dead-letter audit entry',
    );

    // Write a dead-letter audit entry for manual inspection
    await this.auditService.log({
      actor: 'system',
      action: AuditAction.RULE_ACTION_FAILED,
      metadata: {
        deadLetter: true,
        ruleExecutionId,
        attemptsMade: job.attemptsMade,
        maxAttempts,
        queueName: RETRY_QUEUE,
        jobId: job.id,
        error: error.message,
      },
    });

    // Raise critical alert
    this.alertService.critical({
      component: 'RetryProcessor.DLQ',
      message: `Rule execution ${ruleExecutionId} exhausted all ${maxAttempts} retry attempts`,
      metadata: {
        ruleExecutionId,
        attemptsMade: job.attemptsMade,
        error: error.message,
      },
    });
  }

  async process(job: Job<RetryPayload>): Promise<void> {
    const { ruleExecutionId, maxAttempts } = job.data;
    // BullMQ increments attemptsMade on each failed attempt; +1 makes this the
    // human-facing 1-based attempt number for the run in progress.
    const currentAttempt = job.attemptsMade + 1;
    const logMeta = { ruleExecutionId, attempt: currentAttempt };

    const execution = await this.prisma.ruleExecution.findUnique({
      where: { id: ruleExecutionId },
      include: {
        rule: { include: { account: { include: { business: true } } } },
        triggeredByLedgerEntry: true,
      },
    });

    if (!execution) {
      this.logger.warn(logMeta, 'RuleExecution not found — skipping retry');
      return;
    }

    // Already resolved elsewhere (e.g. archived on account close) — stop.
    if (['COMPLETED', 'FAILED', 'ARCHIVED'].includes(execution.status)) {
      this.logger.log(
        { ...logMeta, status: execution.status },
        'RuleExecution already resolved — skipping retry',
      );
      return;
    }

    // Perform the action for this attempt.
    let outcome: AttemptOutcome;
    if (execution.rule.action === 'RELEASE_FUNDS') {
      outcome = await this.attemptRelease(execution, currentAttempt);
    } else if (execution.rule.action === 'NOTIFY_WEBHOOK') {
      outcome = await this.attemptNotify(execution, currentAttempt);
    } else {
      // No other action produces retryable work — mark COMPLETED (no-op).
      await this.prisma.ruleExecution.update({
        where: { id: ruleExecutionId },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
      return;
    }

    // ── Success ────────────────────────────────────────────────────────────
    if (outcome.ok) {
      await this.prisma.ruleExecution.update({
        where: { id: ruleExecutionId },
        data: {
          status: 'COMPLETED',
          attempt: currentAttempt,
          completedAt: new Date(),
          nextRetryAt: null,
          errorMessage: null,
        },
      });
      await this.auditService.log({
        actor: 'system',
        action: 'RULE_ACTION_COMPLETED',
        accountId: execution.rule.accountId,
        businessId: execution.rule.account.businessId,
        metadata: {
          ruleExecutionId,
          attempt: currentAttempt,
          ...outcome.meta,
        },
      });
      this.logger.log(logMeta, 'Retry succeeded');
      return;
    }

    // ── Terminal (non-retryable) failure or exhausted attempts → FAILED ─────
    const exhausted = currentAttempt >= maxAttempts;
    if (outcome.terminal || exhausted) {
      await this.prisma.ruleExecution.update({
        where: { id: ruleExecutionId },
        data: {
          status: 'FAILED',
          attempt: currentAttempt,
          errorMessage: outcome.error,
          nextRetryAt: null,
        },
      });
      await this.auditService.log({
        actor: 'system',
        action: 'RULE_ACTION_FAILED',
        accountId: execution.rule.accountId,
        businessId: execution.rule.account.businessId,
        metadata: {
          ruleExecutionId,
          ruleId: execution.ruleId,
          attempt: currentAttempt,
          errorMessage: outcome.error,
          reason: outcome.terminal ? 'non_retryable' : 'max_attempts',
        },
      });
      this.logger.warn(
        { ...logMeta, terminal: !!outcome.terminal },
        'RuleExecution failed — no further retries',
      );
      return;
    }

    // ── Transient failure with attempts left → re-throw for BullMQ backoff ──
    await this.prisma.ruleExecution.update({
      where: { id: ruleExecutionId },
      data: {
        status: 'RETRYING',
        attempt: currentAttempt,
        errorMessage: outcome.error,
      },
    });
    this.logger.warn(
      { ...logMeta, error: outcome.error },
      'Retry attempt failed — re-queueing via BullMQ backoff',
    );
    throw new Error(outcome.error ?? 'Rule action retry failed');
  }

  // ─── RELEASE_FUNDS re-execution ───────────────────────────────────────────

  private async attemptRelease(
    execution: {
      id: string;
      rule: {
        payload: unknown;
        account: { businessId: string };
      };
      triggeredByLedgerEntry: {
        id: string;
        amountKobo: bigint;
        nombaTransactionRef: string;
      } | null;
    },
    attempt: number,
  ): Promise<AttemptOutcome> {
    const rulePayload = (execution.rule.payload ?? {}) as Record<
      string,
      unknown
    >;
    const destinationAccountRef = rulePayload.destinationAccountRef as
      | string
      | undefined;

    if (!destinationAccountRef) {
      return {
        ok: false,
        terminal: true,
        error: 'Missing destinationAccountRef',
      };
    }

    const destinationBucket = await this.prisma.treasuryBucket.findFirst({
      where: {
        bucketRef: destinationAccountRef,
        businessId: execution.rule.account.businessId,
      },
      select: { id: true },
    });
    if (!destinationBucket) {
      return {
        ok: false,
        terminal: true,
        error: `Destination treasury bucket '${destinationAccountRef}' not found`,
      };
    }

    const ledgerEntry = execution.triggeredByLedgerEntry;
    if (!ledgerEntry) {
      return {
        ok: false,
        terminal: true,
        error: 'No ledger entry attached to execution',
      };
    }

    const percentage = rulePayload.percentage as number | undefined;
    const amountKobo = rulePayload.amountKobo as number | undefined;
    let creditAmountKobo: bigint;
    if (percentage !== undefined) {
      creditAmountKobo =
        (BigInt(Math.round(percentage * 100)) * ledgerEntry.amountKobo) /
        10000n;
    } else if (amountKobo !== undefined) {
      creditAmountKobo = BigInt(amountKobo);
    } else {
      return {
        ok: false,
        terminal: true,
        error: 'RELEASE_FUNDS requires percentage or amountKobo',
      };
    }

    try {
      // Idempotent on reference — a partially-applied prior attempt is a no-op.
      const reference = `alloc_${ledgerEntry.nombaTransactionRef}_${destinationBucket.id.slice(0, 8)}`;
      const cumulative = await this.allocationService.credit({
        bucketId: destinationBucket.id,
        businessId: execution.rule.account.businessId,
        amountKobo: creditAmountKobo,
        reference,
        sourceLedgerEntryId: ledgerEntry.id,
        narration: `RELEASE_FUNDS retry ${attempt}: ${ledgerEntry.nombaTransactionRef}`,
      });
      return {
        ok: true,
        meta: {
          reference,
          amountKobo: creditAmountKobo.toString(),
          bucketBalanceKobo: cumulative.toString(),
          destinationAccountRef,
        },
      };
    } catch (err: unknown) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Allocation error',
      };
    }
  }

  // ─── NOTIFY_WEBHOOK re-delivery ───────────────────────────────────────────

  private async attemptNotify(
    execution: {
      id: string;
      triggeredBy: string;
      rule: { payload: unknown; account: { accountRef: string } };
    },
    attempt: number,
  ): Promise<AttemptOutcome> {
    const rulePayload = (execution.rule.payload ?? {}) as Record<
      string,
      unknown
    >;
    const url = rulePayload.url as string | undefined;
    if (!url) {
      return { ok: false, terminal: true, error: 'NOTIFY_WEBHOOK missing url' };
    }

    const result = await this.notificationService.deliver(url, {
      event: 'rule.notify_webhook',
      accountRef: execution.rule.account.accountRef,
      eventId: execution.triggeredBy,
      ruleExecutionId: execution.id,
      attempt,
    });

    if (result.ok) {
      return { ok: true, meta: { url, status: result.status } };
    }
    return { ok: false, error: result.error };
  }
}
