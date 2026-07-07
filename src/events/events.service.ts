import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { WEBHOOK_PROCESSING_QUEUE } from '../common/queue/queue.constants';
import { ErrorCodes } from '../common/constants/error-codes';
import { AuditAction } from '@prisma/client';

export interface DispatchResult {
  received: true;
}

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    @InjectQueue(WEBHOOK_PROCESSING_QUEUE)
    private readonly webhookQueue: Queue,
  ) {}

  /**
   * Dispatch a custom business event against an account.
   *
   * Flow:
   * 1. Check ProcessedEvent for eventId → duplicate → return 200 (EC-04)
   * 2. Verify accountRef belongs to businessId → 404 ACCOUNT_NOT_FOUND
   * 3. Enqueue to webhook-processing queue with eventType = eventName
   * 4. Return 200 immediately
   *
   * The async WebhookProcessorService handles rule evaluation and execution.
   * For custom events, the accountNumber is included so the worker can
   * resolve the account via its existing accountNumber lookup path.
   */
  async dispatch(
    accountRef: string,
    eventId: string,
    eventName: string,
    businessId: string,
  ): Promise<DispatchResult> {
    // ── Step 1: Idempotency check (EC-04) ──────────────────────────────────
    // Scoped by both eventId AND businessId so the same eventId from two
    // different businesses does not falsely deduplicate each other's events.
    const existing = await this.prisma.processedEvent.findFirst({
      where: { eventId, businessId },
    });

    if (existing) {
      this.logger.warn(
        { eventId, eventName, accountRef },
        'Duplicate custom event discarded (EC-04)',
      );

      await this.auditService.log({
        actor: 'system',
        action: AuditAction.DUPLICATE_EVENT_DISCARDED,
        metadata: { eventId, eventName, accountRef },
        businessId,
      });

      return { received: true };
    }

    // ── Step 2: Account scope check ────────────────────────────────────────
    const account = await this.prisma.account.findFirst({
      where: { accountRef, businessId },
      select: { id: true, accountRef: true, accountNumber: true },
    });

    if (!account) {
      throw new NotFoundException({
        message: `Account '${accountRef}' not found`,
        code: ErrorCodes.ACCOUNT_NOT_FOUND,
      });
    }

    // ── Step 3: Enqueue to webhook-processing ──────────────────────────────
    // Reuse the InflowPayload shape that WebhookProcessorService expects.
    // The worker will skip the LedgerEntry write for custom events
    // because amountKobo is 0 and eventType !== 'NOMBA_INFLOW'.
    // Custom events have no sender or monetary amount — omit optional
    // fields entirely. The WebhookProcessorService skips the ledger write
    // for any event where eventType !== 'NOMBA_INFLOW'.
    await this.webhookQueue.add('process-inflow', {
      eventId,
      transactionRef: eventId,
      accountNumber: account.accountNumber,
      amountKobo: 0,
      eventType: eventName,
    });

    this.logger.log(
      { eventId, eventName, accountRef },
      'Custom event enqueued',
    );

    // ── Step 4: Audit ──────────────────────────────────────────────────────
    await this.auditService.log({
      actor: 'system',
      action: AuditAction.CUSTOM_EVENT_PROCESSED,
      accountId: account.id,
      businessId,
      metadata: {
        eventId,
        eventName,
        accountRef,
      },
    });

    return { received: true };
  }
}
