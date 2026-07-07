import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class NombaInflowDataDto {
  @IsString()
  @IsNotEmpty()
  transactionRef!: string;

  @IsString()
  @IsNotEmpty()
  accountNumber!: string;

  /** Amount in kobo as supplied by Nomba */
  @IsNumber()
  amount!: number;

  @IsString()
  @IsOptional()
  currency?: string;

  @IsString()
  @IsOptional()
  senderName?: string;

  @IsString()
  @IsOptional()
  senderAccountNumber?: string;

  @IsString()
  @IsOptional()
  senderBankCode?: string;

  @IsString()
  @IsOptional()
  narration?: string;

  @IsString()
  @IsOptional()
  createdAt?: string;
}

/**
 * Nomba inflow webhook payload shape (payment_success event).
 * This class mirrors the inline `NombaInflowPayload` interface
 * previously defined in webhooks.service.ts, now promoted to a
 * proper DTO for reuse across the webhooks module.
 */
export class NombaInflowWebhookDto {
  @IsString()
  @IsNotEmpty()
  eventId!: string;

  @IsString()
  @IsNotEmpty()
  eventType!: string;

  @ValidateNested()
  @Type(() => NombaInflowDataDto)
  data!: NombaInflowDataDto;
}
