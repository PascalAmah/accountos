/** Queue name for inbound Nomba webhook processing */
export const WEBHOOK_PROCESSING_QUEUE = 'webhook-processing';

/** Queue name for retrying failed rule actions */
export const RETRY_QUEUE = 'retry';

/** Default job options for all queues */
export const DEFAULT_JOB_OPTIONS = {
  removeOnComplete: true,
  removeOnFail: false,
} as const;
