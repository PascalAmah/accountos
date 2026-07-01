import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class RenameCustomerDto {
  @ApiProperty({
    example: 'Chidi Okeke Trading Ltd',
    description: 'The new display name for the customer',
  })
  @IsString()
  @IsNotEmpty()
  newName!: string;

  @ApiPropertyOptional({
    example: 'Business registration',
    description:
      'Free-text reason for the rename (stored on the NameHistoryEntry)',
  })
  @IsString()
  @IsOptional()
  reason?: string;
}
