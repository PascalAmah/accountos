import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { WEBHOOK_PROCESSING_QUEUE } from '../common/queue/queue.constants';
import { ErrorCodes } from '../common/constants/error-codes';

interface NombaInflowPayload {
  eventId: string;
  eventType: string;
  data: {
    transactionRef: string;
    accountNumber: string;
    amount: number;
    currency?: string;
    senderName?: string;
    senderAccountNumber?: string;
    senderBankCode?: string;
    narration?: string;
    createdAt?: string;
  };
}

interface EnqueueInflowParams {
  eventId: string;
  transactionRef: string;
  accountNumber: string;
  amountKobo: number;
  senderName?: string;
  senderAccountNumber?: string;
  senderBankCode?: string;
  narration?: string;
}

export interface WebhookResult {
  received: true;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    @InjectQueue(WEBHOOK_PROCESSING_QUEUE)
    private readonly webhookQueue: Queue,
  ) {}

  async processInflow(
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<WebhookResult> {
    if (!rawBody) {
      throw new BadRequestException({
        message: 'Raw body is required for webhook signature verification',
        code: ErrorCodes.INVALID_WEBHOOK_SIGNATURE,
      });
    }

    let body: NombaInflowPayload;
    try {
      body = JSON.parse(rawBody.toString()) as NombaInflowPayload;
    } catch {
      throw new BadRequestException({
        message: 'Invalid JSON in webhook body',
        code: ErrorCodes.INVALID_WEBHOOK_SIGNATURE,
      });
    }

    const accountNumber = body?.data?.accountNumber;
    if (!accountNumber) {
      throw new BadRequestException({
        message: 'Missing accountNumber in webhook payload',
        code: ErrorCodes.VALIDATION_ERROR,
      });
    }

    const account = await this.prisma.account.findUnique({
      where: { accountNumber },
      include: { customer: { include: { business: true } } },
    });

    if (!account) {
      // Unknown account: we cannot verify the HMAC (no business secret to check
      // against), so we MUST NOT enqueue a job or touch the DB — that would let
      // an unauthenticated caller flood the queue with arbitrary accountNumbers.
      // Log and acknowledge; a genuine misroute is investigated from logs.
      this.logger.warn(
        { accountNumber, eventId: body.eventId },
        'Webhook received for unknown account — discarded (unverifiable)',
      );
      return { received: true };
    }

    const encryptedSecret = account.customer?.business?.nombaWebhookSecret;
    if (!encryptedSecret) {
      throw new UnauthorizedException({
        message: 'Business has no webhook secret configured',
        code: ErrorCodes.INVALID_WEBHOOK_SIGNATURE,
      });
    }

    if (!signature) {
      throw new UnauthorizedException({
        message: 'Missing x-nomba-signature header',
        code: ErrorCodes.INVALID_WEBHOOK_SIGNATURE,
      });
    }

    // The webhook secret is encrypted at rest — Nomba signs with the plaintext,
    // so we must decrypt before computing the expected HMAC.
    const secret = this.authService.decryptWebhookSecret(encryptedSecret);

    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    const expectedBuf = Buffer.from(expected);
    const providedBuf = Buffer.from(signature);

    // timingSafeEqual throws on length mismatch — guard first so a malformed
    // signature yields a clean 401 rather than a 500.
    if (
      expectedBuf.length !== providedBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, providedBuf)
    ) {
      throw new UnauthorizedException({
        message: 'HMAC signature mismatch',
        code: ErrorCodes.INVALID_WEBHOOK_SIGNATURE,
      });
    }

    await this.enqueueInflow({
      eventId: body.eventId,
      transactionRef: body.data.transactionRef,
      accountNumber: body.data.accountNumber,
      amountKobo: body.data.amount,
      senderName: body.data.senderName,
      senderAccountNumber: body.data.senderAccountNumber,
      senderBankCode: body.data.senderBankCode,
      narration: body.data.narration,
    });

    this.logger.log(
      {
        eventId: body.eventId,
        transactionRef: body.data.transactionRef,
        accountNumber,
        businessId: account.businessId,
      },
      'Nomba webhook verified and enqueued',
    );

    return { received: true };
  }

  private async enqueueInflow(params: EnqueueInflowParams): Promise<void> {
    await this.webhookQueue.add('process-inflow', {
      eventId: params.eventId,
      transactionRef: params.transactionRef,
      accountNumber: params.accountNumber,
      amountKobo: params.amountKobo,
      senderName: params.senderName,
      senderAccountNumber: params.senderAccountNumber,
      senderBankCode: params.senderBankCode,
      narration: params.narration,
      eventType: 'NOMBA_INFLOW',
    });
  }
}
