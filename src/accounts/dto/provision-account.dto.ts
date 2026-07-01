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
import { ExecutionModel, AccountType, BucketType } from '@prisma/client';

class RuleDefinition {
  @IsString()
  @IsNotEmpty()
  trigger!: string;

  @IsNotEmpty()
  condition!: Record<string, unknown>;

  @IsString()
  @IsNotEmpty()
  action!: string;

  @IsOptional()
  payload?: Record<string, unknown>;

  @IsOptional()
  priority?: number;
}

export class ProvisionAccountDto {
  @IsString()
  @IsOptional()
  customerId?: string;

  @IsString()
  @IsNotEmpty()
  accountRef!: string;

  @IsString()
  @IsNotEmpty()
  accountName!: string;

  @IsEnum(ExecutionModel)
  @IsOptional()
  executionModel?: ExecutionModel;

  @IsEnum(AccountType)
  @IsOptional()
  accountType?: AccountType;

  @IsEnum(BucketType)
  @IsOptional()
  bucketType?: BucketType;

  @IsString()
  @IsOptional()
  description?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RuleDefinition)
  @ArrayMinSize(1)
  rules!: RuleDefinition[];
}
