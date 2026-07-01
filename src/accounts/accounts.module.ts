import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { NombaClientModule } from '../nomba-client/nomba-client.module';
import { LedgerModule } from '../ledger/ledger.module';
import { AccountsController } from './accounts.controller';
import { AccountLifecycleService } from './account-lifecycle.service';

@Module({
  imports: [AuditModule, PrismaModule, NombaClientModule, LedgerModule],
  controllers: [AccountsController],
  providers: [AccountLifecycleService],
  exports: [AccountLifecycleService],
})
export class AccountsModule {}
