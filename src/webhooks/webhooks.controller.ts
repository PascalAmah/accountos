import { Controller, Post, HttpCode, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { WebhooksService } from './webhooks.service';

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Public()
  @SkipThrottle()
  @Post('nomba')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Receive Nomba inflow webhook (HMAC-verified)',
    description:
      'Receives payment_success notifications from Nomba. HMAC-SHA256 verified ' +
      "using the business's own nombaWebhookSecret. Always returns 200.",
  })
  @ApiResponse({ status: 200, description: 'Webhook received and enqueued' })
  @ApiResponse({ status: 400, description: 'Missing accountNumber in payload' })
  @ApiResponse({ status: 401, description: 'Invalid webhook signature' })
  async receive(@Req() req: Request) {
    const rawBody = (req as unknown as Record<string, Buffer>).rawBody;
    const signature = req.headers['x-nomba-signature'] as string | undefined;

    return this.webhooksService.processInflow(rawBody, signature);
  }
}
