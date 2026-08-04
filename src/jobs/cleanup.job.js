/**
 * Cleanup job (stub).
 *
 * WHY IT EXISTS
 *   Reserves the scheduled slot for housekeeping: expired tokens, orphaned
 *   uploads, stale sessions, old audit logs.
 *
 * RESPONSIBILITY
 *   None yet - logs and exits.
 *
 * HOW TO EXTEND
 *   - Adjust `JOB_CLEANUP_CRON` / `JOB_CLEANUP_ENABLED` in `.env.example`.
 *   - Batch deletes and use soft-delete / TTL indexes where possible; never
 *     delete in unbounded single queries.
 */

import logger from '../utils/logger.js';
import { JOB } from '../config/constants.js';

export default {
  name: JOB.NAMES.CLEANUP,
  cronExpression: process.env.JOB_CLEANUP_CRON || JOB.CRON.CLEANUP,
  enabled: process.env.JOB_CLEANUP_ENABLED === 'true',

  async handler() {
    // TODO(platform): expire sessions/tokens, purge stale uploads & logs.
    logger.info('Cleanup job executed (stub - nothing to do)');
  },
};
