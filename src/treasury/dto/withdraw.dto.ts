import { IsNumber, IsString, IsNotEmpty, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class WithdrawDto {
  @ApiProperty({
    description:
      'Amount to withdraw in KOBO (₦1 = 100 kobo). Must be positive.',
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
}
