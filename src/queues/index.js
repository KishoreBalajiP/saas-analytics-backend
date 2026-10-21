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
 *     surface (`enqueue`, `schedule`, `consume`, `on`, `stats`, `ping`,
 *     `close`).
 *   - Bound every producer call (`QUEUE_PRODUCER_TIMEOUT_MS`) and convert
 *     failures to a typed `QueueError` (503) so a Redis outage never hangs a
 *     request (finding ops2.13).
 *   - Drain on shutdown: `closeAll({ drainTimeoutMs })` stops consumers from
 *     taking new jobs, waits for in-flight ones (bounded), then closes the
 *     queues and their Redis connections.
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
import logger from '../utils/logger.js';
import { QUEUE_NAMES } from './constants.js';
import { createInMemoryQueue, getDefaultInMemoryOptions } from './memory.queue.js';
import { QueueError, QUEUE_ERROR_CODES, guardProducer } from './errors.js';
import connectorQueueContract from './connector.queue.js';
import emailQueueContract from './email.queue.js';
import analyticsQueueContract from './analytics.queue.js';
// observability: trace propagation + job metrics for every transport.
import { withTraceCarrier, instrumentConsumer } from './instrument.js';

const TRANSPORT_INMEMORY = 'memory';
const TRANSPORT_BULLMQ = 'bullmq';

/** Every handle this process created (several may share a queue name). */
const registry = new Set();

/**
 * Create a queue handle for the given name. The transport is chosen by the
 * `transport` option, defaulting to BullMQ when REDIS_URL is set, otherwise
 * to the in-memory transport.
 *
 * @param {string} name - one of `QUEUE_NAMES`.
 * @param {Object} [options] - { concurrency, attempts, backoffMs, transport,
 *   producerTimeoutMs, redisUrl, drivers, closeStageMs } (`drivers` =
 *   { Queue, Worker, Redis } and `closeStageMs` injectable for tests).
 * @returns {Object} queue handle.
 */
export function createQueue(name, options = {}) {
  if (!name || typeof name !== 'string') {
    throw new QueueError(QUEUE_ERROR_CODES.INVALID_INPUT, 'createQueue requires a queue name');
  }
  const transport = options.transport ?? (env.redis?.enabled ? TRANSPORT_BULLMQ : TRANSPORT_INMEMORY);
  switch (transport) {
    case TRANSPORT_INMEMORY:
      return buildInMemoryHandle(name, options);
    case TRANSPORT_BULLMQ:
      return buildBullMqHandle(name, options);
    default:
      throw new QueueError(QUEUE_ERROR_CODES.INVALID_INPUT, `Unknown queue transport "${transport}"`);
  }
}

/**
 * Close every queue created by this process. Used by graceful shutdown.
 * Consumers stop taking new jobs, in-flight jobs get up to `drainTimeoutMs`
 * to finish, then queues and Redis connections close.
 *
 * @param {Object} [options]
 * @param {number} [options.drainTimeoutMs=0]
 * @returns {Promise<Array<{ name: string, transport: string, drained: boolean }>>}
 */
export async function closeAll({ drainTimeoutMs = 0 } = {}) {
  const handles = Array.from(registry);
  registry.clear();
  const results = await Promise.all(handles.map(async (h) => {
    try {
      const outcome = await h.close?.({ drainTimeoutMs });
      return { name: h.name, transport: h.transport, drained: outcome?.drained !== false };
    } catch (err) {
      logger.warn({ err: { message: err?.message }, queue: h.name }, 'queue close failed');
      return { name: h.name, transport: h.transport, drained: false };
    }
  }));
  return results;
}

/**
 * Counts for every queue this process created (monitoring). Each probe is
 * bounded so an unreachable Redis reports an error instead of hanging.
 *
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=2000]
 * @returns {Promise<Array<Object>>}
 */
export async function getQueueStats({ timeoutMs = 2000, ensureNames = [] } = {}) {
  // With BullMQ the counts live in Redis, so a process that never touched a
  // queue (a web instance asking about the worker's queues) can still read
  // them through a producer-only handle.
  if (env.redis?.enabled) {
    const known = new Set(Array.from(registry, (h) => h.name));
    for (const name of ensureNames) {
      if (!known.has(name)) createQueue(name);
    }
  }
  const handles = Array.from(registry);
  const results = await Promise.all(handles.map(async (h) => {
    try {
      const stats = await guardProducer(() => h.stats(), { timeoutMs, queue: h.name });
      return { name: h.name, transport: h.transport, status: 'ok', ...stats };
    } catch (err) {
      return { name: h.name, transport: h.transport, status: 'down', error: err?.code ?? 'QUEUE_UNAVAILABLE' };
    }
  }));
  return mergeByName(results);
}

/**
 * One entry per queue name. In-memory handles are separate queues, so their
 * counts add up; BullMQ handles of one name read the same Redis counts, so
 * one reading is kept. `consuming` is true when any handle consumes.
 */
