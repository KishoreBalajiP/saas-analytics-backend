/**
 * Cleanup job (stub).
 *
 * WHY IT EXISTS
 *   Reserves the scheduled slot for periodic retention / housekeeping
 *   and demonstrates the job contract consumed by `jobs/scheduler.js`.
 *
 * RESPONSIBILITY
 *   None yet - logs and exits. Sprint 7 wires the real handler that
 *   archives audit / access logs past their retention window and hard-
 *   deletes records the compliance cron approves for purge.
 *
 * HOW TO EXTEND
 *   - Adjust the cron / enable flag in `.env.example`
 *     (`JOB_CLEANUP_CRON`, `JOB_CLEANUP_ENABLED`).
 *   - Implement the feature under `src/modules/governance/`.
 */

import logger from '../utils/logger.js';
import { JOB } from '../config/constants.js';
import env from '../config/env.js';

export default {
  name: JOB.NAMES.CLEANUP,
  cronExpression: env.jobs.cleanup.cron,
  enabled: env.jobs.cleanup.enabled,

  async handler() {
    // TODO(governance): enforce retention policies.
    logger.info('Cleanup job executed (stub - nothing to do)');
  },
};
