import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { BucketType } from '@prisma/client';

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
}
