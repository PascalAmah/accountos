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
import { SettlementStatus } from '@prisma/client';
import { TreasuryService } from './treasury.service';
import { SettlementService } from './settlement.service';
import { CreateBucketDto } from './dto/create-bucket.dto';
import { RenameBucketDto } from './dto/rename-bucket.dto';
import { WithdrawDto } from './dto/withdraw.dto';
import { TransferBucketDto } from './dto/transfer-bucket.dto';
import { CreateSettlementDto } from './dto/create-settlement.dto';

@ApiTags('treasury')
@ApiSecurity('api-key')
@Controller('treasury-buckets')
export class TreasuryController {
  constructor(
    private readonly treasuryService: TreasuryService,
    private readonly settlementService: SettlementService,
  ) {}

  // ─── POST /treasury-buckets ─────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Provision a new treasury bucket (logical sub-ledger)',
  })
  @ApiResponse({ status: 201, description: 'Bucket created successfully' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({ status: 409, description: 'Duplicate bucketRef' })
  async provision(@Body() dto: CreateBucketDto, @Req() req: Request) {
    return this.treasuryService.provisionBucket(dto, req.business.id);
  }

  // ─── GET /treasury-buckets ──────────────────────────────────────────────

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List treasury buckets for the business' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['ACTIVE', 'SUSPENDED', 'EXPIRED', 'CLOSED'],
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiResponse({ status: 200, description: 'Paginated bucket list' })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  async list(
    @Req() req: Request,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.treasuryService.getBuckets(req.business.id, {
      status,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
    });
  }

  // ─── GET /treasury-buckets/:ref ─────────────────────────────────────────

  @Get(':ref')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get a single treasury bucket with balance' })
  @ApiResponse({ status: 200, description: 'Bucket details with balance' })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({ status: 404, description: 'Bucket not found' })
  async get(@Param('ref') ref: string, @Req() req: Request) {
    return this.treasuryService.getBucket(ref, req.business.id);
  }

  // ─── PATCH /treasury-buckets/:ref ───────────────────────────────────────

  @Patch(':ref')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rename a treasury bucket' })
  @ApiResponse({ status: 200, description: 'Bucket renamed' })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({ status: 404, description: 'Bucket not found' })
  async rename(
    @Param('ref') ref: string,
    @Body() dto: RenameBucketDto,
    @Req() req: Request,
  ) {
    return this.treasuryService.renameBucket(ref, dto, req.business.id);
  }

  // ─── DELETE /treasury-buckets/:ref ──────────────────────────────────────

  @Delete(':ref')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Close a treasury bucket (EC-02 pattern)' })
  @ApiResponse({ status: 200, description: 'Bucket closed' })
  @ApiResponse({ status: 400, description: 'Already closed or terminal' })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({ status: 404, description: 'Bucket not found' })
  async close(@Param('ref') ref: string, @Req() req: Request) {
    const actor = req.apiKey.keyPrefix;
    return this.treasuryService.closeBucket(ref, req.business.id, actor);
  }

  // ─── GET /treasury-buckets/:ref/balance ─────────────────────────────────

  @Get(':ref/balance')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get treasury bucket balance (ledger-computed, no Nomba call)',
  })
  @ApiResponse({ status: 200, description: 'Bucket balance' })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({ status: 404, description: 'Bucket not found' })
  async balance(@Param('ref') ref: string, @Req() req: Request) {
    return this.treasuryService.getBalance(ref, req.business.id);
  }

  // ─── GET /treasury-buckets/:ref/statement ───────────────────────────────

  @Get(':ref/statement')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get paginated ledger statement for a bucket' })
  @ApiQuery({
    name: 'from',
    required: false,
    type: String,
    description: 'ISO date filter (start)',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    type: String,
    description: 'ISO date filter (end)',
  })
  @ApiQuery({
    name: 'entryType',
    required: false,
    enum: ['CREDIT', 'DEBIT'],
    description: 'Filter by entry type',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    type: String,
    description: 'Cursor for pagination',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Page size (max 100)',
    example: 50,
  })
  @ApiResponse({ status: 200, description: 'Paginated statement entries' })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({ status: 404, description: 'Bucket not found' })
  async statement(
    @Param('ref') ref: string,
    @Req() req: Request,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('entryType') entryType?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.treasuryService.getStatement(ref, req.business.id, {
      from,
      to,
      entryType,
      cursor,
      limit: limit ? parseInt(limit, 10) : 50,
    });
  }

  // ─── POST /treasury-buckets/:ref/transfer ───────────────────────────────

  @Post(':ref/transfer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Transfer funds between two treasury buckets (internal, no Nomba)',
  })
  @ApiResponse({ status: 200, description: 'Transfer completed' })
  @ApiResponse({ status: 400, description: 'Bucket not active or same bucket' })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({ status: 404, description: 'Bucket not found' })
  @ApiResponse({ status: 422, description: 'Insufficient bucket balance' })
  async transfer(
    @Param('ref') ref: string,
    @Body() dto: TransferBucketDto,
    @Req() req: Request,
  ) {
    return this.treasuryService.transferBetweenBuckets(
      ref,
      dto,
      req.business.id,
      req.apiKey.keyPrefix,
    );
  }

  // ─── POST /treasury-buckets/:ref/withdraw ───────────────────────────────

  @Post(':ref/withdraw')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Withdraw funds from a treasury bucket (EC-07 balance check)',
  })
  @ApiResponse({ status: 200, description: 'Withdrawal completed' })
  @ApiResponse({ status: 400, description: 'Bucket not active' })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({ status: 404, description: 'Bucket not found' })
  @ApiResponse({
    status: 422,
    description: 'Insufficient bucket balance (EC-07)',
  })
  @ApiResponse({ status: 502, description: 'Nomba API error' })
  async withdraw(
    @Param('ref') ref: string,
    @Body() dto: WithdrawDto,
    @Req() req: Request,
  ) {
    // Delegate to SettlementService for the durable lifecycle
    return this.settlementService.initiate(
      ref,
      { ...dto, destinationType: dto.destinationType ?? 'BANK_ACCOUNT' },
      req.business.id,
      req.business,
      req.apiKey.keyPrefix,
    );
  }

  // ─── Settlement routes ───────────────────────────────────────────────────

  @Get(':ref/settlements')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List settlements for a treasury bucket' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'],
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiResponse({ status: 200, description: 'Paginated settlement list' })
  async listSettlements(
    @Param('ref') ref: string,
    @Req() req: Request,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.settlementService.getByBucket(ref, req.business.id, {
      status: status as SettlementStatus | undefined,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
    });
  }
}
