import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

export class CreateApiKeyDto {
  @ApiProperty({ description: 'ID of the business this key belongs to' })
  @IsString()
  @IsNotEmpty()
  businessId!: string;

  @ApiProperty({
    example: 'Mobile App Key',
    description: 'Human-readable label for this key',
  })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({
    example: '2027-01-01T00:00:00.000Z',
    description: 'Optional ISO8601 datetime at which this key expires',
  })
  @IsDateString()
  @IsOptional()
  expiresAt?: string;
}
