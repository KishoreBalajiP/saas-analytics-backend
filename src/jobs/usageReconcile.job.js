/**
 * Usage reconciliation job (roadmap 1.3).
 *
 * WHY IT EXISTS
 *   Resource quotas are counters kept next to the resources they count.
 *   A crash between a create and its counter update, a manual database fix
 *   or an old bug can leave them drifted; this daily sweep recounts the real
 *   resources and corrects the counters so tenants are neither locked out
 *   nor allowed past their plan.
 *
 * RESPONSIBILITY
 *   Run `usageService.reconcileAll({ dryRun: false })` over every tenant.
 *   Each correction is compare-and-set and counters that changed within
 *   `USAGE_RECONCILE_SETTLE_MS` are left for the next run, so overlapping
 *   runs and live traffic are safe.
 *
 * HOW TO EXTEND
 *   - Adjust the cron / enable flag (`JOB_USAGE_RECONCILE_CRON`,
 *     `JOB_USAGE_RECONCILE_ENABLED`). Disabled by default: review a dry run
 *     (`npm run db:reconcile-usage`) before enabling it per environment.
 */

import logger from '../utils/logger.js';
import env from '../config/env.js';
import usageService from '../services/usage.service.js';

export default {
  name: 'usage-reconcile',
  cronExpression: env.jobs.usageReconcile.cron,
  enabled: env.jobs.usageReconcile.enabled,

  async handler() {
    const summary = await usageService.reconcileAll({ dryRun: false, by: 'scheduler' });
    logger.info(
      {
        tenants: summary.tenants,
        drifted: summary.drifted,
        corrected: summary.corrected,
        skipped: summary.skipped,
        failed: summary.failed,
      },
      'Usage reconcile job executed',
    );
    return summary;
  },
};
