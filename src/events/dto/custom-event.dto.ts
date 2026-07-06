import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CustomEventDto {
  @ApiProperty({
    description:
      'Unique event ID for idempotency. Duplicate eventIds are silently discarded (EC-04).',
    example: 'evt-reset-feb-2026-chidi',
  })
  @IsString()
  @IsNotEmpty()
  eventId!: string;

  @ApiProperty({
    description:
      'Event name used for rule matching in CUSTOM_EVENT trigger conditions.',
    example: 'cycle_reset',
  })
  @IsString()
  @IsNotEmpty()
  eventName!: string;
}
