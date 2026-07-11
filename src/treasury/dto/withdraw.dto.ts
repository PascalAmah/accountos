import {
  IsNumber,
  IsString,
  IsNotEmpty,
  IsOptional,
  Min,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class WithdrawDto {
  @ApiProperty({
    description:
      'Amount to withdraw (settle) in KOBO (₦1 = 100 kobo). Must be positive.',
    example: 500000, // ₦5,000
  })
  @IsNumber()
  @Min(1)
  amountKobo!: number;

  @ApiProperty({
    description: 'Narration / reason for the withdrawal',
    example: 'Ajo payout to vendor',
  })
  @IsString()
  @IsNotEmpty()
  narration!: string;

  @ApiPropertyOptional({
    description:
      'Destination bank account number (10 digits). Optional only if the bucket ' +
      'has a saved BANK_ACCOUNT settlement destination to fall back to.',
    example: '0554772814',
  })
  @IsString()
  @IsOptional()
  @MaxLength(20)
  destinationAccountNumber?: string;

  @ApiPropertyOptional({
    description:
      'Destination bank code. Falls back to the saved settlement bank code.',
    example: '058',
  })
  @IsString()
  @IsOptional()
  @MaxLength(10)
  destinationBankCode?: string;

  @ApiPropertyOptional({
    description:
      'Name on the destination bank account. Falls back to the saved settlement name.',
    example: 'M.A Animashaun',
  })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  destinationAccountName?: string;

  @ApiPropertyOptional({
    description:
      'Settlement destination type. BANK_ACCOUNT, NOMBA_ACCOUNT, or INTERNAL_BUCKET. ' +
      "Defaults to the bucket's stored settlement type if omitted.",
    example: 'BANK_ACCOUNT',
  })
  @IsString()
  @IsOptional()
  destinationType?: string;
}
