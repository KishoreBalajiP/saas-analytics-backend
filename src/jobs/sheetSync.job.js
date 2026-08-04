/**
 * Google Sheets sync job (stub).
 *
 * WHY IT EXISTS
 *   Reserves the scheduled slot for the future connector sync feature
 *   (pull sheet data into the analytics store on an interval).
 *
 * RESPONSIBILITY
 *   None yet - logs and exits. Will iterate due connectors, fetch sheet
 *   ranges and upsert processed rows.
 *
 * HOW TO EXTEND
 *   - Adjust `JOB_SHEET_SYNC_CRON` / `JOB_SHEET_SYNC_ENABLED` in `.env.example`.
 *   - Implement under `src/modules/connectors/google-sheets/` - a
 *     `syncDueConnectors()` service is the intended call target, driving the
 *     connector lifecycle (`preview -> map -> ingest`).
 *   - Consider chunked processing + idempotent upserts for large sheets.
 */

import logger from '../utils/logger.js';
import { JOB } from '../config/constants.js';

export default {
  name: JOB.NAMES.SHEET_SYNC,
  cronExpression: process.env.JOB_SHEET_SYNC_CRON || JOB.CRON.SHEET_SYNC,
  enabled: process.env.JOB_SHEET_SYNC_ENABLED === 'true',

  async handler() {
    // TODO(connectors): find due connectors, sync their sheets, record results.
    logger.info('Sheet sync job executed (stub - nothing to do)');
  },
};
