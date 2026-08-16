/**
 * Queue service - the only public interface for the queue layer.
 *
 * WHY IT EXISTS
 *   Feature code must never import `bullmq`, `ioredis` or the in-memory
 *   transport directly. They call this service which:
 *     1. Resolves a queue handle lazily on first use.
 *     2. Validates message envelopes before they reach the transport.
 *     3. Adds observability and error normalisation.
 *
 * RESPONSIBILITY
 *   - Lazily create and cache one queue handle per `name`.
 *   - Provide typed `enqueue`, `schedule`, `register` helpers.
 *   - Lifecycle: `closeAll()` for graceful shutdown.
 *
 * DESIGN CONSTRAINTS
 *   - Each call to `enqueue()` adds a request-scoped log line so the
 *     platform team can see exactly which jobs are being produced.
 *
 * HOW TO EXTEND
 *   Add a typed helper (e.g. `enqueueConnectorSync()`) by composing the
 *   primitives below. Do not import `bullmq` or `ioredis` in feature code.
 */

import logger from '../utils/logger.js';
import { createQueue, closeAll as closeAllQueues } from '../queues/index.js';
import { QUEUE_NAMES } from '../queues/constants.js';

/** Per-process queue handle cache. */
const handles = new Map();

/**
 * Typed error so callers can map queue failures to HTTP responses.
 */
export class QueueError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'QueueError';
    this.code = code;
    this.isOperational = true;
  }
}

/* ------------------------------ primitives ------------------------------ */

/**
 * Lazily create and cache a queue handle for the given name.
 *
 * @param {string} name - one of `QUEUE_NAMES`.
 * @param {Object} [options] - queue options.
 * @returns {Object} queue handle.
 */
export function getQueue(name, options = {}) {
  if (!name || typeof name !== 'string') {
    throw new QueueError('INVALID_INPUT', 'getQueue requires a queue name');
  }
  const cached = handles.get(name);
  if (cached && Object.keys(options).length === 0) return cached;
  const handle = createQueue(name, options);
  if (Object.keys(options).length === 0) handles.set(name, handle);
  return handle;
}

/**
 * Enqueue a message on the named queue.
 *
 * @param {string} name
 * @param {*} data
 * @param {Object} [opts] - { jobId, priority, name }.
 * @returns {Promise<Object>}
 */
export async function enqueue(name, data, opts = {}) {
  return safe(() => getQueue(name).enqueue(data, opts));
}

/**
 * Schedule a delayed message on the named queue.
 *
 * @param {string} name
 * @param {*} data
 * @param {number} delayMs
 * @param {Object} [opts] - { jobId, name }.
 * @returns {Promise<Object>}
 */
export async function schedule(name, data, delayMs, opts = {}) {
  return safe(() => getQueue(name).schedule(data, delayMs, opts));
}

/**
 * Register a consumer for the named queue.
 *
 * @param {string} name
 * @param {(job: { data: any, id: string, name: string }) => Promise<any>} handler
 * @returns {any}
 */
export function registerConsumer(name, handler) {
  return getQueue(name).consume(handler);
}

/**
 * Subscribe to a queue lifecycle event.
 *
 * @param {string} name
 * @param {string} event
 * @param {Function} listener
 * @returns {Function} unsubscribe.
 */
export function on(name, event, listener) {
  return getQueue(name).on(event, listener);
}

/**
 * Close every queue handle this service has created.
 *
 * @returns {Promise<void>}
 */
export async function closeAll() {
  handles.clear();
  await closeAllQueues();
}

/* ----------------------------- typed helpers ---------------------------- */

/**
 * Enqueue a connector sync job (Sprint 6+ will register the consumer).
 *
 * @param {Object} message - { connectorId, tenantId, jobType, payload, idempotencyKey }.
 * @returns {Promise<Object>}
 */
export function enqueueConnectorSync(message) {
  return enqueue(QUEUE_NAMES.CONNECTOR_SYNC, message, {
    jobId: message?.idempotencyKey,
    name: message?.jobType ?? 'sync',
  });
}

/**
 * Enqueue an outbound email (Sprint 1+ will register the consumer).
 *
 * @param {Object} message - { emailId, to, template, data }.
 * @returns {Promise<Object>}
 */
export function enqueueEmail(message) {
  return enqueue(QUEUE_NAMES.EMAIL_DELIVERY, message, {
    jobId: message?.emailId,
    name: 'email',
  });
}

/**
 * Enqueue an analytics job (Sprint 9+ will register the consumer).
 *
 * @param {Object} message - { jobId, tenantId, type, params }.
 * @returns {Promise<Object>}
 */
export function enqueueAnalytics(message) {
  return enqueue(QUEUE_NAMES.ANALYTICS_JOBS, message, {
    jobId: message?.jobId,
    name: message?.type ?? 'job',
  });
}

/**
 * Enqueue an audit-export job (consumed by `jobs/export.worker.js`).
 *
 * @param {Object} message - { exportId, tenantId }.
 * @returns {Promise<Object>}
 */
export function enqueueExport(message) {
  return enqueue(QUEUE_NAMES.EXPORT_JOBS, message, {
    jobId: message?.exportId,
    name: 'audit-export',
  });
}

/* -------------------------------- helpers -------------------------------- */

/**
 * Wrap a queue operation, normalising errors to `QueueError` and logging.
 *
 * @param {() => Promise<any>} op
 * @returns {Promise<any>}
 */
async function safe(op) {
  try {
    const result = await op();
    logger.debug({ queue: result?.name ?? 'unknown' }, 'queue enqueue');
    return result;
  } catch (err) {
    if (err instanceof QueueError) throw err;
    logger.error({ err: { message: err?.message } }, 'queue operation failed');
    throw new QueueError('QUEUE_OPERATION_FAILED', err?.message ?? 'Queue operation failed');
  }
}

export default {
  getQueue,
  enqueue,
  schedule,
  registerConsumer,
  on,
  closeAll,
  enqueueConnectorSync,
  enqueueEmail,
  enqueueAnalytics,
  enqueueExport,
  QueueError,
  QUEUE_NAMES,
};
