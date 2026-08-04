/**
 * Email queue job (stub).
 *
 * WHY IT EXISTS
 *   Reserves the scheduled slot for the future outbound email pipeline
 *   (transactional mail + alert notifications) as a retrying queue worker.
 *
 * RESPONSIBILITY
 *   None yet - logs and exits. Will drain queued email records, render
 *   templates from `src/templates/emails/` and send via `config/mail.js`.
 *
 * HOW TO EXTEND
 *   - Adjust `JOB_EMAIL_CRON` / `JOB_EMAIL_ENABLED` in `.env.example`.
 *   - When mail sending lands, cap the batch size per tick and mark records
 *     as `queued -> sending -> sent|failed` to survive process restarts.
 */

import logger from '../utils/logger.js';
import { JOB } from '../config/constants.js';

export default {
  name: JOB.NAMES.EMAIL,
  cronExpression: process.env.JOB_EMAIL_CRON || JOB.CRON.EMAIL,
  enabled: process.env.JOB_EMAIL_ENABLED === 'true',

  async handler() {
    // TODO(alerts): drain the email queue in batches, render + send.
    logger.info('Email queue job executed (stub - nothing to do)');
  },
};
