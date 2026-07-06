import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DemoController } from './demo.controller';
import { DemoService } from './demo.service';
import { WEBHOOK_PROCESSING_QUEUE } from '../common/queue/queue.constants';

@Module({
  imports: [BullModule.registerQueue({ name: WEBHOOK_PROCESSING_QUEUE })],
  controllers: [DemoController],
  providers: [DemoService],
})
export class DemoModule {}
