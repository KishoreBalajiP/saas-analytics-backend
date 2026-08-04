/**
 * Queue framework facade.
 *
 * WHY IT EXISTS
 *   Connector synchronization, email delivery and analytics jobs must run
 *   asynchronously through queues so HTTP requests stay fast and work
 *   survives crashes. This facade defines the queue contract; the concrete
 *   transport (in-memory for dev/tests, BullMQ on Redis for production) is
 *   selected by configuration.
 *
 * RESPONSIBILITY
 *   - Expose canonical queue names.
 *   - Provide `createQueue(name)` returning a handle with a stable method
 *     surface (`enqueue`, `schedule`, `consume`, `on`, `close`).
 *   - Re-export the per-queue contracts in this folder.
 *
 * HOW TO EXTEND
 *   Add a new queue here, create `queues/<name>.queue.js`, and re-export it.
 *
 *   ```js
 *   import { createQueue } from '../queues/index.js';
 *   const syncQueue = createQueue(QUEUE_NAMES.CONNECTOR_SYNC, { concurrency: 5 });
 *   await syncQueue.enqueue({ connectorId, tenantId, jobType: 'ingest', payload });
 *   ```
 */

import { Queue as BullQueue, Worker as BullWorker } from 'bullmq';
import IORedis from 'ioredis';
import env from '../config/env.js';
import { QUEUE_NAMES } from './constants.js';
import { createInMemoryQueue, getDefaultInMemoryOptions } from './memory.queue.js';
import connectorQueueContract from './connector.queue.js';
import emailQueueContract from './email.queue.js';
import analyticsQueueContract from './analytics.queue.js';

const TRANSPORT_INMEMORY = 'memory';
const TRANSPORT_BULLMQ = 'bullmq';

/** In-memory registry for graceful shutdown. */
const registry = new Map();

/**
 * Create a queue handle for the given name. The transport is chosen by the
 * `transport` option, defaulting to BullMQ when REDIS_URL is set, otherwise
 * to the in-memory transport.
 *
 * @param {string} name - one of `QUEUE_NAMES`.
 * @param {Object} [options] - { concurrency, attempts, backoffMs, transport }.
 * @returns {Object} queue handle.
 */
export function createQueue(name, options = {}) {
  if (!name || typeof name !== 'string') {
    throw new Error('createQueue requires a queue name');
  }
  const transport = options.transport ?? (env.redis?.enabled ? TRANSPORT_BULLMQ : TRANSPORT_INMEMORY);
  switch (transport) {
    case TRANSPORT_INMEMORY:
      return buildInMemoryHandle(name, options);
    case TRANSPORT_BULLMQ:
      return buildBullMqHandle(name, options);
    default:
      throw new Error(`Unknown queue transport "${transport}"`);
  }
}

/**
 * Close every queue created by this process. Used by graceful shutdown.
 *
 * @returns {Promise<void>}
 */
export async function closeAll() {
  const handles = Array.from(registry.values());
  registry.clear();
  await Promise.all(handles.map((h) => Promise.resolve(h.close?.()).catch(() => {})));
}

/* ----------------------------- internals -------------------------------- */

/**
 * Build an in-memory queue handle.
 *
 * @param {string} name
 * @param {Object} options
 * @returns {Object}
 */
function buildInMemoryHandle(name, options) {
  const q = createInMemoryQueue({ ...getDefaultInMemoryOptions(), ...options });
  const handle = Object.freeze({
    name,
    transport: TRANSPORT_INMEMORY,
    options,
    enqueue: (data, opts) => q.enqueue(data, opts),
    schedule: (data, delayMs, opts) => q.schedule(data, delayMs, opts),
    consume: (handler) => q.consume(handler),
    on: (event, listener) => q.on(event, listener),
    close: () => q.close(),
  });
  registry.set(name, handle);
  return handle;
}

/**
 * Build a BullMQ-backed queue handle.
 *
 * @param {string} name
 * @param {Object} options
 * @returns {Object}
 */
function buildBullMqHandle(name, options) {
  if (!env?.redis?.url) {
    throw new Error(`Queue "${name}" requires REDIS_URL to be set`);
  }
  const connection = new IORedis(env.redis.url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
  const queue = new BullQueue(name, {
    connection,
    defaultJobOptions: {
      attempts: Number.isInteger(options.attempts) ? options.attempts : 3,
      backoff: {
        type: 'exponential',
        delay: Number.isInteger(options.backoffMs) ? options.backoffMs : 2000,
      },
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });

  let worker = null;

  /**
   * Start a worker for this queue. Only one worker per queue per process.
   *
   * @param {(job: { data: any, id: string, name: string }) => Promise<any>} handler
   */
  function consume(handler) {
    if (worker) {
      throw new Error(`Queue "${name}" already has a worker attached`);
    }
    if (typeof handler !== 'function') {
      throw new Error('consume() requires a handler function');
    }
    worker = new BullWorker(
      name,
      async (job) => handler({ data: job.data, id: job.id, name: job.name }),
      {
        connection,
        concurrency: Number.isInteger(options.concurrency) ? options.concurrency : 5,
      },
    );
    return worker;
  }

  const handle = Object.freeze({
    name,
    transport: TRANSPORT_BULLMQ,
    options,
    async enqueue(data, opts = {}) {
      return queue.add(opts.name ?? 'job', data, {
        jobId: opts.jobId,
        priority: opts.priority,
      });
    },
    async schedule(data, delayMs, opts = {}) {
      return queue.add(opts.name ?? 'job', data, {
        jobId: opts.jobId,
        delay: Math.max(0, Number(delayMs) || 0),
      });
    },
    consume,
    on(event, listener) {
      queue.on(event, listener);
      return () => queue.off(event, listener);
    },
    async close() {
      try { await worker?.close(); } catch { /* ignore */ }
      try { await queue.close(); } catch { /* ignore */ }
      try { await connection.quit(); } catch { connection.disconnect(); }
    },
  });
  registry.set(name, handle);
  return handle;
}

export { QUEUE_NAMES };
export { default as connectorQueueContract } from './connector.queue.js';
export { default as emailQueueContract } from './email.queue.js';
export { default as analyticsQueueContract } from './analytics.queue.js';

export default {
  QUEUE_NAMES,
  createQueue,
  closeAll,
};
