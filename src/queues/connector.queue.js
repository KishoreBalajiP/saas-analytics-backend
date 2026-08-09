/**
 * Connector sync queue contract (Sprint 4 - implemented).
 *
 * WHY IT EXISTS
 *   Connector ingestion (CSV stream-parse, webhook record batches) must run
 *   through a queue, not inline in an HTTP request. This module owns the
 *   queue handle and its consumer: the consumer resolves the connector via
 *   `ConnectorRegistry`, runs the shared sync engine and persists
 *   `ConnectorRow`s idempotently.
 *
 * MESSAGE SHAPE (documented, not enforced):
 *   {
 *     connectorId,    // persisted connector record id
 *     tenantId,       // owning tenant (scoping + audit)
 *     jobType,        // 'preview' | 'ingest' | 'sync'
 *     payload,        // CSV: { buffer, filename } (base64) |
 *                     // webhook: { records: Array }
 *     idempotencyKey, // dedupe on retry - derived from connectorId+jobType+cursor
 *   }
 *
 * HOW TO EXTEND
 *   Future providers keep the same contract; only `payload` differs. The
 *   worker handler lives in `services/connector.service.js#processSyncMessage`
 *   and is wired here to avoid feature code touching the queue internals.
 */

import { QUEUE_NAMES } from './constants.js';
import { createQueue } from './index.js';

export const QUEUE_NAME = QUEUE_NAMES.CONNECTOR_SYNC;
export const DEFAULT_OPTIONS = Object.freeze({
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
 * Feature-code facade for enqueueing connector sync work.
 * Imported by `services/connector.service.js`.
 */
export const connectorQueue = {
  get name() {
    return QUEUE_NAME;
  },
  async enqueue(data, options) {
    return getQueue().enqueue(data, options);
  },
  async schedule(data, delayMs, options) {
    return getQueue().schedule(data, delayMs, options);
  },
  getQueue,
};

/**
 * Register the connector sync consumer. The default handler loads the
 * service lazily (avoids a module-load cycle between service -> queue ->
 * service) and runs the provider pipeline.
 *
 * @param {Function} [handler] - override for tests: async (job) => result.
 * @returns {Function} the registered handler.
 */
export function registerConsumer(handler) {
  const actual =
    typeof handler === 'function'
      ? handler
      : async (job) => {
          const { processSyncMessage } = await import('../services/connector.service.js');
          return processSyncMessage(job);
        };

  const queue = getQueue();
  if (typeof queue.consume !== 'function') {
    throw new Error(`Queue "${QUEUE_NAME}" has no consumer surface`);
  }
  queue.consume(actual);
  return actual;
}

export default Object.freeze({
  name: QUEUE_NAME,
  description:
    'Runs connector lifecycle jobs (preview, ingest, full sync) off the HTTP hot path.',
  defaultOptions: DEFAULT_OPTIONS,
  getQueue,
  connectorQueue,
  registerConsumer,
});

/** Alias used by `server.js` boot wiring. */
export const registerConnectorConsumer = registerConsumer;
