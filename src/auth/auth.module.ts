import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthService } from './auth.service';
import { ApiKeyGuard } from './api-key.guard';
import { AuthController } from './auth.controller';

@Module({
  imports: [AuditModule],
  controllers: [AuthController],
  providers: [AuthService, ApiKeyGuard],
  exports: [AuthService, ApiKeyGuard],
})
export class AuthModule {}
