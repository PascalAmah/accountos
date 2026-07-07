import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Put,
  Req,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { RulesService } from './rules.service';
import { ReplaceRuleSetDto } from './dto/replace-rule-set.dto';
import { ToggleRuleDto } from './dto/replace-rule-set.dto';

@ApiTags('rules')
@ApiSecurity('api-key')
@Controller('accounts/:ref/rules')
export class RulesController {
  constructor(private readonly rulesService: RulesService) {}

  // ─── PUT /accounts/:ref/rules ──────────────────────────────────────────

  @Put()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Replace the entire rule set for an account' })
  @ApiResponse({ status: 200, description: 'Rule set replaced' })
  @ApiResponse({
    status: 400,
    description: 'Invalid rule set or percentage sum > 100',
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  async replaceRuleSet(
    @Param('ref') ref: string,
    @Body() dto: ReplaceRuleSetDto,
    @Req() req: Request,
  ) {
    return this.rulesService.replaceRuleSet(ref, req.business.id, dto);
  }

  // ─── PATCH /accounts/:ref/rules/:ruleId ────────────────────────────────

  @Patch(':ruleId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enable or disable a rule (toggle)' })
  @ApiResponse({ status: 200, description: 'Rule toggled' })
  @ApiResponse({ status: 400, description: 'Invalid transition' })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({ status: 404, description: 'Rule not found' })
  async toggleRule(
    @Param('ref') ref: string,
    @Param('ruleId') ruleId: string,
    @Body() dto: ToggleRuleDto,
    @Req() req: Request,
  ) {
    return this.rulesService.toggleRule(
      ref,
      ruleId,
      req.business.id,
      dto.enabled,
    );
  }

  // ─── DELETE /accounts/:ref/rules/:ruleId ───────────────────────────────

  @Delete(':ruleId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete (archive) a rule' })
  @ApiResponse({ status: 200, description: 'Rule archived' })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({ status: 404, description: 'Rule not found' })
  async deleteRule(
    @Param('ref') ref: string,
    @Param('ruleId') ruleId: string,
    @Req() req: Request,
  ) {
    return this.rulesService.deleteRule(ref, ruleId, req.business.id);
  }
}
