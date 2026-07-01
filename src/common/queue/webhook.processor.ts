import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LedgerService } from '../../ledger/ledger.service';
import { AuditService } from '../../audit/audit.service';
import { RuleEngineService } from '../../rules/rule-engine.service';
import { WEBHOOK_PROCESSING_QUEUE, RETRY_QUEUE } from './queue.constants';

interface InflowPayload {
  eventId: string;
  transactionRef: string;
  accountNumber: string;
  amountKobo: number;
  senderName?: string;
  senderAccountNumber?: string;
  senderBankCode?: string;
  narration?: string;
  eventType?: string; // 'NOMBA_INFLOW' | custom event name
}

@Injectable()
@Processor(WEBHOOK_PROCESSING_QUEUE)
export class WebhookProcessorService extends WorkerHost {
  private readonly logger = new Logger(WebhookProcessorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
    private readonly auditService: AuditService,
    private readonly ruleEngine: RuleEngineService,
    @InjectQueue(RETRY_QUEUE) private readonly retryQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<InflowPayload>): Promise<void> {
    const payload = job.data;
    const logMeta = {
      eventId: payload.eventId,
      transactionRef: payload.transactionRef,
    };

    try {
      // ── Step 1: Idempotency check ──────────────────────────────────────
      const existing = await this.prisma.processedEvent.findUnique({
        where: { eventId: payload.eventId },
      });

      if (existing) {
        this.logger.warn({ ...logMeta }, 'Duplicate event discarded');
        await this.auditService.log({
          actor: 'system',
          action: 'DUPLICATE_EVENT_DISCARDED',
          metadata: { eventId: payload.eventId },
        });
        return;
      }

      // ── Step 2: Account lookup ─────────────────────────────────────────
      const account = await this.prisma.account.findFirst({
        where: { accountNumber: payload.accountNumber },
        include: { customer: true },
      });

      if (!account) {
        this.logger.warn(
          { ...logMeta },
          'Unknown account — no account found for accountNumber',
        );
        await this.auditService.log({
          actor: 'system',
          action: 'UNKNOWN_ACCOUNT_WEBHOOK',
          metadata: {
            accountNumber: payload.accountNumber,
            eventId: payload.eventId,
          },
          businessId: undefined,
        });
        return;
      }

      const businessId = account.businessId;
      const isCustomEvent =
        payload.eventType && payload.eventType !== 'NOMBA_INFLOW';

      // ── Step 3: Status check (SUSPENDED gate) ──────────────────────────
      if (account.status === 'SUSPENDED') {
        // Write FLAGGED ledger entry, skip rule evaluation
        await this.ledgerService.writeInflow(
          {
            accountId: account.id,
            nombaTransactionRef: payload.transactionRef,
            nombaEventId: payload.eventId,
            amountKobo: payload.amountKobo,
            senderName: payload.senderName,
            senderAccountNumber: payload.senderAccountNumber,
            senderBankCode: payload.senderBankCode,
            narration: payload.narration,
            customerNameSnapshot: account.customer?.displayName ?? 'Unknown',
            kycTierAtTime: account.customer?.kycTier ?? 'TIER_1',
          },
          'FLAGGED',
        );

        await this.auditService.log({
          actor: 'system',
          action: 'INFLOW_RECEIVED',
          accountId: account.id,
          businessId,
          metadata: {
            eventId: payload.eventId,
            amountKobo: payload.amountKobo,
            reconciliationStatus: 'FLAGGED',
            reason: 'Account is SUSPENDED — rule evaluation skipped',
          },
        });

        this.logger.warn(
          { ...logMeta, accountRef: account.accountRef },
          'Inflow to SUSPENDED account — FLAGGED',
        );
        return;
      }

      // ── Step 4: Handle CLOSED/EXPIRED ──────────────────────────────────
      if (account.status === 'CLOSED' || account.status === 'EXPIRED') {
        this.logger.warn(
          {
            ...logMeta,
            accountRef: account.accountRef,
            status: account.status,
          },
          'Inflow to terminal account — discarded',
        );
        await this.auditService.log({
          actor: 'system',
          action: 'INFLOW_RECEIVED',
          accountId: account.id,
          businessId,
          metadata: {
            eventId: payload.eventId,
            amountKobo: payload.amountKobo,
            status: account.status,
            reason: `Account is ${account.status} — inflow discarded`,
          },
        });
        return;
      }

      // ── Step 5: Write LedgerEntry (PENDING) ────────────────────────────
      const cumulativeAmount = await this.ledgerService.writeInflow(
        {
          accountId: account.id,
          nombaTransactionRef: payload.transactionRef,
          nombaEventId: payload.eventId,
          amountKobo: payload.amountKobo,
          senderName: payload.senderName,
          senderAccountNumber: payload.senderAccountNumber,
          senderBankCode: payload.senderBankCode,
          narration: payload.narration,
          customerNameSnapshot: account.customer?.displayName ?? 'Unknown',
          kycTierAtTime: account.customer?.kycTier ?? 'TIER_1',
        },
        'PENDING',
      );

      this.logger.log(
        {
          ...logMeta,
          accountRef: account.accountRef,
          cumulativeAmount: cumulativeAmount.toString(),
        },
        'Inflow ledger entry written',
      );

      // ── Steps 6–9: Rule evaluation + execution ─────────────────────────
      // Evaluate rules and execute matching ones
      const matchingRules = await this.ruleEngine.evaluate({
        accountId: account.id,
        executionModel: account.executionModel,
        amountKobo: BigInt(payload.amountKobo),
        cumulativeAmountKobo: cumulativeAmount,
        eventType: isCustomEvent
          ? (payload.eventType ?? 'NOMBA_INFLOW')
          : 'NOMBA_INFLOW',
        eventName: isCustomEvent ? payload.eventType : undefined,
      });

      if (matchingRules.length > 0) {
        const business = await this.prisma.business.findUnique({
          where: { id: businessId },
        });

        if (business) {
          const ledgerEntryRecord = await this.prisma.ledgerEntry.findFirst({
            where: { nombaTransactionRef: payload.transactionRef },
          });

          if (ledgerEntryRecord) {
            for (const evaluatedRule of matchingRules) {
              const result = await this.ruleEngine.execute(
                evaluatedRule,
                {
                  id: ledgerEntryRecord.id,
                  amountKobo: ledgerEntryRecord.amountKobo,
                  nombaTransactionRef: ledgerEntryRecord.nombaTransactionRef,
                  nombaEventId: ledgerEntryRecord.nombaEventId,
                },
                business,
              );

              // If RETRYING, enqueue a retry job with exponential backoff
              if (result.status === 'RETRYING' && result.ruleExecutionId) {
                const retryQueue = this.retryQueue;
                if (retryQueue) {
                  await retryQueue.add(
                    'retry-rule-execution',
                    {
                      ruleExecutionId: result.ruleExecutionId,
                      attempt: result.attempt ?? 1,
                      maxAttempts: 5,
                      errorMessage: result.errorMessage,
                    },
                    {
                      delay: 60_000, // 60 seconds first retry
                      attempts: 5,
                      backoff: {
                        type: 'exponential',
                        delay: 60_000,
                      },
                    },
                  );
                }
              }
            }
          }
        }

        // Update reconciliation status to MATCHED
        await this.ledgerService.updateReconciliationStatus(
          payload.transactionRef,
          'MATCHED',
        );

        await this.auditService.log({
          actor: 'system',
          action: 'INFLOW_RECEIVED',
          accountId: account.id,
          businessId,
          metadata: {
            eventId: payload.eventId,
            transactionRef: payload.transactionRef,
            amountKobo: payload.amountKobo,
            reconciliationStatus: 'MATCHED',
            matchedRules: matchingRules.map((r) => ({
              ruleId: r.rule.id,
              action: r.rule.action,
            })),
          },
        });
      } else {
        // No rules matched — mark as UNMATCHED
        await this.ledgerService.updateReconciliationStatus(
          payload.transactionRef,
          'UNMATCHED',
        );

        await this.auditService.log({
          actor: 'system',
          action: 'INFLOW_RECEIVED',
          accountId: account.id,
          businessId,
          metadata: {
            eventId: payload.eventId,
            transactionRef: payload.transactionRef,
            amountKobo: payload.amountKobo,
            reconciliationStatus: 'UNMATCHED',
          },
        });
      }

      // ── Step 10: Write ProcessedEvent (LAST — idempotency guarantee) ───
      await this.prisma.processedEvent.create({
        data: {
          eventId: payload.eventId,
          eventType: isCustomEvent
            ? (payload.eventType ?? 'NOMBA_INFLOW')
            : 'NOMBA_INFLOW',
          accountRef: account.accountRef,
          businessId,
          payload: payload as unknown as Prisma.InputJsonValue,
        },
      });

      this.logger.log(
        { ...logMeta, accountRef: account.accountRef },
        'Inflow processing complete',
      );
    } catch (err) {
      this.logger.error({ ...logMeta, err }, 'Webhook processing failed');
      throw err; // BullMQ will retry based on job options
    }
  }
}
