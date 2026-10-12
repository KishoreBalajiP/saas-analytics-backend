/**
 * Billing reconciliation job.
 *
 * WHY IT EXISTS
 *   Recovers pending Razorpay checkouts when webhooks are delayed or lost
 *   (missed deliveries, deploys during payment, dashboard replays).
 *
 * RESPONSIBILITY
 *   Sweep bounded pending-transaction batches through
 *   `billingReconcile.service.reconcilePending`. Disabled by default
 *   (`JOB_BILLING_RECONCILE_ENABLED=false`); enable per environment in
 *   `.env.example`. No-op when Razorpay itself is disabled.
 *
 * HOW TO EXTEND
 *   - Adjust the cron / enable flag (`JOB_BILLING_RECONCILE_CRON`,
 *     `JOB_BILLING_RECONCILE_ENABLED`).
 *   - The service is idempotent; overlapping runs collapse via its
 *     single-flight guard.
 */

import logger from '../utils/logger.js';
import env from '../config/env.js';
import billingReconcileService from '../services/billingReconcile.service.js';

export default {
  name: 'billing-reconcile',
  cronExpression: env.jobs.billingReconcile.cron,
  enabled: env.jobs.billingReconcile.enabled,

  async handler() {
    if (!env.razorpay.enabled) {
      logger.info('Billing reconcile skipped (Razorpay disabled)');
      return;
    }
    const result = await billingReconcileService.reconcilePending({ by: 'scheduler' });
    logger.info({ result }, 'Billing reconcile job executed');
  },
};
