import { Module } from '@nestjs/common';
import { TreasuryController } from './treasury.controller';
import { TreasuryService } from './treasury.service';
import { SettlementService } from './settlement.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { NombaClientModule } from '../nomba-client/nomba-client.module';
import { AllocationModule } from './allocation.module';

@Module({
  imports: [PrismaModule, AuditModule, NombaClientModule, AllocationModule],
  controllers: [TreasuryController],
  providers: [TreasuryService, SettlementService],
  exports: [TreasuryService, SettlementService],
})
export class TreasuryModule {}
