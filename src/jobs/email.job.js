/**
 * Email queue draining job (stub).
 *
 * WHY IT EXISTS
 *   Reserves the scheduled slot for periodic polling of the email delivery
 *   queue and demonstrates the job contract consumed by `jobs/scheduler.js`.
 *
 * RESPONSIBILITY
 *   None yet - logs and exits. Sprint 1 will subscribe a BullMQ worker to
 *   `queues/email.queue.js` and call it directly; this cron becomes the
 *   fallback / safety net.
 *
 * HOW TO EXTEND
 *   - Adjust the cron / enable flag in `.env.example`
 *     (`JOB_EMAIL_CRON`, `JOB_EMAIL_ENABLED`).
 *   - Implement the feature under `src/services/email.service.js`.
 */

import logger from '../utils/logger.js';
import { JOB } from '../config/constants.js';
import env from '../config/env.js';

export default {
  name: JOB.NAMES.EMAIL,
  cronExpression: env.jobs.email.cron,
  enabled: env.jobs.email.enabled,

  async handler() {
    // TODO(email): drain queued emails via services/email.service.js.
    logger.info('Email queue drain job executed (stub - nothing to do)');
  },
};
