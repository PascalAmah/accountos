import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * MetricsService — lightweight in-memory counters exposed as Prometheus text.
 *
 * No heavy dependencies. Counters are incremented atomically via service
 * methods and exported at GET /metrics (@Public()).
 */
@Injectable()
export class MetricsService {
  private readonly counters: Record<string, number> = {
    inflows_processed: 0,
    rule_executions_succeeded: 0,
    rule_executions_failed: 0,
    settlements_completed: 0,
    settlements_failed: 0,
  };

  constructor(private readonly prisma: PrismaService) {}

  inc(name: keyof MetricsService['counters'], delta = 1) {
    this.counters[name] += delta;
  }

  getCounter(name: string): number {
    return this.counters[name] ?? 0;
  }

  /** Return all counters in Prometheus exposition format */
  async prometheusText(): Promise<string> {
    const pendingRules = await this.prisma.ruleExecution.count({
      where: { status: 'PENDING' },
    });
    const failedRules = await this.prisma.ruleExecution.count({
      where: { status: 'FAILED' },
    });

    const lines = [
      '# HELP accountos_inflows_processed Total inflows processed',
      '# TYPE accountos_inflows_processed counter',
      `accountos_inflows_processed ${this.counters.inflows_processed}`,
      '',
      '# HELP accountos_rule_executions_total Rule executions by status',
      '# TYPE accountos_rule_executions_total counter',
      `accountos_rule_executions_total{status="succeeded"} ${this.counters.rule_executions_succeeded}`,
      `accountos_rule_executions_total{status="failed"} ${this.counters.rule_executions_failed}`,
      '',
      '# HELP accountos_settlements_total Settlements by status',
      '# TYPE accountos_settlements_total counter',
      `accountos_settlements_total{status="completed"} ${this.counters.settlements_completed}`,
      `accountos_settlements_total{status="failed"} ${this.counters.settlements_failed}`,
      '',
      '# HELP accountos_queue_depth Queue depth by state',
      '# TYPE accountos_queue_depth gauge',
      `accountos_queue_depth{state="pending"} ${pendingRules}`,
      `accountos_queue_depth{state="failed"} ${failedRules}`,
      '',
    ];

    return lines.join('\n');
  }
}
