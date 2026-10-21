/**
 * Queue errors and the producer guard (roadmap 1.4, finding ops2.13).
 *
 * WHY IT EXISTS
 *   A BullMQ producer awaiting `queue.add()` can hang for as long as Redis is
 *   unreachable, holding the HTTP request open. Every enqueue therefore runs
 *   through `guardProducer`, which bounds the wait and converts any failure
 *   into a typed `QueueError` (HTTP 503) that the global error handler turns
 *   into the standard envelope: `{ code: 'QUEUE_TIMEOUT' | 'QUEUE_UNAVAILABLE' }`.
 *
 *   This is a leaf module (no imports from the queue facade) so the facade,
 *   the queue contracts and `services/queue.service.js` can all use it
 *   without an import cycle.
 */

export const QUEUE_ERROR_CODES = Object.freeze({
  TIMEOUT: 'QUEUE_TIMEOUT',
  UNAVAILABLE: 'QUEUE_UNAVAILABLE',
  INVALID_INPUT: 'INVALID_INPUT',
  OPERATION_FAILED: 'QUEUE_OPERATION_FAILED',
});

/**
 * Typed error so callers (and the error middleware) can map queue failures
 * to HTTP responses. `isOperational` + `statusCode` make the global handler
 * return `statusCode`/`code` instead of a generic 500.
 */
export class QueueError extends Error {
  constructor(code, message, { statusCode, queue = null, cause } = {}) {
    super(message);
    this.name = 'QueueError';
    this.code = code;
    this.queue = queue;
    this.statusCode = statusCode ?? (code === QUEUE_ERROR_CODES.INVALID_INPUT ? 500 : 503);
    this.isOperational = true;
    if (cause) this.cause = cause;
  }
}

/**
 * Run a producer operation with a time limit and typed errors.
 *
 * @template T
 * @param {() => Promise<T>} op
 * @param {Object} options
 * @param {number} options.timeoutMs - give up after this many ms (<= 0 disables).
 * @param {string} [options.queue] - queue name (for the error).
 * @returns {Promise<T>}
 */
export async function guardProducer(op, { timeoutMs, queue = null } = {}) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    if (!(timeoutMs > 0)) return;
    timer = setTimeout(() => {
      reject(new QueueError(
        QUEUE_ERROR_CODES.TIMEOUT,
        'The job queue did not accept the job in time; please retry shortly',
        { queue },
      ));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve().then(op), timeout]);
  } catch (err) {
    if (err instanceof QueueError) throw err;
    throw new QueueError(
      QUEUE_ERROR_CODES.UNAVAILABLE,
      'The job queue is unavailable; please retry shortly',
      { queue, cause: err },
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export default { QueueError, QUEUE_ERROR_CODES, guardProducer };