function mergeByName(results) {
  const merged = new Map();
  for (const entry of results) {
    const prev = merged.get(entry.name);
    if (!prev) {
      merged.set(entry.name, { ...entry });
      continue;
    }
    if (entry.status === 'down') prev.status = 'down';
    prev.consuming = Boolean(prev.consuming || entry.consuming);
    if (entry.transport === TRANSPORT_INMEMORY) {
      for (const key of ['waiting', 'active', 'delayed', 'failed', 'completed']) {
        if (typeof entry[key] === 'number') prev[key] = (prev[key] ?? 0) + entry[key];
      }
    }
  }
  return Array.from(merged.values());
}

/* ----------------------------- internals -------------------------------- */

/** Budget for each close stage after the drain (force close, queue, QUIT). */
const CLOSE_STAGE_MS = 1000;

/**
 * Wait for `promise` at most `ms`. Resolves 'done' (settled either way) or
 * 'timeout'; never rejects. A closing transport that cannot reach Redis must
 * not hold shutdown.
 */
async function settleWithin(promise, ms) {
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(0, ms));
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve(promise).then(() => 'done', () => 'done'), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wait (at most `ms`) for an ioredis connection that is still connecting to
 * become ready. With `enableOfflineQueue: false` a command sent before then
 * fails at once, so the first readiness probe after boot would report the
 * queue down although Redis is fine. Never leaves a listener behind.
 */
