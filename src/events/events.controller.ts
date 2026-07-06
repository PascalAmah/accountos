import { Controller, Post, Param, Body, HttpCode, Req } from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiSecurity,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { EventsService } from './events.service';
import { CustomEventDto } from './dto/custom-event.dto';

@ApiTags('events')
@ApiSecurity('api-key')
@Controller('accounts/:accountRef/events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Dispatch a custom business event (EC-04 idempotent)',
    description:
      'Triggers a custom event (e.g. cycle_reset, delivery_confirmed) against ' +
      'an account. Enqueued to BullMQ — returns 200 immediately. Duplicate ' +
      'eventId is silently discarded.',
  })
  @ApiResponse({ status: 200, description: 'Event received and enqueued' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  async dispatch(
    @Param('accountRef') accountRef: string,
    @Body() dto: CustomEventDto,
    @Req() req: Request,
  ) {
    return this.eventsService.dispatch(
      accountRef,
      dto.eventId,
      dto.eventName,
      req.business.id,
    );
  }
}
