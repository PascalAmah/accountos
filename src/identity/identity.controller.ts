import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { IdentityService } from './identity.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { RenameCustomerDto } from './dto/rename-customer.dto';
import { UpdateKycTierDto } from './dto/update-kyc-tier.dto';

@ApiTags('customers')
@ApiSecurity('api-key')
@Controller()
export class IdentityController {
  constructor(private readonly identityService: IdentityService) {}

  // ─── POST /customers ───────────────────────────────────────────────────────

  @Post('customers')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new customer scoped to the authenticated business',
  })
  @ApiResponse({ status: 201, description: 'Customer created successfully' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  async createCustomer(@Body() dto: CreateCustomerDto, @Req() req: Request) {
    return this.identityService.createCustomer(dto, req.business.id);
  }

  // ─── GET /customers ────────────────────────────────────────────────────────

  @Get('customers')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List all customers for the authenticated business',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiResponse({ status: 200, description: 'Paginated customer list' })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  async listCustomers(
    @Req() req: Request,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.identityService.listCustomers(
      (req as unknown as { business: { id: string } }).business.id,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  // ─── GET /customers/:id ────────────────────────────────────────────────────

  @Get('customers/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get a customer by ID with name history and linked accounts',
  })
  @ApiResponse({ status: 200, description: 'Customer found' })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({ status: 404, description: 'Customer not found' })
  async getCustomer(@Param('id') id: string, @Req() req: Request) {
    return this.identityService.getCustomer(id, req.business.id);
  }

  // ─── PATCH /customers/:id/name ─────────────────────────────────────────────

  @Patch('customers/:id/name')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rename a customer — appends a NameHistoryEntry (EC-01)',
  })
  @ApiResponse({ status: 200, description: 'Customer renamed successfully' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({ status: 404, description: 'Customer not found' })
  async renameCustomer(
    @Param('id') id: string,
    @Body() dto: RenameCustomerDto,
    @Req() req: Request,
  ) {
    const actor = req.apiKey.keyPrefix;
    return this.identityService.renameCustomer(id, dto, req.business.id, actor);
  }

  // ─── PATCH /customers/:id/kyc-tier ────────────────────────────────────────

  @Patch('customers/:id/kyc-tier')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update the KYC tier for a customer — flags stale rules (EC-03)',
  })
  @ApiResponse({
    status: 200,
    description: 'KYC tier updated; returns flagged rule IDs',
  })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({ status: 404, description: 'Customer not found' })
  async updateKycTier(
    @Param('id') id: string,
    @Body() dto: UpdateKycTierDto,
    @Req() req: Request,
  ) {
    const actor = req.apiKey.keyPrefix;
    return this.identityService.updateKycTier(id, dto, req.business.id, actor);
  }
}
