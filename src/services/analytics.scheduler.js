/**
 * Analytics Scheduler (Sprint 5 - implemented; roadmap 1.5).
 *
 * PURPOSE
 *   Owns everything that happens OFF the HTTP hot path for analytics: async
 *   export jobs. A request comes in on `POST /analytics/export`, a `pending`
 *   export record (AnalyticsQuery, kind `export`) is persisted and a job is
 *   enqueued on the analytics queue; the analytics worker
 *   (`jobs/analytics.worker.js`, type `export`) writes the artefact through
 *   `analyticsExport.service.processExport`.
 *
 * RESPONSIBILITY
 *   - scheduleExport({ tenantId, actorId, format, query })
 *       -> { exportId, jobId, accepted, queued, status: 'pending', format }.
 *   - registerConsumer(handler) -> wire a worker to the analytics queue.
 *
 * MESSAGE SHAPE (produced here, consumed by the analytics worker):
 *   { jobId: 'export-<exportId>', tenantId, type: 'export', params: { exportId } }
 */

import { getQueue } from './queue.service.js';
import { QUEUE_NAMES } from '../queues/constants.js';
import * as analyticsExportService from './analyticsExport.service.js';

/**
 * Persist a `pending` export record and enqueue its job. `query` must
 * already be validated (`analyticsExport.service.validateExportRequest`).
 */
export async function scheduleExport({ tenantId, actorId, format = 'csv', query = {} }) {
  return analyticsExportService.scheduleExport({ tenantId, actorId, format, query });
}

/**
 * Register the worker that processes analytics jobs.
 *
 * @param {(job: { data: object, id: string, name: string }) => Promise<any>} handler
 * @returns {any} consumer handle (platform-dependent)
 */
export function registerConsumer(handler) {
  return getQueue(QUEUE_NAMES.ANALYTICS_JOBS).consume(handler);
}

export default { scheduleExport, registerConsumer };
