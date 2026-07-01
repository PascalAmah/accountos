import { AuditAction } from '@prisma/client';

export interface AuditLogParams {
  accountId?: string;
  customerId?: string;
  businessId?: string;
  actor: string;
  action: AuditAction;
  beforeState?: Record<string, unknown>;
  afterState?: Record<string, unknown>;
  reasonCode?: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
}
