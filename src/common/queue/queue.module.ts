import { Global, Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { appConfig } from '../../config/config';
import {
  WEBHOOK_PROCESSING_QUEUE,
  RETRY_QUEUE,
  DEFAULT_JOB_OPTIONS,
} from './queue.constants';
import { WebhookProcessorService } from './webhook.processor';
import { RetryProcessorService } from './retry.processor';
import { PrismaModule } from '../../prisma/prisma.module';
import { LedgerModule } from '../../ledger/ledger.module';
import { AuditModule } from '../../audit/audit.module';
import { RulesModule } from '../../rules/rules.module';
import { NombaClientModule } from '../../nomba-client/nomba-client.module';

@Global()
@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        url: appConfig.REDIS_URL,
      },
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    }),
    BullModule.registerQueue(
      { name: WEBHOOK_PROCESSING_QUEUE },
      { name: RETRY_QUEUE },
    ),
    PrismaModule,
    LedgerModule,
    AuditModule,
    NombaClientModule,
    forwardRef(() => RulesModule),
  ],
  providers: [WebhookProcessorService, RetryProcessorService],
  exports: [BullModule],
})
export class QueueModule {}
