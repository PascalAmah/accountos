import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

export interface DeliveryResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * Delivers outbound HTTP notifications for the NOTIFY_WEBHOOK rule action.
 *
 * Never throws — returns a DeliveryResult the caller uses to decide whether to
 * mark the rule execution COMPLETED or enqueue a retry (same retry path as
 * RELEASE_FUNDS).
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  async deliver(
    url: string,
    body: Record<string, unknown>,
  ): Promise<DeliveryResult> {
    try {
      const res = await axios.post(url, body, {
        timeout: 10_000,
        headers: { 'Content-Type': 'application/json' },
        // Any 2xx is success; everything else is a failure we can retry.
        validateStatus: (s) => s >= 200 && s < 300,
      });
      return { ok: true, status: res.status };
    } catch (err: unknown) {
      let status: number | undefined;
      let error = 'Webhook delivery failed';
      if (axios.isAxiosError(err)) {
        status = err.response?.status;
        error = err.message;
      } else if (err instanceof Error) {
        error = err.message;
      }
      this.logger.warn(
        { url, status, error },
        'NOTIFY_WEBHOOK delivery failed',
      );
      return { ok: false, status, error };
    }
  }
}
