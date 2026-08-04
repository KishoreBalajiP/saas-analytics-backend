/**
 * In-memory queue implementation (single-instance).
 *
 * WHY IT EXISTS
 *   Dev and test environments should boot without Redis. The in-memory
 *   transport implements the same handle surface (`enqueue`, `schedule`,
 *   `consume`, `on`, `close`) as BullMQ so feature code never knows which
 *   transport it is using.
 *
 * RESPONSIBILITY
 *   - Buffer messages in an internal queue.
 *   - Dispatch to the registered consumer with the configured concurrency.
 *   - Retry with exponential backoff on failure.
 *   - Fire lifecycle events (`completed`, `failed`).
 *
 * DESIGN CONSTRAINTS
 *   - Single-instance only. Messages do not survive process restart.
 *   - Concurrency is implemented with a simple semaphore.
 *
 * HOW TO EXTEND
 *   Add new lifecycle events by calling `emit(event, payload)` after the
 *   relevant state transition.
 */

/**
 * Default options applied when the caller does not specify them.
 *
 * @returns {Object}
 */
export function getDefaultInMemoryOptions() {
  return {
    concurrency: 5,
    attempts: 3,
    backoffMs: 1000,
  };
}

/**
 * Create a fresh in-memory queue. Tests can call this directly to get a
 * fully isolated queue; `queues/index.js#createQueue` is the public entry
 * point used by feature code.
 *
 * @param {Object} [options]
 * @returns {Object} queue instance.
 */
export function createInMemoryQueue(options = {}) {
  const opts = { ...getDefaultInMemoryOptions(), ...options };
  /** @type {Array<{ id: string, name: string, data: any, attemptsMade: number, runAt: number, attempts: number }>} */
  const buffer = [];
  const listeners = new Map();
  let consumer = null;
  let closed = false;
  let running = 0;
  let nextId = 1;

  function emit(event, payload) {
    const list = listeners.get(event) ?? [];
    for (const fn of list) {
      try { fn(payload); } catch { /* listener errors are swallowed */ }
    }
  }

  function scheduleDrain() {
    if (closed) return;
    // Yield to the event loop so callers can `await enqueue()` and observe
    // a stable state.
    setImmediate(drain);
  }

  async function drain() {
    if (consumer === null) return;
    while (running < opts.concurrency && buffer.length > 0) {
      const now = Date.now();
      // Find the first message that is ready (runAt <= now).
      const idx = buffer.findIndex((m) => m.runAt <= now);
      if (idx === -1) {
        const next = buffer.reduce((acc, m) => Math.min(acc, m.runAt), Number.POSITIVE_INFINITY);
        if (Number.isFinite(next)) {
          setTimeout(drain, Math.max(0, next - now));
        }
        return;
      }
      const message = buffer.splice(idx, 1)[0];
      running += 1;
      runMessage(message).finally(() => {
        running -= 1;
        scheduleDrain();
      });
    }
  }

  async function runMessage(message) {
    if (!consumer) return;
    try {
      const result = await consumer({ id: message.id, name: message.name, data: message.data, attemptsMade: message.attemptsMade });
      emit('completed', { id: message.id, name: message.name, data: message.data, result });
    } catch (err) {
      const attemptsMade = message.attemptsMade + 1;
      if (attemptsMade >= message.attempts) {
        emit('failed', { id: message.id, name: message.name, data: message.data, error: err });
        return;
      }
      // Re-enqueue with exponential backoff.
      const delay = opts.backoffMs * 2 ** (attemptsMade - 1);
      buffer.push({
        ...message,
        attemptsMade,
        runAt: Date.now() + delay,
      });
      emit('retry', { id: message.id, attemptsMade, delay });
    }
  }

  return {
    async enqueue(data, { name = 'job', jobId, attempts = opts.attempts } = {}) {
      if (closed) throw new Error('Queue is closed');
      const id = jobId ?? `mem_${nextId++}`;
      buffer.push({
        id,
        name,
        data,
        attempts,
        attemptsMade: 0,
        runAt: Date.now(),
      });
      scheduleDrain();
      return { id, name };
    },

    async schedule(data, delayMs, { name = 'job', jobId, attempts = opts.attempts } = {}) {
      if (closed) throw new Error('Queue is closed');
      const id = jobId ?? `mem_${nextId++}`;
      buffer.push({
        id,
        name,
        data,
        attempts,
        attemptsMade: 0,
        runAt: Date.now() + Math.max(0, Number(delayMs) || 0),
      });
      scheduleDrain();
      return { id, name };
    },

    consume(handler) {
      if (typeof handler !== 'function') {
        throw new Error('consume() requires a handler function');
      }
      consumer = handler;
      scheduleDrain();
      return handler;
    },

    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return () => {
        const remaining = (listeners.get(event) ?? []).filter((l) => l !== listener);
        listeners.set(event, remaining);
      };
    },

    async close() {
      closed = true;
      consumer = null;
      buffer.length = 0;
      listeners.clear();
    },
  };
}

export default createInMemoryQueue;
