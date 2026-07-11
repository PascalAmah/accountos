import {
  Controller,
  Post,
  HttpCode,
  Body,
  Headers,
  UnauthorizedException,
  ForbiddenException,
  UsePipes,
  ValidationPipe,
  All,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiSecurity,
} from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { appConfig } from '../config/config';
import { timingSafeCompare } from '../common/utils/crypto.utils';
import { ErrorCodes } from '../common/constants/error-codes';
import { DemoService } from './demo.service';
import { SimulateInflowDto } from './dto/simulate-inflow.dto';

@ApiTags('demo')
@ApiSecurity('api-key')
@Controller('demo')
export class DemoController {
  constructor(private readonly demoService: DemoService) {}

  @Public()
  @Post('simulate-inflow')
  @HttpCode(200)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  @ApiOperation({
    summary: 'Simulate a Nomba inflow webhook (local dev only)',
    description:
      'Creates a synthetic inflow event that flows through the identical async ' +
      'pipeline as a real Nomba webhook.',
  })
  @ApiResponse({ status: 200, description: 'Inflow simulated and enqueued' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Invalid admin secret' })
  @ApiResponse({ status: 403, description: 'DEMO_MODE_ONLY' })
  async simulateInflow(
    @Body() dto: SimulateInflowDto,
    @Headers('x-admin-secret') adminSecret?: string,
  ) {
    if (!appConfig.DEMO_MODE_ENABLED) {
      throw new ForbiddenException({
        message: 'POST /demo/simulate-inflow requires DEMO_MODE_ENABLED=true',
        code: ErrorCodes.DEMO_MODE_ONLY,
      });
    }

    if (
      !adminSecret ||
      !timingSafeCompare(adminSecret, appConfig.ADMIN_SECRET)
    ) {
      throw new UnauthorizedException({
        message: 'Invalid admin secret',
        code: ErrorCodes.INVALID_ADMIN_SECRET,
      });
    }

    return this.demoService.simulateInflow(dto);
  }

  @Public()
  @All('webhook-echo')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Echo any webhook payload (demo mode only)',
    description:
      'Accepts any HTTP method and any JSON body. Returns the payload ' +
      'back to the caller with a timestamp. Useful for testing webhook ' +
      'delivery and inspecting payload shape. Requires DEMO_MODE_ENABLED=true.',
  })
  @ApiResponse({ status: 200, description: 'Payload echoed back' })
  @ApiResponse({ status: 403, description: 'DEMO_MODE_ONLY' })
  webhookEcho(@Body() body: unknown) {
    if (!appConfig.DEMO_MODE_ENABLED) {
      throw new ForbiddenException({
        message: 'ANY /demo/webhook-echo requires DEMO_MODE_ENABLED=true',
        code: ErrorCodes.DEMO_MODE_ONLY,
      });
    }
    return {
      received: true,
      timestamp: new Date().toISOString(),
      payload: body,
    };
  }
}
