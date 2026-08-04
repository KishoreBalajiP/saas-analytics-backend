/**
 * Connector sync queue contract.
 *
 * WHY IT EXISTS
 *   Connector ingestion (preview, ingest, full sync) can be large and slow;
 *   it must run through a queue, not inline in an HTTP request. This module
 *   documents that queue's contract and registers its consumer.
 *
 * RESPONSIBILITY
 *   - Define the queue name and the exact message shape.
 *   - Define sane defaults (retries, backoff, concurrency).
 *   - Provide the consumer registration point (fail-closed stub for now).
 *
 * MESSAGE SHAPE (documented, not enforced):
 *   {
 *     connectorId,    // persisted connector record id
 *     tenantId,       // owning tenant (scoping + audit)
 *     jobType,        // 'preview' | 'ingest' | 'sync'
 *     payload,        // connector-specific options (fieldMapping, since, ...)
 *     idempotencyKey, // dedupe on retry - derived from connectorId+jobType+cursor
 *   }
 */

import { QUEUE_NAMES } from './constants.js';
import { createQueue } from './index.js';

const QUEUE_NAME = QUEUE_NAMES.CONNECTOR_SYNC;
const DEFAULT_OPTIONS = Object.freeze({
  concurrency: 5,
  attempts: 5,
  backoffMs: 2000,
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
 * Register the consumer that will process connector sync messages. The
 * Sprint 0 implementation is a fail-closed placeholder; Sprint 6 wires the
 * real handler that resolves the connector via `ConnectorRegistry`.
 *
 * @param {Function} [_handler] - future: async ({ io }, message) => result
 * @throws {Error} always in Sprint 0.
 */
export async function registerConsumer(_handler) {
  throw new Error(`queue "${QUEUE_NAME}".registerConsumer is not implemented yet (Phase 2 - Sprint 6)`);
}

export default Object.freeze({
  name: QUEUE_NAME,
  description:
    'Runs connector lifecycle jobs (preview, ingest, full sync) off the HTTP hot path.',
  defaultOptions: DEFAULT_OPTIONS,
  getQueue,
  registerConsumer,
});
