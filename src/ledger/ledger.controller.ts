import { Controller, Get, Param, Query, Res, HttpCode } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { LedgerService } from './ledger.service';
import { LedgerFiltersDto } from './dto/ledger-filters.dto';
import { Business } from '../common/decorators/business.decorator';
import type { Business as BusinessEntity } from '@prisma/client';

@ApiTags('ledger')
@ApiSecurity('api-key')
@Controller('accounts/:ref/ledger')
export class LedgerController {
  constructor(private readonly ledgerService: LedgerService) {}

  /**
   * GET /accounts/:ref/ledger
   * Paginated ledger entries scoped to the authenticated business.
   */
  @Get()
  @ApiOperation({ summary: 'Paginated ledger entries for an account' })
  async getEntries(
    @Param('ref') ref: string,
    @Query() filters: LedgerFiltersDto,
    @Business() business: BusinessEntity,
  ) {
    return this.ledgerService.getEntriesByAccountRef(ref, business.id, filters);
  }

  /**
   * GET /accounts/:ref/ledger/summary
   * Aggregate summary for the account.
   */
  @Get('summary')
  @ApiOperation({ summary: 'Aggregate ledger summary for an account' })
  async getSummary(
    @Param('ref') ref: string,
    @Business() business: BusinessEntity,
  ) {
    return this.ledgerService.getSummaryByAccountRef(ref, business.id);
  }

  /**
   * GET /accounts/:ref/ledger/export
   * Download ledger as CSV.
   */
  @Get('export')
  @HttpCode(200)
  @ApiOperation({ summary: 'Export ledger entries as CSV' })
  async exportCsv(
    @Param('ref') ref: string,
    @Business() business: BusinessEntity,
    @Res() res: Response,
  ) {
    const csv = await this.ledgerService.exportCsvByAccountRef(
      ref,
      business.id,
    );

    res.set({
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="ledger-${ref}.csv"`,
    });
    res.send(csv);
  }
}
