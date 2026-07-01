import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { Business as BusinessEntity } from '@prisma/client';

/**
 * Parameter decorator that extracts the authenticated Business record
 * from the request. Only works on routes protected by ApiKeyGuard.
 */
export const Business = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): BusinessEntity => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { business: BusinessEntity }>();
    return request.business;
  },
);
