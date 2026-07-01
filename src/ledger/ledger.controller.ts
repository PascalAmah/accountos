import { Controller, Get, Param, Query, Res, HttpCode } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { LedgerService } from './ledger.service';
import { LedgerFiltersDto } from './dto/ledger-filters.dto';
import { Business } from '../common/decorators/business.decorator';
import type { Business as BusinessEntity } from '@prisma/client';

@ApiTags('ledger')
@ApiSecurity('api-key')
@Controller('accounts/:accountRef/ledger')
export class LedgerController {
  constructor(private readonly ledgerService: LedgerService) {}

  /**
   * GET /accounts/:accountRef/ledger
   * Paginated ledger entries scoped to the authenticated business.
   */
  @Get()
  @ApiOperation({ summary: 'Paginated ledger entries for an account' })
  async getEntries(
    @Param('accountRef') accountRef: string,
    @Query() filters: LedgerFiltersDto,
    @Business() business: BusinessEntity,
  ) {
    return this.ledgerService.getEntriesByAccountRef(
      accountRef,
      business.id,
      filters,
    );
  }

  /**
   * GET /accounts/:accountRef/ledger/summary
   * Aggregate summary for the account.
   */
  @Get('summary')
  @ApiOperation({ summary: 'Aggregate ledger summary for an account' })
  async getSummary(
    @Param('accountRef') accountRef: string,
    @Business() business: BusinessEntity,
  ) {
    return this.ledgerService.getSummaryByAccountRef(accountRef, business.id);
  }

  /**
   * GET /accounts/:accountRef/ledger/export
   * Download ledger as CSV.
   */
  @Get('export')
  @HttpCode(200)
  @ApiOperation({ summary: 'Export ledger entries as CSV' })
  async exportCsv(
    @Param('accountRef') accountRef: string,
    @Business() business: BusinessEntity,
    @Res() res: Response,
  ) {
    const csv = await this.ledgerService.exportCsvByAccountRef(
      accountRef,
      business.id,
    );

    res.set({
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="ledger-${accountRef}.csv"`,
    });
    res.send(csv);
  }
}
