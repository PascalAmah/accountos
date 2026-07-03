import {
  Body,
  Controller,
  Delete,
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
import { AccountLifecycleService } from './account-lifecycle.service';
import { ProvisionAccountDto } from './dto/provision-account.dto';
import { UpdateStatusDto } from './dto/update-status.dto';

@ApiTags('accounts')
@ApiSecurity('api-key')
@Controller()
export class AccountsController {
  constructor(private readonly accountLifecycle: AccountLifecycleService) {}

  // ─── POST /accounts ─────────────────────────────────────────────────────

  @Post('accounts')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Provision a new virtual account with rule set' })
  @ApiResponse({ status: 201, description: 'Account provisioned successfully' })
  @ApiResponse({
    status: 400,
    description: 'Validation error or invalid rule set',
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({ status: 404, description: 'Customer not found' })
  @ApiResponse({ status: 409, description: 'Duplicate accountRef' })
  async provision(@Body() dto: ProvisionAccountDto, @Req() req: Request) {
    return this.accountLifecycle.provisionAccount(dto, req.business.id);
  }

  // ─── GET /accounts ─────────────────────────────────────────────────────

  @Get('accounts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List accounts for the authenticated business' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['ACTIVE', 'SUSPENDED', 'EXPIRED', 'CLOSED'],
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiResponse({ status: 200, description: 'Paginated account list' })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  async list(
    @Req() req: Request,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.accountLifecycle.listAccounts(req.business.id, {
      status,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
    });
  }

  // ─── GET /accounts/:accountRef/state ───────────────────────────────────

  @Get('accounts/:accountRef/state')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get rich state summary of an account' })
  @ApiResponse({ status: 200, description: 'Account state' })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  async getState(@Param('accountRef') accountRef: string, @Req() req: Request) {
    return this.accountLifecycle.getAccountState(accountRef, req.business.id);
  }

  // ─── PATCH /accounts/:accountRef/status ────────────────────────────────

  @Patch('accounts/:accountRef/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually override account status' })
  @ApiResponse({ status: 200, description: 'Status updated' })
  @ApiResponse({
    status: 400,
    description: 'Invalid transition or terminal state',
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  async updateStatus(
    @Param('accountRef') accountRef: string,
    @Body() dto: UpdateStatusDto,
    @Req() req: Request,
  ) {
    const actor = req.apiKey.keyPrefix;
    return this.accountLifecycle.updateStatus(
      accountRef,
      dto,
      req.business.id,
      actor,
    );
  }

  // ─── DELETE /accounts/:accountRef ─────────────────────────────────────

  @Delete('accounts/:accountRef')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Close an account (EC-02)' })
  @ApiResponse({ status: 200, description: 'Account closed' })
  @ApiResponse({
    status: 400,
    description: 'Account already closed or terminal',
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  async close(
    @Param('accountRef') accountRef: string,
    @Req() req: Request & { business: Record<string, unknown> },
  ) {
    const actor = req.apiKey.keyPrefix;
    return this.accountLifecycle.closeAccount(
      accountRef,
      (req as unknown as { business: { id: string } }).business.id,
      actor,
      req.business,
    );
  }
}
