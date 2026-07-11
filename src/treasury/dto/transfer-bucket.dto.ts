import { IsNumber, IsString, IsNotEmpty, Min, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class TransferBucketDto {
  @ApiProperty({
    description: 'Ref of the destination treasury bucket (must belong to the same business)',
    example: 'tax-reserve',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  destinationBucketRef!: string;

  @ApiProperty({
    description: 'Amount to move between buckets in KOBO (₦1 = 100 kobo). Must be positive.',
    example: 250000,
  })
  @IsNumber()
  @Min(1)
  amountKobo!: number;

  @ApiProperty({
    description: 'Narration / reason for the transfer',
    example: 'Move surplus operating funds to reserve',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  narration!: string;
}
