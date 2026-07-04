import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { NombaClientService } from '../../nomba-client/nomba-client.service';
import { RETRY_QUEUE } from './queue.constants';
import { Prisma } from '@prisma/client';

interface RetryPayload {
  ruleExecutionId: string;
  attempt: number;
  maxAttempts: number;
  errorMessage?: string;
}

/**
 * Exponential backoff delays (milliseconds) for retry attempts 1–5.
 *
 * Attempt 1: 60s  | Attempt 2: 300s | Attempt 3: 900s
 * Attempt 4: 3600s | Attempt 5: 14400s
 */
const BACKOFF_DELAYS_MS = [
  60_000, // 1 min
  300_000, // 5 min
  900_000, // 15 min
  3_600_000, // 1 hr
  14_400_000, // 4 hr
] as const;

@Injectable()
@Processor(RETRY_QUEUE)
export class RetryProcessorService extends WorkerHost {
  private readonly logger = new Logger(RetryProcessorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly nombaClient: NombaClientService,
  ) {
    super();
  }

  async process(job: Job<RetryPayload>): Promise<void> {
    const payload = job.data;
    const logMeta = {
      ruleExecutionId: payload.ruleExecutionId,
      attempt: payload.attempt,
    };

    try {
      // Load execution with full context needed to re-execute the Nomba call
      const execution = await this.prisma.ruleExecution.findUnique({
        where: { id: payload.ruleExecutionId },
        include: {
          rule: {
            include: {
              account: {
                include: {
                  business: true,
                },
              },
            },
          },
          triggeredByLedgerEntry: true,
        },
      });

      if (!execution) {
        this.logger.warn(logMeta, 'RuleExecution not found — skipping retry');
        return;
      }

      // If execution has already been resolved (COMPLETED/FAILED/ARCHIVED), skip
      if (['COMPLETED', 'FAILED', 'ARCHIVED'].includes(execution.status)) {
        this.logger.log(
          { ...logMeta, status: execution.status },
          'RuleExecution already resolved — skipping retry',
        );
        return;
      }

      // ── Max attempts exceeded: mark FAILED ──────────────────────────────
      if (payload.attempt >= payload.maxAttempts) {
        await this.prisma.ruleExecution.update({
          where: { id: payload.ruleExecutionId },
          data: {
            status: 'FAILED',
            errorMessage: payload.errorMessage ?? 'Max retry attempts reached',
          },
        });

        await this.auditService.log({
          actor: 'system',
          action: 'RULE_ACTION_FAILED',
          accountId: execution.rule.accountId,
          businessId: execution.rule.account.businessId,
          metadata: {
            ruleExecutionId: payload.ruleExecutionId,
            ruleId: execution.ruleId,
            attempt: payload.attempt,
            errorMessage: payload.errorMessage,
          },
        });

        this.logger.warn(
          logMeta,
          'RuleExecution failed — max retries exhausted',
        );
        return;
      }

      // ── Re-execute the Nomba transfer ────────────────────────────────────
      if (execution.rule.action !== 'RELEASE_FUNDS') {
        // Only RELEASE_FUNDS produces Nomba API calls that need retry.
        // Other actions are no-ops — mark them COMPLETED.
        await this.prisma.ruleExecution.update({
          where: { id: payload.ruleExecutionId },
          data: { status: 'COMPLETED', completedAt: new Date() },
        });
        return;
      }

      const rulePayload = (execution.rule.payload ?? {}) as Record<
        string,
        unknown
      >;
      const destinationAccountRef = rulePayload.destinationAccountRef as
        | string
        | undefined;

      if (!destinationAccountRef) {
        this.logger.warn(
          logMeta,
          'RELEASE_FUNDS missing destinationAccountRef — marking FAILED',
        );
        await this.prisma.ruleExecution.update({
          where: { id: payload.ruleExecutionId },
          data: {
            status: 'FAILED',
            errorMessage: 'Missing destinationAccountRef',
          },
        });
        return;
      }

      // Resolve destination account (scoped to businessId)
      const destinationAccount = await this.prisma.account.findFirst({
        where: {
          accountRef: destinationAccountRef,
          businessId: execution.rule.account.businessId,
        },
        select: { nombaAccountId: true },
      });

      if (!destinationAccount) {
        const errorMsg = `Destination account '${destinationAccountRef}' not found`;
        this.logger.warn({ ...logMeta, destinationAccountRef }, errorMsg);
        await this.prisma.ruleExecution.update({
          where: { id: payload.ruleExecutionId },
          data: { status: 'FAILED', errorMessage: errorMsg },
        });
        return;
      }

      // Compute transfer amount from the original ledger entry
      const ledgerEntry = execution.triggeredByLedgerEntry;
      if (!ledgerEntry) {
        const errorMsg =
          'No ledger entry attached to execution — cannot determine transfer amount';
        this.logger.warn(logMeta, errorMsg);
        await this.prisma.ruleExecution.update({
          where: { id: payload.ruleExecutionId },
          data: { status: 'FAILED', errorMessage: errorMsg },
        });
        return;
      }

      const percentage = rulePayload.percentage as number | undefined;
      const amountKobo = rulePayload.amountKobo as number | undefined;
      let transferAmountKobo: number;

      if (percentage !== undefined) {
        transferAmountKobo = Math.floor(
          (percentage / 100) * Number(ledgerEntry.amountKobo),
        );
      } else if (amountKobo !== undefined) {
        transferAmountKobo = amountKobo;
      } else {
        const errorMsg = 'RELEASE_FUNDS requires percentage or amountKobo';
        await this.prisma.ruleExecution.update({
          where: { id: payload.ruleExecutionId },
          data: { status: 'FAILED', errorMessage: errorMsg },
        });
        return;
      }

      const business = execution.rule.account.business;
      const currentAttempt = payload.attempt + 1;

      try {
        const result = await this.nombaClient.transferFunds(business, {
          amount: transferAmountKobo / 100,
          receiverAccountId: destinationAccount.nombaAccountId,
          merchantTxRef: `retry_${currentAttempt}_${ledgerEntry.nombaTransactionRef}`,
          narration: `Retry attempt ${currentAttempt}: ${ledgerEntry.nombaTransactionRef}`,
        });

        // ── Success: mark COMPLETED ──────────────────────────────────────
        await this.prisma.ruleExecution.update({
          where: { id: payload.ruleExecutionId },
          data: {
            status: 'COMPLETED',
            attempt: currentAttempt,
            nombaApiResponse: result as unknown as Prisma.InputJsonValue,
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
            ruleExecutionId: payload.ruleExecutionId,
            transactionRef: result.transactionRef,
            amountNgn: result.amount,
            attempt: currentAttempt,
            destinationAccountRef,
          },
        });

        this.logger.log(
          {
            ...logMeta,
            transactionRef: result.transactionRef,
            attempt: currentAttempt,
          },
          'Retry RELEASE_FUNDS succeeded',
        );
      } catch (err: unknown) {
        const errorMessage =
          err instanceof Error ? err.message : 'Nomba transfer error';
        const nextAttempt = currentAttempt;
        const delayMs =
          BACKOFF_DELAYS_MS[
            Math.min(nextAttempt, BACKOFF_DELAYS_MS.length - 1)
          ];

        if (nextAttempt >= payload.maxAttempts) {
          // Exhausted — mark FAILED
          await this.prisma.ruleExecution.update({
            where: { id: payload.ruleExecutionId },
            data: {
              status: 'FAILED',
              attempt: currentAttempt,
              errorMessage,
              nextRetryAt: null,
            },
          });

          await this.auditService.log({
            actor: 'system',
            action: 'RULE_ACTION_FAILED',
            accountId: execution.rule.accountId,
            businessId: execution.rule.account.businessId,
            metadata: {
              ruleExecutionId: payload.ruleExecutionId,
              ruleId: execution.ruleId,
              attempt: currentAttempt,
              errorMessage,
            },
          });

          this.logger.warn(
            { ...logMeta, attempt: currentAttempt },
            'RELEASE_FUNDS failed — max retries exhausted',
          );
        } else {
          // Still have attempts left — keep RETRYING, BullMQ will re-queue
          await this.prisma.ruleExecution.update({
            where: { id: payload.ruleExecutionId },
            data: {
              status: 'RETRYING',
              attempt: currentAttempt,
              errorMessage,
              nextRetryAt: new Date(Date.now() + delayMs),
            },
          });

          this.logger.warn(
            {
              ...logMeta,
              attempt: currentAttempt,
              nextDelayMs: delayMs,
              errorMessage,
            },
            'RELEASE_FUNDS retry attempt failed — will retry again',
          );

          // Re-throw so BullMQ applies its own backoff and re-queues the job
          throw err;
        }
      }
    } catch (err) {
      this.logger.error({ ...logMeta, err }, 'Retry processing failed');
      throw err;
    }
  }
}
