import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { v4 as uuidv4 } from 'uuid';
import { WEBHOOK_PROCESSING_QUEUE } from '../common/queue/queue.constants';

export interface SimulateInflowParams {
  accountNumber: string;
  amountKobo: number;
  senderName?: string;
  senderAccountNumber?: string;
  senderBankCode?: string;
  narration?: string;
}

export interface SimulateInflowResult {
  received: true;
  eventId: string;
  transactionRef: string;
}

@Injectable()
export class DemoService {
  private readonly logger = new Logger(DemoService.name);

  constructor(
    @InjectQueue(WEBHOOK_PROCESSING_QUEUE)
    private readonly webhookQueue: Queue,
  ) {}

  async simulateInflow(
    params: SimulateInflowParams,
  ): Promise<SimulateInflowResult> {
    const eventId = `demo_${uuidv4()}`;
    const transactionRef = `DEMO-TXN-${uuidv4()}`;

    await this.webhookQueue.add('process-inflow', {
      eventId,
      transactionRef,
      accountNumber: params.accountNumber,
      amountKobo: params.amountKobo,
      senderName: params.senderName ?? 'Demo Sender',
      senderAccountNumber: params.senderAccountNumber ?? '0000000000',
      senderBankCode: params.senderBankCode ?? '000',
      narration: params.narration ?? 'Simulated inflow for demo',
      eventType: 'NOMBA_INFLOW',
    });

    this.logger.log(
      { eventId, transactionRef, accountNumber: params.accountNumber },
      'Demo inflow enqueued',
    );

    return { received: true, eventId, transactionRef };
  }
}
