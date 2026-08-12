/**
 * Scheduler bootstrap.
 *
 * WHY IT EXISTS
 *   Centralised node-cron orchestration. Individual jobs declare their own
 *   cron/flag; this module is the only place cron is actually started/stopped,
 *   so graceful shutdown can drain tasks cleanly.
 *
 * RESPONSIBILITY
 *   - Register known jobs from `src/jobs/*.job.js`.
 *   - Schedule each enabled job with its declared cron expression.
 *   - Run handlers with isolated error handling so one failure never kills
 *     the process or the scheduler.
 *   - Stop every task on shutdown.
 *
 * HOW TO EXTEND
 *   Add a job by (1) creating `src/jobs/<name>.job.js` exporting
 *   `{ name, cronExpression, enabled, handler }`, (2) importing it below,
 *   (3) adding it to the `jobs` array. Enable via env in `.env.example`.
 */

import cron from 'node-cron';
import schedulerConfig from '../config/scheduler.js';
import logger from '../utils/logger.js';
import anomalyJob from './anomaly.job.js';
import sheetSyncJob from './sheetSync.job.js';
import emailJob from './email.job.js';
import cleanupJob from './cleanup.job.js';
import reportScheduleJob from './reportSchedule.job.js';
import alertEvalJob from './alertEval.job.js';

/** All background jobs known to the platform. */
const jobs = [sheetSyncJob, emailJob, cleanupJob, anomalyJob, reportScheduleJob, alertEvalJob];

/** name -> cron task handle, for stop() on shutdown. */
const scheduledTasks = new Map();

/** Schedule every enabled job. No-op when the scheduler is globally disabled. */
export function initScheduler() {
  if (!schedulerConfig.enabled) {
    logger.info('Scheduler is disabled (SCHEDULER_ENABLED=false)');
    return;
  }

  for (const job of jobs) {
    if (!job.enabled) {
      logger.info({ job: job.name }, 'Job disabled, not scheduling');
      continue;
    }
    try {
      const task = cron.schedule(
        job.cronExpression,
        () => runJob(job),
        { timezone: schedulerConfig.timezone, name: job.name },
      );
      scheduledTasks.set(job.name, task);
      logger.info({ job: job.name, cron: job.cronExpression }, 'Job scheduled');
    } catch (err) {
      logger.error({ err: { message: err.message }, job: job.name }, 'Failed to schedule job');
    }
  }
}

/** Execute a job handler with isolated error handling. */
async function runJob(job) {
  logger.info({ job: job.name }, 'Job started');
  try {
    await job.handler();
    logger.info({ job: job.name }, 'Job completed');
  } catch (err) {
    logger.error({ err: { message: err.stack ?? err.message }, job: job.name }, 'Job failed');
  }
}

/** Stop all scheduled tasks (called during graceful shutdown). */
export async function stopScheduler() {
  for (const task of scheduledTasks.values()) {
    task.stop();
  }
  scheduledTasks.clear();
  logger.info('Scheduler stopped');
}
