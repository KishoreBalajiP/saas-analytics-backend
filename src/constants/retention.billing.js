/**
 * Retention declarations for collections the billing package grows
 * (roadmap 3.1). Integration wires them into the retention cleanup job.
 *
 * `WebhookEvent` now stores one row per provider delivery (the dedupe and
 * work item of store-then-process ingestion). Rows are kept long enough to
 * answer any provider dispute about a delivery; payment records themselves
 * (`PaymentTransaction`, `Subscription`, `SubscriptionHistory`) are
 * statutory and are NOT declared here.
 */

export const RETENTION = Object.freeze([
  {
    model: 'WebhookEvent',
    field: 'createdAt',
    envKey: 'RETENTION_BILLING_WEBHOOK_EVENTS_DAYS',
    defaultDays: 400,
    description: 'Stored payment-provider webhook deliveries (dedupe + processing record).',
  },
]);

export default RETENTION;
