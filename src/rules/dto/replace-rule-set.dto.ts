import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsEnum,
  IsBoolean,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ExecutionModel } from '@prisma/client';

/** A single rule definition — mirrors the shape validated by rule-schema.ts */
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

/** PUT /accounts/:ref/rules body */
export class ReplaceRuleSetDto {
  @IsEnum(ExecutionModel)
  @IsOptional()
  executionModel?: ExecutionModel;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RuleDefinition)
  @ArrayMinSize(1)
  rules!: RuleDefinition[];
}

/** PATCH /accounts/:ref/rules/:ruleId body */
export class ToggleRuleDto {
  @IsBoolean()
  enabled!: boolean;
}
