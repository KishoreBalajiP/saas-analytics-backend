/**
 * Graceful shutdown (roadmap 1.4; findings ops.06, con.09, ops2.08).
 *
 * WHY IT EXISTS
 *   On SIGTERM a deploy gives the process a few seconds. The old sequence
 *   waited for `server.close()` before closing Socket.IO, so any connected
 *   browser kept the server open until the force-exit timer killed the
 *   process mid-job, and queues, Redis and the mailer were never closed.
 *
 * ORDER (each step is time-boxed; the whole run fits SHUTDOWN_TIMEOUT_MS)
 *   1. http        stop accepting connections; close Socket.IO clients
 *                  together with the HTTP server (`io.close()` closes both)
 *                  so open sockets cannot hold the server open.
 *   2. scheduler   stop cron ticks; wait for in-flight ticks.
 *   3. queues      consumers stop taking jobs; in-flight jobs get up to
 *                  SHUTDOWN_DRAIN_TIMEOUT_MS; then queues and their Redis
 *                  connections close.
 *   4. locks       close the scheduler lock's Redis connection (and the
 *                  Socket.IO Redis adapter connections and the web
 *                  process's auth rate-limit store connection, when
 *                  present).
 *   5. access-log  flush buffered access-log rows (needs the database).
 *   6. cache       close the cache driver (Redis).
 *   7. mail        close the mail transport.
 *   8. storage     release the storage driver (S3 client); after the queue
 *                  drain, since in-flight jobs write artefacts.
 *   9. database    disconnect MongoDB.
 *
 *   A step that fails or runs out of time is logged and the next one still
 *   runs, so the database is always disconnected.
 */

import logger from '../utils/logger.js';

class StepTimeoutError extends Error {
  constructor(name, ms) {
    super(`shutdown step "${name}" timed out after ${ms}ms`);
    this.name = 'StepTimeoutError';
  }
}

/**
 * Run shutdown steps in order, each bounded by its own budget and by the
 * overall deadline.
 *
 * @param {Array<{ name: string, run: (ctx: { timeoutMs: number }) => any, timeoutMs?: number }>} steps
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=10000] - total budget.
 * @param {Object} [options.log=logger]
 * @returns {Promise<{ ok: boolean, durationMs: number, steps: Array<{ name: string, status: 'ok'|'timeout'|'error'|'skipped', durationMs: number, error?: string }> }>}
 */
export async function runShutdownSteps(steps, { timeoutMs = 10000, log = logger } = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const results = [];
  for (const step of steps) {
    const remaining = deadline - Date.now();
    if (remaining <= 0 && !step.always) {
      results.push({ name: step.name, status: 'skipped', durationMs: 0 });
      log.warn?.({ step: step.name }, 'shutdown step skipped: deadline reached');
      continue;
    }
    // `always` steps (closing the database) still run past the deadline,
    // with their own small budget.
    const budget = remaining <= 0
      ? Math.max(1, step.timeoutMs ?? 1000)
      : Math.max(1, Math.min(step.timeoutMs ?? remaining, remaining));
    const t0 = Date.now();
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => step.run({ timeoutMs: budget })),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new StepTimeoutError(step.name, budget)), budget);
        }),
      ]);
      results.push({ name: step.name, status: 'ok', durationMs: Date.now() - t0 });
    } catch (err) {
      const status = err instanceof StepTimeoutError ? 'timeout' : 'error';
      results.push({ name: step.name, status, durationMs: Date.now() - t0, error: err?.message });
      log.warn?.({ step: step.name, status, err: { message: err?.message } }, 'shutdown step did not complete');
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    ok: results.every((r) => r.status === 'ok'),
    durationMs: Date.now() - startedAt,
    steps: results,
  };
}

/**
 * Stop the HTTP server and Socket.IO together. Resolves when the server has
 * closed, or after `timeoutMs` (remaining connections are then destroyed).
 *
 * @param {Object} options
 * @param {import('node:http').Server} options.server
 * @param {Object} [options.io] - Socket.IO server attached to `server`.
 * @param {number} [options.timeoutMs=5000]
 * @returns {Promise<{ forced: boolean }>}
 */
