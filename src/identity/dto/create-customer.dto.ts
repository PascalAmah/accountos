import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Matches,
} from 'class-validator';

export class CreateCustomerDto {
  @ApiProperty({
    example: 'Chidi Okeke',
    description: 'Display name for the customer',
  })
  @IsString()
  @IsNotEmpty()
  displayName!: string;

  // kycTier is NOT accepted on creation — it is derived automatically:
  //   bvnRef present  → TIER_1 (BVN-linked)
  //   bvnRef absent   → TIER_0 (unverified)
  // Use PATCH /customers/:id/kyc-tier to upgrade beyond TIER_1.

  @ApiPropertyOptional({
    example: 'sha256:abc123...',
    description: 'SHA-256 hash of the customer BVN — never the raw BVN',
  })
  @IsString()
  @Matches(/^sha256:[a-f0-9]{64}$/i, {
    message: 'bvnRef must be a SHA-256 hash in the format sha256:<hex64>',
  })
  @IsOptional()
  bvnRef?: string;

  @ApiPropertyOptional({
    example: 'Dojah',
    description:
      'KYC verification provider used by the business (e.g. Dojah, Prembly, Smile ID)',
  })
  @IsString()
  @IsOptional()
  kycVerificationProvider?: string;

  @ApiPropertyOptional({
    example: 'verify_abc123',
    description: "Provider's verification reference ID",
  })
  @IsString()
  @IsOptional()
  kycVerificationRef?: string;

  @ApiPropertyOptional({
    example: 'chidi@example.com',
    description: "Customer's email address",
  })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiPropertyOptional({
    example: '+2348012345678',
    description: "Customer's phone number in E.164 format",
  })
  @IsPhoneNumber()
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({
    example: null,
    description:
      'Parent customer ID for hierarchical relationships (e.g. landlord → tenant)',
    nullable: true,
  })
  @IsString()
  @IsOptional()
  parentId?: string | null;
}
