import { Module } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { AlertService } from './alert.service';

/**
 * Provides outbound webhook delivery (NOTIFY_WEBHOOK) and critical alerting.
 */
@Module({
  providers: [NotificationService, AlertService],
  exports: [NotificationService, AlertService],
})
export class NotificationModule {}
