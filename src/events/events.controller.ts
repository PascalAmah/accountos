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
@Controller('accounts/:ref/events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Dispatch a custom business event (idempotent)',
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
    @Param('ref') ref: string,
    @Body() dto: CustomEventDto,
    @Req() req: Request,
  ) {
    return this.eventsService.dispatch(
      ref,
      dto.eventId,
      dto.eventName,
      req.business.id,
    );
  }
}
