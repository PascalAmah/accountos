import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { WEBHOOK_PROCESSING_QUEUE } from '../common/queue/queue.constants';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    AuthModule,
    BullModule.registerQueue({ name: WEBHOOK_PROCESSING_QUEUE }),
  ],
  controllers: [WebhooksController],
  providers: [WebhooksService],
  exports: [WebhooksService],
})
export class WebhooksModule {}
