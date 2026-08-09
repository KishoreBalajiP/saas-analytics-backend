/**
 * Analytics Scheduler (Sprint 5 - implemented).
 *
 * PURPOSE
 *   Owns everything that happens OFF the HTTP hot path for analytics: async
 *   export jobs. A request comes in on `POST /analytics/export`, the service
 *   persists a `pending` AnalyticsQuery record, and this module enqueues a
 *   job on the analytics queue so a worker can run it later with retries.
 *
 * RESPONSIBILITY
 *   - scheduleExport({ tenantId, actorId, params }) -> { jobId, accepted }.
 *   - registerConsumer(handler) -> wire a worker to the analytics queue.
 *
 * MESSAGE SHAPE (produced here, consumed by the Sprint 9 worker):
 *   { jobId, tenantId, type: 'export', params }
 */

import ApiError from '../utils/ApiError.js';
import * as analyticsRepository from '../repositories/analytics.repository.js';
import { enqueueAnalytics, getQueue } from './queue.service.js';
import { QUEUE_NAMES } from '../queues/constants.js';

/**
 * Persist a `pending` query record and enqueue an async export job. The
 * returned `jobId` doubles as the AnalyticsQuery id so the worker can update
 * the run record on completion.
 */
export async function scheduleExport({ tenantId, actorId, params = {} }) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');

  const query = await analyticsRepository.createQuery({
    tenantId,
    createdBy: actorId ?? null,
    params,
    status: 'pending',
    connectorIds: params.connectorIds || [],
    resultMeta: {},
  });

  const job = await enqueueAnalytics({
    jobId: String(query._id),
    tenantId,
    type: 'export',
    params,
  });

  return {
    jobId: String(query._id),
    accepted: true,
    queued: true,
    workerJobId: job?.id ?? null,
  };
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
