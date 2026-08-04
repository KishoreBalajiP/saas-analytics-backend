/**
 * Anomaly detection job (stub).
 *
 * WHY IT EXISTS
 *   Reserves the scheduled slot for the future anomaly-detection feature and
 *   demonstrates the job contract consumed by `jobs/scheduler.js`.
 *
 * RESPONSIBILITY
 *   None yet - logs and exits. Will scan recent analytics data for anomalies
 *   and dispatch alerts through the alerts module.
 *
 * HOW TO EXTEND
 *   - Adjust the cron / enable flag in `.env.example`
 *     (`JOB_ANOMALY_CRON`, `JOB_ANOMALY_ENABLED`).
 *   - Implement the feature under `src/modules/alerts/` and call it here.
 */

import logger from '../utils/logger.js';
import { JOB } from '../config/constants.js';

export default {
  name: JOB.NAMES.ANOMALY,
  cronExpression: process.env.JOB_ANOMALY_CRON || JOB.CRON.ANOMALY,
  enabled: process.env.JOB_ANOMALY_ENABLED === 'true',

  async handler() {
    // TODO(analytics): detect anomalies in recent metrics and enqueue alerts.
    logger.info('Anomaly detection job executed (stub - nothing to do)');
  },
};
