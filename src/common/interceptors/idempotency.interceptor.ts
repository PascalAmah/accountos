import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { PrismaService } from '../../prisma/prisma.service';
import { ErrorCodes } from '../../common/constants/error-codes';
import { Request } from 'express';

/**
 * IdempotencyInterceptor — ensures mutating POST requests with an
 * `Idempotency-Key` header are safely replayable.
 *
 * First request: stores the key → (status, body) on success.
 * Retry (same key + matching body): replays the stored response.
 * Retry (same key + different body): 409 Conflict.
 *
 * Applied to POST /treasury-buckets, /:ref/withdraw, /:ref/transfer, /accounts.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  /** Paths (prefix matches) that the interceptor applies to */
  private static readonly MUTATING_PATHS = [
    '/api/v1/treasury-buckets',
    '/api/v1/accounts',
  ];

  constructor(private readonly prisma: PrismaService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<Request>();
    const method = request.method?.toUpperCase();

    // Only apply to POST (and PUT/PATCH if needed)
    if (method !== 'POST') {
      return next.handle();
    }

    const idempotencyKey = request.headers['idempotency-key'] as
      | string
      | undefined;
    if (!idempotencyKey) {
      return next.handle();
    }

    const path = this.normalizePath(request.path);
    const requestHash = createHash('sha256')
      .update(JSON.stringify(request.body ?? {}))
      .digest('hex');

    const businessId = (request as Request & { business?: { id?: string } })
      .business?.id;
    if (!businessId) {
      // No business context yet (e.g. auth hasn't run) — skip
      return next.handle();
    }

    // Check for existing idempotency key
    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { businessId_key: { businessId, key: idempotencyKey } },
    });

    if (existing) {
      // Replay: same body → return stored response
      if (existing.requestHash === requestHash) {
        this.logger.log(
          { key: idempotencyKey, path },
          'Idempotency replay — returning stored response',
        );
        return of(existing.responseBody);
      }

      // Mismatched body: 409
      throw new ConflictException({
        message: 'Idempotency-Key already used with a different request body',
        code: ErrorCodes.IDEMPOTENCY_KEY_CONFLICT,
      });
    }

    // First request: store result on success
    return next.handle().pipe(
      tap({
        next: (body: unknown) => {
          // Fire-and-forget — don't block the response
          this.prisma.idempotencyKey
            .create({
              data: {
                key: idempotencyKey,
                businessId,
                method,
                path,
                requestHash,
                responseStatus: context
                  .switchToHttp()
                  .getResponse<{ statusCode: number }>().statusCode,
                responseBody: body as object,
              },
            })
            .catch((err: unknown) =>
              this.logger.warn(
                { key: idempotencyKey, error: String(err) },
                'Failed to persist idempotency key',
              ),
            );
        },
      }),
    );
  }

  /** Normalize path — strip query params and trailing slashes */
  private normalizePath(path: string): string {
    const withoutQuery = path.split('?')[0];
    return withoutQuery.replace(/\/$/, '') || '/';
  }
}
