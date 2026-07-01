import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { RETRY_QUEUE } from './queue.constants';

interface RetryPayload {
  ruleExecutionId: string;
  attempt: number;
  maxAttempts: number;
  errorMessage?: string;
}

@Injectable()
@Processor(RETRY_QUEUE)
export class RetryProcessorService extends WorkerHost {
  private readonly logger = new Logger(RetryProcessorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
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
      const execution = await this.prisma.ruleExecution.findUnique({
        where: { id: payload.ruleExecutionId },
        include: { rule: { include: { account: true } } },
      });

      if (!execution) {
        this.logger.warn(logMeta, 'RuleExecution not found — skipping retry');
        return;
      }

      // If max attempts reached, mark as FAILED
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

      // Increment attempt counter for next retry
      await this.prisma.ruleExecution.update({
        where: { id: payload.ruleExecutionId },
        data: {
          status: 'RETRYING',
          attempt: payload.attempt,
          errorMessage: payload.errorMessage ?? null,
        },
      });

      this.logger.log(logMeta, 'Retry recorded — will re-attempt on next job');
    } catch (err) {
      this.logger.error({ ...logMeta, err }, 'Retry processing failed');
      throw err;
    }
  }
}
