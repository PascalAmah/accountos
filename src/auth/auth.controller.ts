import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { AuthService } from './auth.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { RegisterBusinessDto } from './dto/register-business.dto';
import { UpdateBusinessCredentialsDto } from './dto/update-business-credentials.dto';

@ApiTags('auth')
@Controller()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ─── POST /businesses ──────────────────────────────────────────────────────

  @Public()
  @Post('businesses')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ admin: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Register a new business' })
  @ApiHeader({
    name: 'x-admin-secret',
    description: 'Admin secret required to register a business',
    required: true,
  })
  @ApiResponse({ status: 201, description: 'Business registered successfully' })
  @ApiResponse({ status: 401, description: 'Invalid admin secret' })
  async registerBusiness(
    @Headers('x-admin-secret') adminSecret: string,
    @Body() dto: RegisterBusinessDto,
  ) {
    return this.authService.registerBusiness(dto, adminSecret);
  }

  // ─── PATCH /businesses/:id/credentials ────────────────────────────────────

  @Public()
  @Patch('businesses/:id/credentials')
  @HttpCode(HttpStatus.OK)
  @Throttle({ admin: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Update Nomba credentials for a business',
    description:
      'Partial update — only fields present in the request body are written. ' +
      'Use this to graduate a mock-mode business to production by adding real Nomba credentials, ' +
      'or to rotate individual credentials without re-registering.',
  })
  @ApiHeader({
    name: 'x-admin-secret',
    description: 'Admin secret required to update credentials',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description:
      'Credentials updated. hasNombaCredentials is true when all four Nomba fields are set.',
    schema: {
      example: {
        businessId: 'clx...',
        name: 'AjoApp Ltd',
        hasNombaCredentials: true,
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Invalid admin secret' })
  @ApiResponse({ status: 404, description: 'Business not found' })
  async updateBusinessCredentials(
    @Param('id') id: string,
    @Headers('x-admin-secret') adminSecret: string,
    @Body() dto: UpdateBusinessCredentialsDto,
  ) {
    return this.authService.updateBusinessCredentials(id, dto, adminSecret);
  }

  // ─── POST /api-keys ────────────────────────────────────────────────────────

  @Public()
  @Post('api-keys')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ admin: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Create a new API key for a business' })
  @ApiHeader({
    name: 'x-admin-secret',
    description: 'Admin secret required to create an API key',
    required: true,
  })
  @ApiResponse({
    status: 201,
    description: 'API key created — raw key returned once',
  })
  @ApiResponse({ status: 401, description: 'Invalid admin secret' })
  async createApiKey(
    @Headers('x-admin-secret') adminSecret: string,
    @Body() dto: CreateApiKeyDto,
  ) {
    return this.authService.createApiKey(dto, adminSecret);
  }

  // ─── GET /api-keys ─────────────────────────────────────────────────────────

  @Get('api-keys')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List all API keys for the authenticated business' })
  @ApiHeader({
    name: 'x-api-key',
    description: 'API key for authentication',
    required: true,
  })
  @ApiResponse({ status: 200, description: 'Array of API key summaries' })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  async listApiKeys(@Req() req: Request & { business: { id: string } }) {
    return this.authService.listApiKeys(req.business.id);
  }

  // ─── DELETE /api-keys/:id ──────────────────────────────────────────────────

  @Delete('api-keys/:id')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke an API key' })
  @ApiHeader({
    name: 'x-api-key',
    description: 'API key for authentication',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'API key revoked',
    schema: { example: { revoked: true } },
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({ status: 404, description: 'API key not found' })
  async revokeApiKey(
    @Param('id') id: string,
    @Req()
    req: Request & { business: { id: string }; apiKey: { keyPrefix: string } },
  ) {
    const actor = req.apiKey.keyPrefix;
    await this.authService.revokeApiKey(id, req.business.id, actor);
    return { revoked: true };
  }
}
