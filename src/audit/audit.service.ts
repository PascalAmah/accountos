import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { requestIdStorage } from '../common/interceptors/request-id.interceptor';
import { AuditLogParams } from './dto/audit-log-params.dto';

@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectPinoLogger(AuditService.name)
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Writes an AuditLogEntry. NEVER throws — any failure is caught, logged via
   * Pino, and silently discarded so the calling operation always succeeds.
   */
  async log(params: AuditLogParams): Promise<void> {
    try {
      // Fall back to AsyncLocalStorage if no requestId was explicitly passed
      const requestId =
        params.requestId ?? requestIdStorage.getStore() ?? undefined;

      await this.prisma.auditLogEntry.create({
        data: {
          accountId: params.accountId ?? null,
          customerId: params.customerId ?? null,
          businessId: params.businessId ?? null,
          actor: params.actor,
          action: params.action,
          beforeState:
            params.beforeState !== undefined
              ? (params.beforeState as Prisma.InputJsonValue)
              : Prisma.JsonNull,
          afterState:
            params.afterState !== undefined
              ? (params.afterState as Prisma.InputJsonValue)
              : Prisma.JsonNull,
          reasonCode: params.reasonCode ?? null,
          metadata:
            params.metadata !== undefined
              ? (params.metadata as Prisma.InputJsonValue)
              : Prisma.JsonNull,
          requestId: requestId ?? null,
        },
      });
    } catch (error: unknown) {
      // Log the failure but never re-throw — callers must always succeed.
      this.logger.error(
        {
          err: error,
          actor: params.actor,
          action: params.action,
          accountId: params.accountId,
          customerId: params.customerId,
          businessId: params.businessId,
        },
        'AuditService.log() failed to write audit entry',
      );
    }
  }
}
