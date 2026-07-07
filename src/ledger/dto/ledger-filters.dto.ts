import { IsOptional, IsString, IsEnum, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';
import { ReconciliationStatus } from '@prisma/client';

export class LedgerFiltersDto {
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsEnum(ReconciliationStatus)
  reconciliationStatus?: ReconciliationStatus;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  limit?: number;
}
