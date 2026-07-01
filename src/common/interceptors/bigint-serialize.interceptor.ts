import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';

/**
 * Interceptor that converts BigInt values to strings in JSON responses.
 *
 * Without this, NestJS/Express throws "Do not know how to serialize a BigInt"
 * when a BigInt (e.g. from Prisma _sum aggregates) is included in the response.
 */
@Injectable()
export class BigIntSerializeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next
      .handle()
      .pipe(
        map(
          (data) => JSON.parse(JSON.stringify(data, bigintReplacer)) as unknown,
        ),
      );
  }
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
