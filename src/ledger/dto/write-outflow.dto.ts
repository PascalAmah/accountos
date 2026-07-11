import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsEnum,
} from 'class-validator';
import { KycTier } from '@prisma/client';

export class WriteOutflowDto {
  @IsString()
  @IsNotEmpty()
  accountId!: string;

  @IsString()
  @IsNotEmpty()
  nombaTransactionRef!: string;

  /** Amount in KOBO (BigInt stored as number for transport) */
  @IsNumber()
  amountKobo!: number;

  @IsString()
  @IsNotEmpty()
  narration!: string;

  /**
   * Snapshot of the customer name at time of outflow.
   * For treasury withdrawals (no customer), pass 'System' or the business name.
   */
  @IsString()
  @IsOptional()
  customerNameSnapshot?: string;

  /**
   * Snapshot of the KYC tier at time of outflow.
   * For system entries with no customer, defaults to 'TIER_0' (unverified).
   */
  @IsEnum(KycTier)
  @IsOptional()
  kycTierAtTime?: KycTier;

  /**
   * Running total at time of this entry.
   * For outflows, pass 0n or compute from caller context.
   */
  cumulativeAmountKobo?: bigint;
}
