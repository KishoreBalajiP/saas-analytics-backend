/**
 * Background work bootstrap (roadmap 1.4).
 *
 * WHY IT EXISTS
 *   The web entry (`server.js`, role web/all) and the worker entry
 *   (`worker.js`, role worker) start the same background machinery: the
 *   queue consumers and the scheduler. This module is the single place that
 *   does it, and it refuses to start anything in a `web` process, so a web
 *   instance only ever produces jobs.
 */

import logger from '../utils/logger.js';
import { disconnectDatabase } from '../config/database.js';
import * as queueService from '../services/queue.service.js';
import * as accessLogService from '../services/accessLog.service.js';
import * as cacheService from '../services/cache.service.js';
import * as emailService from '../services/email.service.js';
import * as storageService from '../services/storage.service.js';
import { registerAnalyticsWorker } from './analytics.worker.js';
import { registerExportWorker } from './export.worker.js';
import { registerConnectorConsumer } from '../queues/connector.queue.js';
import { initScheduler, stopScheduler } from './scheduler.js';
import { closeJobLock } from './lock.js';
import { runsBackgroundWork, getProcessRole, getInstanceId } from './runtime.js';
import { closeSocketAdapter } from '../websocket/index.js';

let consumersStarted = false;

/**
 * Register every queue consumer (idempotent).
 *
 * @returns {boolean} whether consumers run in this process.
 */
export function startQueueConsumers() {
  if (!runsBackgroundWork()) return false;
  if (consumersStarted) return true;
  consumersStarted = true;
  registerAnalyticsWorker();
  registerExportWorker();
  registerConnectorConsumer();
  logger.info('Queue consumers registered (connector sync, analytics, export)');
  return true;
}

/**
 * Start queue consumers and the scheduler when this process's role runs
 * background work. A web process logs and returns false.
 *
 * @param {Object} [options]
 * @param {boolean} [options.scheduler=true]
 * @returns {boolean}
 */
export function startBackgroundWork({ scheduler = true } = {}) {
  const role = getProcessRole();
  if (!runsBackgroundWork()) {
    logger.info({ role }, 'Background work not started in this process (PROCESS_ROLE=web): jobs are enqueued for the worker');
    return false;
  }
  try {
    startQueueConsumers();
  } catch (err) {
    logger.error({ err: { message: err?.message } }, 'Failed to register queue consumers');
  }
  if (scheduler) initScheduler();
  logger.info({ role, instanceId: getInstanceId() }, 'Background work started');
  return true;
}

/**
 * The real teardown functions used by `buildShutdownSteps` (see
 * `jobs/shutdown.js`); tests pass fakes instead.
 */
export function defaultShutdownDeps() {
  return {
    stopScheduler: (opts) => stopScheduler(opts),
    closeQueues: (opts) => queueService.closeAll(opts),
    closeLocks: () => closeJobLock(),
    closeSocketAdapter: () => closeSocketAdapter(),
    flushAccessLog: () => accessLogService.flush(),
    closeCache: () => cacheService.close(),
    closeMail: () => emailService.close(),
    closeStorage: () => storageService.close(),
    disconnectDatabase: () => disconnectDatabase(),
  };
}

export default { startBackgroundWork, startQueueConsumers, defaultShutdownDeps };
