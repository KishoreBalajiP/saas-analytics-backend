/**
 * Connector sync queue contract (placeholder).
 *
 * WHY IT EXISTS
 *   Connector ingestion (preview, ingest, full sync) can be large and slow;
 *   it must run through a queue, not inline in an HTTP request. This module
 *   documents that queue's contract so Phase 2 can wire the real transport.
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

const QUEUE_NAME = QUEUE_NAMES.CONNECTOR_SYNC;

/**
 * Register the consumer that will process connector sync messages.
 * PLACEHOLDER - fails closed. Future implementation resolves the connector
 * via `ConnectorRegistry` and runs the shared sync engine.
 *
 * @param {Function} [_handler] - future: async ({ io }, message) => result
 */
export async function registerConsumer(_handler) {
  throw new Error(`queue "${QUEUE_NAME}".registerConsumer is not implemented yet (Phase 1.1 placeholder)`);
}

export default Object.freeze({
  name: QUEUE_NAME,
  description:
    'Runs connector lifecycle jobs (preview, ingest, full sync) off the HTTP hot path.',
  defaultOptions: Object.freeze({
    concurrency: 5,
    attempts: 5,
    backoffMs: 2000,
  }),
  registerConsumer,
});
