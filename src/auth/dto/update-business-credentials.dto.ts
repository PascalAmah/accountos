import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl } from 'class-validator';

export class UpdateBusinessCredentialsDto {
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

  @ApiPropertyOptional({ description: 'Nomba webhook HMAC signing secret' })
  @IsString()
  @IsOptional()
  nombaWebhookSecret?: string;

  @ApiPropertyOptional({
    example: 'https://accountos.com/webhooks',
    description: 'Default outbound webhook URL',
  })
  @IsUrl()
  @IsOptional()
  webhookUrl?: string;
}
