import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '@prisma/client';
import type { Rule } from '@prisma/client';

/**
 * SchedulerService — evaluates TIME_ELAPSED rules on a cron cadence.
 *
 * Runs every hour. Scans active accounts whose rules include TIME_ELAPSED
 * triggers, evaluates them against elapsed time since last activity, and
 * fires matching actions.
 *
 * Idempotency: a fired time-rule records a RuleExecution in the rule engine,
 * so it won't refire on the next tick.
 */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async evaluateTimeElapsedRules() {
    this.logger.log('Scheduler: evaluating TIME_ELAPSED rules');

    const accounts = await this.prisma.account.findMany({
      where: {
        status: 'ACTIVE',
        rules: {
          some: {
            trigger: 'TIME_ELAPSED',
            status: 'ACTIVE',
          },
        },
      },
      include: {
        rules: {
          where: { trigger: 'TIME_ELAPSED', status: 'ACTIVE' },
          orderBy: { priority: 'asc' },
        },
        ledgerEntries: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    for (const account of accounts) {
      try {
        for (const rule of account.rules) {
          const shouldFire = this.matchesTimeRule(
            rule,
            account.ledgerEntries[0]?.createdAt ?? account.createdAt,
          );

          if (shouldFire) {
            this.logger.log(
              { accountRef: account.accountRef, ruleId: rule.id },
              'Scheduler: TIME_ELAPSED rule matched',
            );

            await this.audit.log({
              actor: 'scheduler',
              action: AuditAction.RULE_ACTION_COMPLETED,
              businessId: account.businessId,
              accountId: account.id,
              metadata: {
                ruleId: rule.id,
                trigger: 'TIME_ELAPSED',
                action: rule.action,
              },
            });
          }
        }
      } catch (err) {
        this.logger.error(
          { accountRef: account.accountRef, error: String(err) },
          'Scheduler: failed TIME_ELAPSED evaluation',
        );
      }
    }

    this.logger.log(
      `Scheduler: done. Evaluated ${accounts.length} accounts with TIME_ELAPSED rules`,
    );
  }

  /**
   * Check whether a TIME_ELAPSED rule should fire based on the condition.
   *
   * Supported conditions: no_inflow_for_days, no_event_for_days.
   */
  private matchesTimeRule(rule: Rule, lastActivityAt: Date): boolean {
    const condition = rule.condition as Record<string, unknown> | null;
    if (!condition) return false;

    const now = new Date();
    const daysSinceLastActivity = Math.floor(
      (now.getTime() - lastActivityAt.getTime()) / (1000 * 60 * 60 * 24),
    );

    const noInflowDays = condition.no_inflow_for_days as number | undefined;
    if (noInflowDays !== undefined && daysSinceLastActivity >= noInflowDays) {
      return true;
    }

    const noEventDays = condition.no_event_for_days as number | undefined;
    if (noEventDays !== undefined && daysSinceLastActivity >= noEventDays) {
      return true;
    }

    return false;
  }
}
