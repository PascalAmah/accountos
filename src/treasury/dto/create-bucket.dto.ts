import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BucketType, SettlementDestinationType } from '@prisma/client';

export class CreateBucketDto {
  @ApiProperty({
    description:
      'Unique reference for the treasury bucket (developer-supplied). Must be unique per business.',
    example: 'ajo-payroll-bucket',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(100)
  bucketRef!: string;

  @ApiProperty({
    description: 'Human-readable display name for the bucket',
    example: 'Ajo Payroll Pool',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiProperty({
    description: 'Type of treasury bucket',
    enum: BucketType,
    example: 'PAYROLL',
  })
  @IsEnum(BucketType)
  @IsNotEmpty()
  bucketType!: BucketType;

  @ApiProperty({
    description: 'Optional human description of the bucket purpose',
    example: 'Monthly salary disbursements for Ajo members',
    required: false,
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string;

  // ── Optional settlement destination (where funds eventually settle to) ──

  @ApiPropertyOptional({
    description:
      'Optional default settlement destination type. When BANK_ACCOUNT, withdrawals ' +
      'may omit bank details and fall back to the saved values below.',
    enum: SettlementDestinationType,
    example: 'BANK_ACCOUNT',
  })
  @IsEnum(SettlementDestinationType)
  @IsOptional()
  settlementType?: SettlementDestinationType;

  @ApiPropertyOptional({ description: 'Saved settlement account name' })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  settlementAccountName?: string;

  @ApiPropertyOptional({ description: 'Saved settlement account number' })
  @IsString()
  @IsOptional()
  @MaxLength(20)
  settlementAccountNumber?: string;

  @ApiPropertyOptional({ description: 'Saved settlement bank code' })
  @IsString()
  @IsOptional()
  @MaxLength(10)
  settlementBankCode?: string;
}
