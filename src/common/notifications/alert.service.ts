import { Injectable, Logger } from '@nestjs/common';

/**
 * AlertService — lightweight alerting hook for critical failures.
 *
 * Currently log-based. Replace with email/Slack/PagerDuty in production
 * by swapping the implementation behind this interface.
 */
@Injectable()
export class AlertService {
  private readonly logger = new Logger(AlertService.name);

  /**
   * Fire a critical alert. Called by the DLQ handler when a job exhausts
   * all retries, and by any process that hits an unrecoverable error.
   */
  critical(context: {
    component: string;
    message: string;
    metadata?: Record<string, unknown>;
  }) {
    // Log-based for now — swap with email/Slack webhook/PagerDuty later
    this.logger.error(
      { alert: 'CRITICAL', ...context },
      `[ALERT] ${context.component}: ${context.message}`,
    );
  }
}
