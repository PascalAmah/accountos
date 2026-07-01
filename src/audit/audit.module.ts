import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AuditService } from './audit.service';

@Module({
  imports: [LoggerModule],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
