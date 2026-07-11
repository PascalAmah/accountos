import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsEnum,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ExecutionModel } from '@prisma/client';

export class RuleDefinition {
  @ApiProperty({
    description: 'Event that activates this rule.',
    enum: ['inflow_received', 'custom_event', 'time_elapsed', 'tier_changed'],
    example: 'inflow_received',
  })
  @IsString()
  @IsNotEmpty()
  trigger!: string;

  @ApiProperty({
    description:
      'Condition evaluated against the triggering event. Values in kobo.',
    example: {
      amount_gte: 5000000,
    },
  })
  @IsNotEmpty()
  condition!: Record<string, unknown>;

  @ApiProperty({
    description: 'Action to execute when the condition matches.',
    enum: [
      'release_funds',
      'suspend_account',
      'reactivate_account',
      'expire_account',
      'notify_webhook',
      'flag_for_review',
    ],
    example: 'release_funds',
  })
  @IsString()
  @IsNotEmpty()
  action!: string;

  @ApiPropertyOptional({
    description:
      'Action payload. Required for `release_funds` and `notify_webhook`.',
    example: {
      destinationAccountRef: 'payroll-bucket',
      percentage: 30,
    },
  })
  @IsOptional()
  payload?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'Evaluation order for SEQUENTIAL accounts. Lower = evaluated first. Defaults to 0.',
    example: 0,
    default: 0,
  })
  @IsOptional()
  priority?: number;
}

export class ProvisionAccountDto {
  @ApiProperty({
    description: 'Customer ID that owns this account.',
    example: 'cus_ck8d2f3g4h5j6k7l8m9n0',
  })
  @IsString()
  @IsNotEmpty()
  customerId!: string;

  @ApiProperty({
    description:
      'Unique stable identifier for this account within your business.',
    example: 'ajo-amaka-jan-2026',
  })
  @IsString()
  @IsNotEmpty()
  accountRef!: string;

  @ApiProperty({
    description: 'Display name shown on bank statements.',
    example: 'Amaka Okonkwo — Ajo Savings',
  })
  @IsString()
  @IsNotEmpty()
  accountName!: string;

  @ApiPropertyOptional({
    description:
      'How rules are evaluated. SEQUENTIAL fires the first match; PARALLEL fires all matches.',
    enum: ExecutionModel,
    example: 'SEQUENTIAL',
    default: 'SEQUENTIAL',
  })
  @IsEnum(ExecutionModel)
  @IsOptional()
  executionModel?: ExecutionModel;

  @ApiProperty({
    description: 'Rules to attach at provisioning time. At least one required.',
    type: [RuleDefinition],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RuleDefinition)
  @ArrayMinSize(1)
  rules!: RuleDefinition[];
}
