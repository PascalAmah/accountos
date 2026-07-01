import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
} from 'class-validator';

export class RegisterBusinessDto {
  @ApiProperty({ example: 'Account OS', description: 'Business display name' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({
    example: 'admin@accountos.com',
    description: 'Business contact email',
  })
  @IsEmail()
  email!: string;

  @ApiPropertyOptional({
    description: 'Nomba parent account ID for this business',
  })
  @IsString()
  @IsOptional()
  nombaAccountId?: string;

  @ApiPropertyOptional({
    description:
      'Nomba sub-account ID — scopes virtual accounts and fund collection',
  })
  @IsString()
  @IsOptional()
  nombaSubAccountId?: string;

  @ApiPropertyOptional({ description: 'Nomba OAuth client ID' })
  @IsString()
  @IsOptional()
  nombaClientId?: string;

  @ApiPropertyOptional({ description: 'Nomba OAuth client secret' })
  @IsString()
  @IsOptional()
  nombaClientSecret?: string;

  @ApiPropertyOptional({ description: 'Nomba webhook signing secret' })
  @IsString()
  @IsOptional()
  nombaWebhookSecret?: string;

  @ApiPropertyOptional({
    example: 'https://accountos.com/webhooks',
    description: 'URL to receive webhook events',
  })
  @IsUrl()
  @IsOptional()
  webhookUrl?: string;
}
