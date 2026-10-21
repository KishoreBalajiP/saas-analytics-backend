/**
 * Email outbox drain job (roadmap 2.7).
 *
 * WHY IT EXISTS
 *   Every transactional email is a durable `OutboundEmail` record
 *   (`services/outbox.service.js`). New messages are usually sent right
 *   after they are enqueued; this job is the safety net that sends whatever
 *   is still due: messages whose first attempt failed (retried with
 *   exponential backoff), messages enqueued by a process that could not
 *   send, and messages whose sender crashed mid-send (expired lease).
 *
 * RESPONSIBILITY
 *   Claim up to OUTBOX_BATCH_SIZE due messages (atomically, so overlapping
 *   ticks and instances never send one twice), send them, and record each
 *   outcome: sent, retrying (next attempt scheduled), or dead (dead-lettered
 *   after OUTBOX_MAX_ATTEMPTS or a permanent failure). The counts are stored
 *   on the job run.
 *
 * HOW TO EXTEND
 *   - Cron / enable flag: `JOB_EMAIL_CRON` (default every minute) and
 *     `JOB_EMAIL_ENABLED` (default true: mail depends on it).
 *   - Retry policy: OUTBOX_MAX_ATTEMPTS, OUTBOX_BACKOFF_BASE_MS,
 *     OUTBOX_BACKOFF_MAX_MS.
 */

import logger from '../utils/logger.js';
import { JOB } from '../config/constants.js';
import env from '../config/env.js';
import outboxService from '../services/outbox.service.js';

export default {
  name: JOB.NAMES.EMAIL,
  cronExpression: env.jobs.email.cron,
  enabled: env.jobs.email.enabled,

  async handler({ instanceId } = {}) {
    const counts = await outboxService.drainOutbox({
      limit: env.outbox.batchSize,
      ...(instanceId ? { owner: instanceId } : {}),
    });
    if (counts.claimed > 0) logger.info(counts, 'Email outbox drained');
    return counts;
  },
};
