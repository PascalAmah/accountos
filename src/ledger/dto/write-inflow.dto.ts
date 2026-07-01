import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsEnum,
} from 'class-validator';
import { KycTier } from '@prisma/client';

export class WriteInflowDto {
  @IsString()
  @IsNotEmpty()
  accountId!: string;

  @IsString()
  @IsNotEmpty()
  nombaTransactionRef!: string;

  @IsString()
  @IsNotEmpty()
  nombaEventId!: string;

  /** Amount in KOBO (BigInt stored as number for transport) */
  @IsNumber()
  amountKobo!: number;

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

  /** Immutable snapshot of the customer's display name at time of inflow */
  @IsString()
  @IsOptional()
  customerNameSnapshot?: string;

  /** Immutable snapshot of the customer's KYC tier at time of inflow */
  @IsEnum(KycTier)
  @IsOptional()
  kycTierAtTime?: KycTier;
}
