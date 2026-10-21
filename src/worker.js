/**
 * Worker process entry point (roadmap 1.4).
 *
 * WHY IT EXISTS
 *   Production runs background work in its own service (same image, start
 *   command `npm run start:worker`) so web instances can scale and restart
 *   without running cron or consuming queues. This process serves no HTTP:
 *   it connects the database, registers every queue consumer, starts the
 *   scheduler and drains gracefully on SIGTERM/SIGINT.
 *
 * TOPOLOGY
 *   web service    : `npm start` with PROCESS_ROLE=web (HTTP + Socket.IO)
 *   worker service : `npm run start:worker` (role forced to `worker`)
 *   Both need the same MONGODB_URI and REDIS_URL. Without REDIS_URL the
 *   worker only sees its own in-memory queue (development only).
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import env from './config/env.js';
import logger from './utils/logger.js';
import { connectDatabase } from './config/database.js';
import { initAuditConsumer } from './services/auditConsumer.service.js';
import { setProcessRole, getInstanceId } from './jobs/runtime.js';
import { startBackgroundWork, defaultShutdownDeps } from './jobs/background.js';
import { buildShutdownSteps, runShutdownSteps } from './jobs/shutdown.js';
// observability: crash reporting (roadmap 2.8).
import { reportError, flushErrorReports } from './services/errorReporter.service.js';

setProcessRole('worker');

let shuttingDown = false;

/**
 * Compile every model. The web process gets this for free by importing the
 * routes; the worker imports services lazily, and the audit consumer only
 * subscribes to models compiled before `initAuditConsumer()` runs.
 */
async function loadModels() {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'models');
  const files = (await readdir(dir)).filter((file) => file.endsWith('.js')).sort();
  for (const file of files) await import(pathToFileURL(path.join(dir, file)).href);
  return files.length;
}

/** Boot: database first (a worker without it can do nothing), then work. */
async function start() {
  if (!env.redis.enabled) {
    logger.warn('Worker started without REDIS_URL: it only processes jobs it enqueues itself (development mode)');
  }
  const connected = await connectDatabase();
  if (!connected) {
    logger.fatal('Worker cannot start: database unavailable');
    process.exit(1);
  }
  if (shuttingDown) return;
  // Model-change events from jobs must reach the audit trail here too.
  const models = await loadModels();
  initAuditConsumer();
  logger.debug({ models }, 'Models compiled; audit consumer wired');
  startBackgroundWork();
  logger.info({ role: 'worker', instanceId: getInstanceId(), env: env.app.env }, 'Worker started');
}

/** Graceful drain: stop cron, let in-flight jobs finish (bounded), close. */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Worker shutdown initiated');

  const forceExitTimer = setTimeout(() => {
    logger.error('Worker shutdown timed out - forcing exit');
    process.exit(1);
  }, env.server.shutdownTimeoutMs + 2000);
  forceExitTimer.unref();

  try {
    const outcome = await runShutdownSteps(
      buildShutdownSteps({ drainTimeoutMs: env.server.drainTimeoutMs, deps: defaultShutdownDeps() }),
      { timeoutMs: env.server.shutdownTimeoutMs },
    );
    logger.info({ durationMs: outcome.durationMs, steps: outcome.steps }, 'Worker shutdown complete');
    await flushErrorReports({ timeoutMs: 1000 });
    await logger.flush?.();
    process.exit(outcome.ok ? 0 : 1);
  } catch (err) {
    logger.error({ err: { message: err.message } }, 'Error during worker shutdown');
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  logger.fatal({ err: { message: err.message, stack: err.stack } }, 'Uncaught exception');
  reportError(err, { source: 'process', level: 'fatal' });
  flushErrorReports({ timeoutMs: 1500 }).finally(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
  logger.error(
    { err: { message: reason?.message ?? String(reason), stack: reason?.stack } },
    'Unhandled promise rejection',
  );
  void reportError(reason, { source: 'process' });
});

start().catch((err) => {
  logger.fatal({ err: { message: err?.message } }, 'Worker failed to start');
  process.exit(1);
});
