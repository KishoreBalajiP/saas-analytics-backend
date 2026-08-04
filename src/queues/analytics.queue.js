/**
 * Analytics jobs queue contract.
 *
 * WHY IT EXISTS
 *   Long-running analytics work - heavy aggregations, exports, recomputations
 *   - must not block HTTP requests. This queue is the future home for those
 *   jobs, executed by workers with retry + progress tracking.
 *
 * RESPONSIBILITY
 *   - Define the queue name and message shape.
 *   - Provide the consumer registration point (fail-closed stub for now).
 *
 * MESSAGE SHAPE (documented, not enforced):
 *   {
 *     jobId,    // persisted job record id (progress + results)
 *     tenantId, // owning tenant (scoping + audit)
 *     type,     // 'aggregation' | 'export' | 'recompute'
 *     params,   // query/export parameters
 *   }
 */

import { QUEUE_NAMES } from './constants.js';
import { createQueue } from './index.js';

const QUEUE_NAME = QUEUE_NAMES.ANALYTICS_JOBS;
const DEFAULT_OPTIONS = Object.freeze({
  concurrency: 3,
  attempts: 3,
  backoffMs: 3000,
});

let cachedHandle = null;

/**
 * Lazily create the queue handle (one per process).
 *
 * @returns {Object} queue handle.
 */
export function getQueue() {
  if (cachedHandle) return cachedHandle;
  cachedHandle = createQueue(QUEUE_NAME, DEFAULT_OPTIONS);
  return cachedHandle;
}

/**
 * Register the consumer that processes analytics jobs. Sprint 0 is a
 * fail-closed placeholder; Sprint 9 wires the real handler that runs the
 * aggregation / export and pushes results through the websocket layer +
 * storage.
 *
 * @param {Function} [_handler] - future: async ({ io }, message) => result
 * @throws {Error} always in Sprint 0.
 */
export async function registerConsumer(_handler) {
  throw new Error(`queue "${QUEUE_NAME}".registerConsumer is not implemented yet (Phase 2 - Sprint 9)`);
}

export default Object.freeze({
  name: QUEUE_NAME,
  description: 'Executes long-running analytics computations and exports off the HTTP hot path.',
  defaultOptions: DEFAULT_OPTIONS,
  getQueue,
  registerConsumer,
});
