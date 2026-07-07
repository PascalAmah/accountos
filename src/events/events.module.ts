import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { WEBHOOK_PROCESSING_QUEUE } from '../common/queue/queue.constants';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    BullModule.registerQueue({ name: WEBHOOK_PROCESSING_QUEUE }),
  ],
  controllers: [EventsController],
  providers: [EventsService],
})
export class EventsModule {}
