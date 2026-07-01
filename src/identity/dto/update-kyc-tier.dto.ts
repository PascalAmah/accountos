import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { KycTier } from '@prisma/client';
import {
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

/** Allowed reason codes for a KYC tier change (EC-03). */
export const KYC_TIER_REASON_VALUES = [
  'BVN_VERIFIED',
  'NIN_VERIFIED',
  'ADDRESS_VERIFIED',
  'BUSINESS_VERIFIED',
  'ENHANCED_DUE_DILIGENCE',
  'TIER_DOWNGRADED',
  'MANUAL_COMPLIANCE_REVIEW',
] as const;

export type KycTierReason = (typeof KYC_TIER_REASON_VALUES)[number];

export class UpdateKycTierDto {
  @ApiProperty({
    enum: KycTier,
    example: KycTier.TIER_2,
    description: 'The new KYC tier to assign to the customer',
  })
  @IsEnum(KycTier)
  @IsNotEmpty()
  kycTier!: KycTier;

  @ApiPropertyOptional({
    example: 'Prembly',
    description: 'KYC verification provider used to verify this tier upgrade',
  })
  @IsString()
  @IsOptional()
  verificationProvider?: string;

  @ApiPropertyOptional({
    example: 'kyc_987654',
    description:
      "Provider's verification reference ID — stored for compliance purposes",
  })
  @IsString()
  @IsOptional()
  verificationRef?: string;

  @ApiPropertyOptional({
    enum: KYC_TIER_REASON_VALUES,
    example: 'BVN_VERIFIED',
    description: 'Reason code for the tier change',
  })
  @IsIn(KYC_TIER_REASON_VALUES)
  @IsOptional()
  reason?: KycTierReason;
}
