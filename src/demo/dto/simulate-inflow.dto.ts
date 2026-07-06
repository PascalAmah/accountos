import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SimulateInflowDto {
  @ApiProperty({
    description: 'Account number to simulate inflow for',
    example: '9900000001',
  })
  @IsString()
  @IsNotEmpty()
  accountNumber!: string;

  @ApiProperty({
    description: 'Amount in kobo (₦50,000 = 5000000)',
    example: 5000000,
  })
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  amountKobo!: number;

  @ApiPropertyOptional({
    description: 'Sender display name',
    example: 'Emeka Nwosu',
  })
  @IsString()
  @IsOptional()
  senderName?: string;

  @ApiPropertyOptional({
    description: 'Sender account number',
    example: '0123456789',
  })
  @IsString()
  @IsOptional()
  senderAccountNumber?: string;

  @ApiPropertyOptional({ description: 'Sender bank code', example: '044' })
  @IsString()
  @IsOptional()
  senderBankCode?: string;

  @ApiPropertyOptional({
    description: 'Transaction narration',
    example: 'Ajo contribution June',
  })
  @IsString()
  @IsOptional()
  narration?: string;
}
