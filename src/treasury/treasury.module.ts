import { Module } from '@nestjs/common';
import { TreasuryController } from './treasury.controller';
import { TreasuryService } from './treasury.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { NombaClientModule } from '../nomba-client/nomba-client.module';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [PrismaModule, AuditModule, NombaClientModule, LedgerModule],
  controllers: [TreasuryController],
  providers: [TreasuryService],
  exports: [TreasuryService],
})
export class TreasuryModule {}
