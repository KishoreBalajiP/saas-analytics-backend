/**
 * Scheduler configuration.
 *
 * WHY IT EXISTS
 *   Bundles the global switch and timezone for the node-cron infrastructure
 *   so individual jobs only care about their own cron expression.
 *
 * RESPONSIBILITY
 *   Surface whether the scheduler is enabled and which timezone cron
 *   expressions are evaluated in.
 *
 * HOW TO EXTEND
 *   Job-specific settings (cron, per-job enable flags) live under
 *   `env.jobs.*` and each job file reads them itself.
 */

import env from './env.js';

export default {
  enabled: env.scheduler.enabled,
  timezone: env.scheduler.timezone,
};
