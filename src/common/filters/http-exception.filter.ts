import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ErrorCodes } from '../constants/error-codes';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: string = ErrorCodes.INTERNAL_ERROR;
    let message = 'An unexpected error occurred';

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const resp = exceptionResponse as Record<string, unknown>;

        // Extract code — use whatever is in the response detail
        // For ValidationPipe errors (400 with no code), use VALIDATION_ERROR
        if (typeof resp['code'] === 'string') {
          code = resp['code'];
        } else if (statusCode === HttpStatus.BAD_REQUEST) {
          code = ErrorCodes.VALIDATION_ERROR;
        } else if (statusCode === HttpStatus.UNAUTHORIZED) {
          code = ErrorCodes.INVALID_API_KEY;
        } else if (statusCode === HttpStatus.NOT_FOUND) {
          code = ErrorCodes.ACCOUNT_NOT_FOUND;
        } else if (statusCode === HttpStatus.CONFLICT) {
          code = ErrorCodes.DUPLICATE_EMAIL;
        } else {
          code = ErrorCodes.INTERNAL_ERROR;
        }

        // Extract message — handle ValidationPipe array messages
        if (Array.isArray(resp['message'])) {
          message = (resp['message'] as string[]).join('; ');
        } else if (typeof resp['message'] === 'string') {
          message = resp['message'];
        } else {
          message = exception.message;
        }
      } else if (typeof exceptionResponse === 'string') {
        code = ErrorCodes.INTERNAL_ERROR;
        message = exceptionResponse;
      } else {
        code = ErrorCodes.INTERNAL_ERROR;
        message = exception.message;
      }
    } else if (exception instanceof Error) {
      statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
      code = ErrorCodes.INTERNAL_ERROR;
      message = exception.message;
      this.logger.error(exception.message, exception.stack);
    } else {
      statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
      code = ErrorCodes.INTERNAL_ERROR;
      message = 'An unexpected error occurred';
      this.logger.error('Unknown exception type', exception);
    }

    // requestId is set by the RequestIdInterceptor on the response header
    const requestId = response.getHeader('x-request-id') as string | undefined;

    response.status(statusCode).json({
      statusCode,
      code,
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
      requestId: requestId ?? null,
    });
  }
}
