import { Global, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../../audit/audit.module';
import { SchedulerService } from './scheduler.service';

@Global()
@Module({
  imports: [ScheduleModule.forRoot(), PrismaModule, AuditModule],
  providers: [SchedulerService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
