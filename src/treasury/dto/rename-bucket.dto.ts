import { IsString, IsNotEmpty, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RenameBucketDto {
  @ApiProperty({
    description: 'New display name for the treasury bucket',
    example: 'Ajo Tax Reserve',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(200)
  name!: string;
}
