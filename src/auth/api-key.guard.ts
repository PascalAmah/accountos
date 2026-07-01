import type { Request } from 'express';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { ErrorCodes } from '../common/constants/error-codes';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();

    // Skip auth for @Public() routes
    if (Reflect.getMetadata(IS_PUBLIC_KEY, context.getHandler())) return true;

    const rawKey = request.headers['x-api-key'] as string | undefined;
    if (!rawKey) {
      throw new UnauthorizedException({
        message: 'Missing API key',
        code: ErrorCodes.MISSING_API_KEY,
      });
    }

    const apiKey = await this.authService.validateApiKey(rawKey);
    request.business = apiKey.business;
    request.apiKey = apiKey;

    return true;
  }
}
