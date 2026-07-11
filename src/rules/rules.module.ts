import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { NombaClientModule } from '../nomba-client/nomba-client.module';
import { AllocationModule } from '../treasury/allocation.module';
import { NotificationModule } from '../common/notifications/notification.module';
import { RulesController } from './rules.controller';
import { RulesService } from './rules.service';
import { RuleEngineService } from './rule-engine.service';

@Module({
  imports: [
    AuditModule,
    PrismaModule,
    NombaClientModule,
    AllocationModule,
    NotificationModule,
  ],
  controllers: [RulesController],
  providers: [RulesService, RuleEngineService],
  exports: [RuleEngineService],
})
export class RulesModule {}
