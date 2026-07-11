import { IsInt, IsOptional, IsString, Min } from 'class-validator';

/**
 * DTO for initiating a settlement (withdrawal).
 *
 * Destination fields are optional — if omitted, the bucket's stored
 * settlement destination is used. For INTERNAL_BUCKET destinations,
 * provide destinationBucketRef instead of bank details.
 */
export class CreateSettlementDto {
  @IsInt()
  @Min(1)
  amountKobo!: number;

  @IsOptional()
  @IsString()
  destinationType?: string;

  @IsOptional()
  @IsString()
  destinationAccountName?: string;

  @IsOptional()
  @IsString()
  destinationAccountNumber?: string;

  @IsOptional()
  @IsString()
  destinationBankCode?: string;

  @IsOptional()
  @IsString()
  destinationBucketRef?: string;

  @IsOptional()
  @IsString()
  narration?: string;
}
