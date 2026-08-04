/**
 * Sheet sync job (stub).
 *
 * WHY IT EXISTS
 *   Reserves the scheduled slot for periodic Google Sheets sync and
 *   demonstrates the job contract consumed by `jobs/scheduler.js`.
 *
 * RESPONSIBILITY
 *   None yet - logs and exits. Will pull every Google Sheets connector
 *   owned by an active tenant and enqueue a sync job per connector.
 *
 * HOW TO EXTEND
 *   - Adjust the cron / enable flag in `.env.example`
 *     (`JOB_SHEET_SYNC_CRON`, `JOB_SHEET_SYNC_ENABLED`).
 *   - Implement the feature under `src/modules/connectors/google-sheets/`.
 */

import logger from '../utils/logger.js';
import { JOB } from '../config/constants.js';
import env from '../config/env.js';

export default {
  name: JOB.NAMES.SHEET_SYNC,
  cronExpression: env.jobs.sheetSync.cron,
  enabled: env.jobs.sheetSync.enabled,

  async handler() {
    // TODO(connectors): list Google Sheets connectors and enqueue sync jobs.
    logger.info('Sheet sync job executed (stub - nothing to do)');
  },
};