function whenReady(connection, ms) {
  const status = connection?.status;
  if (!status || status === 'ready' || typeof connection.once !== 'function') return Promise.resolve();
  if (status === 'end') return Promise.reject(new Error('Redis connection is closed'));
  return new Promise((resolve, reject) => {
    const onReady = () => { cleanup(); resolve(); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Redis connection is not ready')); }, Math.max(1, ms));
    timer.unref?.();
    function cleanup() {
      clearTimeout(timer);
      connection.removeListener?.('ready', onReady);
    }
    connection.once('ready', onReady);
  });
}

function producerTimeout(options) {
  const value = options.producerTimeoutMs ?? env.queue?.producerTimeoutMs;
  return Number.isFinite(value) ? value : 5000;
}

/**
 * Build an in-memory queue handle.
 *
 * @param {string} name
 * @param {Object} options
 * @returns {Object}
 */
function buildInMemoryHandle(name, options) {
  const q = createInMemoryQueue({ ...getDefaultInMemoryOptions(), ...options });
  const timeoutMs = producerTimeout(options);
  const handle = Object.freeze({
    name,
    transport: TRANSPORT_INMEMORY,
    options,
    enqueue: (data, opts) => guardProducer(() => q.enqueue(withTraceCarrier(data), opts), { timeoutMs, queue: name }),
    schedule: (data, delayMs, opts) => guardProducer(() => q.schedule(withTraceCarrier(data), delayMs, opts), { timeoutMs, queue: name }),
    consume: (handler) => q.consume(instrumentConsumer(name, handler)),
    on: (event, listener) => q.on(event, listener),
    stats: async () => q.stats(),
    // In-process transport: reachable whenever the process is.
    ping: async () => 'PONG',
    async close({ drainTimeoutMs = 0 } = {}) {
      registry.delete(handle);
      return q.close({ drainTimeoutMs });
    },
  });
  registry.add(handle);
  return handle;
}

/**
 * Build a BullMQ-backed queue handle.
 *
 * Producers and the worker use SEPARATE Redis connections: the producer
 * connection fails fast (`enableOfflineQueue: false`, one retry) so a Redis
 * outage surfaces as a typed 503 within `producerTimeoutMs`; the worker
 * connection keeps BullMQ's required `maxRetriesPerRequest: null` and is
 * only opened in processes that consume (worker/all roles).
 *
 * @param {string} name
 * @param {Object} options
 * @returns {Object}
 */
function buildBullMqHandle(name, options) {
  const url = options.redisUrl ?? env?.redis?.url;
  if (!url) {
    throw new QueueError(QUEUE_ERROR_CODES.INVALID_INPUT, `Queue "${name}" requires REDIS_URL to be set`);
  }
  const { Queue = BullQueue, Worker = BullWorker, Redis = IORedis } = options.drivers ?? {};
  const timeoutMs = producerTimeout(options);
  const closeStageMs = Number.isFinite(options.closeStageMs) ? options.closeStageMs : CLOSE_STAGE_MS;

  const producerConnection = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    enableReadyCheck: true,
  });
  producerConnection.on?.('error', (err) => {
    logger.warn({ err: { message: err?.message }, queue: name }, 'queue producer Redis error');
  });
  const queue = new Queue(name, {
    connection: producerConnection,
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
  queue.on?.('error', (err) => {
    logger.error({ err: { message: err?.message }, queue: name }, 'queue error');
  });

  let worker = null;
  let workerConnection = null;

  /**
   * Start a worker for this queue. Only one worker per queue per process.
   *
   * @param {(job: { data: any, id: string, name: string, attemptsMade: number, attempts: number }) => Promise<any>} handler
   */
  function consume(handler) {
    if (worker) {
      throw new QueueError(QUEUE_ERROR_CODES.INVALID_INPUT, `Queue "${name}" already has a worker attached`);
    }
    if (typeof handler !== 'function') {
      throw new QueueError(QUEUE_ERROR_CODES.INVALID_INPUT, 'consume() requires a handler function');
    }
    const instrumented = instrumentConsumer(name, handler);
    workerConnection = new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
    workerConnection.on?.('error', (err) => {
      logger.warn({ err: { message: err?.message }, queue: name }, 'queue worker Redis error');
    });
    worker = new Worker(
      name,
      async (job) => instrumented({
        data: job.data,
        id: job.id,
        name: job.name,
        attemptsMade: job.attemptsMade ?? 0,
        attempts: job.opts?.attempts ?? options.attempts ?? 1,
      }),
      {
        connection: workerConnection,
        concurrency: Number.isInteger(options.concurrency) ? options.concurrency : 5,
      },
    );
    worker.on?.('error', (err) => {
      logger.error({ err: { message: err?.message }, queue: name }, 'queue worker error');
    });
    worker.on?.('failed', (job, err) => {
      logger.warn({ err: { message: err?.message }, queue: name, jobId: job?.id, attemptsMade: job?.attemptsMade }, 'queue job failed');
    });
    return worker;
  }

  async function quit(connection) {
    if (!connection) return;
    // QUIT on a connection that is down would wait in the offline queue.
    if (connection.status && connection.status !== 'ready') {
      connection.disconnect?.();
      return;
    }
    const outcome = await settleWithin(connection.quit(), closeStageMs);
    // Stop any reconnect loop whatever QUIT did.
    if (outcome === 'timeout' || connection.status !== 'end') connection.disconnect?.();
  }

  const handle = Object.freeze({
    name,
    transport: TRANSPORT_BULLMQ,
    options,
    enqueue(data, opts = {}) {
      return guardProducer(() => queue.add(opts.name ?? 'job', withTraceCarrier(data), {
        jobId: opts.jobId,
        priority: opts.priority,
        ...(Number.isInteger(opts.attempts) ? { attempts: opts.attempts } : {}),
      }), { timeoutMs, queue: name });
    },
    schedule(data, delayMs, opts = {}) {
      return guardProducer(() => queue.add(opts.name ?? 'job', withTraceCarrier(data), {
        jobId: opts.jobId,
        delay: Math.max(0, Number(delayMs) || 0),
      }), { timeoutMs, queue: name });
    },
    consume,
    on(event, listener) {
      queue.on(event, listener);
      return () => queue.off(event, listener);
    },
    /**
     * Round-trip to Redis on the producer connection (readiness), bounded.
     * A connection that is still connecting gets the same budget to finish.
     */
    ping({ timeoutMs: pingTimeoutMs = timeoutMs } = {}) {
      return guardProducer(async () => {
        await whenReady(producerConnection, pingTimeoutMs);
        return producerConnection.ping();
      }, { timeoutMs: pingTimeoutMs, queue: name });
    },
    async stats() {
      const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed', 'paused');
      return { ...counts, consuming: Boolean(worker) && !worker.closing };
    },
    /**
     * Stop taking jobs, wait for active ones up to `drainTimeoutMs`, then
     * force-close the worker (BullMQ moves an interrupted job back for
     * another worker via stalled-job recovery) and close the queue and both
     * Redis connections.
     */
    async close({ drainTimeoutMs = 0 } = {}) {
      registry.delete(handle);
      let drained = true;
      if (worker) {
        // Graceful: stop fetching, let active jobs finish within the budget.
        if (await settleWithin(worker.close(), drainTimeoutMs) === 'timeout') {
          drained = false;
          // Force: active jobs are interrupted (BullMQ re-delivers them as
          // stalled). Bounded too: with Redis down this can wait forever.
          if (await settleWithin(worker.close(true), closeStageMs) === 'timeout') {
            // Redis unreachable: drop the worker's own (blocking) connections.
            await settleWithin(worker.disconnect?.(), closeStageMs);
          }
        }
      }
      if (await settleWithin(queue.close(), closeStageMs) === 'timeout') {
        await settleWithin(queue.disconnect?.(), closeStageMs);
      }
      await quit(workerConnection);
      await quit(producerConnection);
      return { drained };
    },
  });
  registry.add(handle);
  return handle;
}

export { QUEUE_NAMES, QueueError, QUEUE_ERROR_CODES };
export { default as connectorQueueContract } from './connector.queue.js';
export { default as emailQueueContract } from './email.queue.js';
export { default as analyticsQueueContract } from './analytics.queue.js';

export default {
  QUEUE_NAMES,
  createQueue,
  closeAll,
  getQueueStats,
};