export function closeHttpServer({ server, io = null, timeoutMs = 5000 }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (forced) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ forced });
    };
    const timer = setTimeout(() => {
      server?.closeAllConnections?.();
      finish(true);
    }, Math.max(1, timeoutMs));

    // Idle keep-alive connections would otherwise hold close() open.
    server?.closeIdleConnections?.();
    if (io && typeof io.close === 'function') {
      // Disconnects every Socket.IO client (synchronously), then closes the
      // adapter, the engine and the HTTP server. Its adapter step can wait
      // on Redis, so the engine and the server are also closed directly
      // below instead of waiting for it.
      Promise.resolve(io.close()).catch(() => {});
      try { io.engine?.close?.(); } catch { /* already closed */ }
    }
    if (server) {
      server.close(() => finish(false));
    } else {
      finish(false);
    }
  });
}

/**
 * Build the ordered shutdown steps for a process.
 *
 * @param {Object} options
 * @param {import('node:http').Server} [options.server] - omitted by the worker.
 * @param {Object} [options.io]
 * @param {number} options.drainTimeoutMs - budget for in-flight ticks/jobs.
 * @param {Object} options.deps - { stopScheduler, closeQueues, closeLocks,
 *   closeSocketAdapter?, closeRateLimitStore?, flushAccessLog, closeCache, closeMail,
 *   closeStorage?, disconnectDatabase } (injected so the order can be
 *   unit-tested with fakes).
 * @returns {Array<{ name: string, run: Function }>}
 */
export function buildShutdownSteps({ server = null, io = null, drainTimeoutMs, httpTimeoutMs = 5000, deps }) {
  const steps = [];
  // The scheduler and queue drains share ONE budget: whatever the scheduler
  // uses is not available to the queues, so draining never eats the time
  // reserved for closing connections.
  let drainDeadline = null;
  const drainBudget = (stepBudget) => {
    if (drainDeadline === null) drainDeadline = Date.now() + drainTimeoutMs;
    return Math.max(0, Math.min(drainDeadline - Date.now(), stepBudget));
  };
  if (server) {
    steps.push({
      name: 'http',
      timeoutMs: httpTimeoutMs,
      run: ({ timeoutMs }) => closeHttpServer({ server, io, timeoutMs: Math.max(1, timeoutMs - 50) }),
    });
  }
  steps.push(
    {
      name: 'scheduler',
      timeoutMs: drainTimeoutMs + 250,
      run: ({ timeoutMs }) => deps.stopScheduler({ timeoutMs: drainBudget(timeoutMs - 50) }),
    },
    // Closing connections after the drain needs a moment of its own; a
    // transport that hangs anyway is cut off so later steps still run.
    {
      name: 'queues',
      timeoutMs: drainTimeoutMs + 1500,
      run: ({ timeoutMs }) => deps.closeQueues({ drainTimeoutMs: drainBudget(timeoutMs - 500) }),
    },
    { name: 'locks', timeoutMs: 1000, run: () => deps.closeLocks() },
    ...(deps.closeSocketAdapter ? [{ name: 'socket-adapter', timeoutMs: 1000, run: () => deps.closeSocketAdapter() }] : []),
    ...(deps.closeRateLimitStore ? [{ name: 'rate-limit', timeoutMs: 1000, run: () => deps.closeRateLimitStore() }] : []),
    { name: 'access-log', timeoutMs: 1000, run: () => deps.flushAccessLog() },
    { name: 'cache', timeoutMs: 1000, run: () => deps.closeCache() },
    { name: 'mail', timeoutMs: 1000, run: () => deps.closeMail() },
    ...(deps.closeStorage ? [{ name: 'storage', timeoutMs: 1000, run: () => deps.closeStorage() }] : []),
    { name: 'database', timeoutMs: 2000, always: true, run: () => deps.disconnectDatabase() },
  );
  return steps;
}

export default { runShutdownSteps, closeHttpServer, buildShutdownSteps };
