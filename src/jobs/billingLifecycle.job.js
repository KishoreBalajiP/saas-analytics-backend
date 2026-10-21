/**
 * Billing lifecycle job (billing, roadmap 3.1 - prepaid terms).
 *
 * WHY IT EXISTS
 *   Prepaid terms end. Access is already computed from state + period on
 *   every check (`subscriptionService.computeAccess`), so a late run never
 *   extends access; this job persists those transitions and tells the
 *   workspace about them (finding bil.04: one-time payments used to grant
 *   the plan forever).
 *
 * RESPONSIBILITY
 *   `billingLifecycle.runLifecycleSweep()`:
 *     - unrenewed paid term -> `past_due` (grace: plan graceDays, else
 *       BILLING_DEFAULT_GRACE_DAYS) -> `restricted`
 *     - canceled at period end -> `expired`
 *     - trial ended -> free plan
 *     - queued downgrade / prepaid lower-tier term applied at period end
 *     - renewal reminders (BILLING_RENEWAL_REMINDER_DAYS) and the grace
 *       notice through the email outbox (idempotent per period)
 *   Registered with the scheduler, so each tick runs under the per-job
 *   lease lock and records a JobRun with the returned counts.
 *
 * HOW TO EXTEND
 *   Adjust `JOB_BILLING_LIFECYCLE_CRON` / `JOB_BILLING_LIFECYCLE_ENABLED`.
 *   Every step is a compare-and-set, so overlapping runs are safe.
 */

import logger from '../utils/logger.js';
import env from '../config/env.js';
import billingLifecycle from '../services/billingLifecycle.service.js';

export default {
  name: 'billing-lifecycle',
  cronExpression: env.jobs.billingLifecycle.cron,
  enabled: env.jobs.billingLifecycle.enabled,

  async handler() {
    const result = await billingLifecycle.runLifecycleSweep();
    logger.info({ result }, 'Billing lifecycle job executed');
    return result;
  },
};
