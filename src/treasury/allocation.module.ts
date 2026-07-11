import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { AllocationService } from './allocation.service';

/**
 * Provides the Treasury Allocation Engine to any module that needs to move
 * value between treasury buckets as internal ledger operations (rules engine,
 * retry processor, treasury service). No Nomba dependency by design.
 */
@Module({
  imports: [PrismaModule, AuditModule],
  providers: [AllocationService],
  exports: [AllocationService],
})
export class AllocationModule {}
