/**
 * Analytics Worker (Sprint 7).
 *
 * WHY IT EXISTS
 *   The analytics queue (`ANALYTICS_JOBS`) previously had no consumer - jobs
 *   (exports, report runs, alert evaluations) were enqueued but never ran.
 *   This module registers the single combined consumer for that queue and
 *   dispatches by job `type`.
 *
 * RESPONSIBILITY
 *   - `report`  -> `report.service.processRun` (generate artefact + persist)
 *   - `alert`   -> `alert.service.evaluate` (threshold check + notify)
 *   - `export`  -> intentionally ignored (export completion is a later sprint;
 *                  preserving the prior no-op behaviour)
 *
 * Errors are swallowed per-job so one bad job never kills the consumer.
 */

import logger from '../utils/logger.js';
import * as queueService from '../services/queue.service.js';
import { QUEUE_NAMES } from '../queues/constants.js';
import * as reportService from '../services/report.service.js';
import * as alertService from '../services/alert.service.js';

let registered = false;

/**
 * Register the analytics queue consumer exactly once per process.
 */
export function registerAnalyticsWorker() {
  if (registered) return;
  registered = true;
  queueService.registerConsumer(QUEUE_NAMES.ANALYTICS_JOBS, async (job) => {
    const { type, tenantId, params } = job?.data || {};
    try {
      if (type === 'report') {
        await reportService.processRun({ tenantId, ...(params || {}) });
      } else if (type === 'alert') {
        await alertService.evaluate({ tenantId, ...(params || {}) });
      } else {
        logger.debug({ type }, 'analytics job type not handled by worker');
      }
    } catch (err) {
      logger.error({ err: { message: err?.message }, type }, 'analytics job failed');
    }
  });
}

export default { registerAnalyticsWorker };
