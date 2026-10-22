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
 *   - Schedule each enabled job with its declared cron expression, only in
 *     processes whose role runs background work (worker/all).
 *   - Run each tick under a distributed lease lock (`jobs/lock.js`), so two
 *     instances, or a slow tick overlapping the next, never run the same job
 *     at once; renew the lease while the job runs.
 *   - Persist a `JobRun` per execution (instance, timings, counts, sanitised
 *     error) for the monitoring surface and the stale-job reaper.
 *   - Run handlers with isolated error handling so one failure never kills
 *     the process or the scheduler.
 *   - Stop every task on shutdown and wait (bounded) for in-flight runs.
 *
 * HOW TO EXTEND
 *   Add a job by (1) creating `src/jobs/<name>.job.js` exporting
 *   `{ name, cronExpression, enabled, handler, leaseMs? }`, (2) importing it
 *   below, (3) adding it to the `jobs` array. Enable via env in `.env.example`.
 *   A handler may return an object of numeric counts; they are stored on the
 *   job run. Make handlers idempotent: the lock prevents overlap, but work
 *   items should still be claimed atomically (see report/alert `runDue`).
 */

import cron from 'node-cron';
import schedulerConfig from '../config/scheduler.js';
import env from '../config/env.js';
import logger from '../utils/logger.js';
import { sanitizeError } from '../utils/sanitizeError.js';
import jobRunRepository from '../repositories/jobRun.repository.js';
import { getJobLock } from './lock.js';
import { runsBackgroundWork, getInstanceId, getProcessRole } from './runtime.js';
import anomalyJob from './anomaly.job.js';
import sheetSyncJob from './sheetSync.job.js';
import emailJob from './email.job.js';
import cleanupJob from './cleanup.job.js';
import reportScheduleJob from './reportSchedule.job.js';
import alertEvalJob from './alertEval.job.js';
import billingReconcileJob from './billingReconcile.job.js';
import staleJobRecoveryJob from './stale-job-recovery.job.js';
import usageReconcileJob from './usageReconcile.job.js';
// delivery: roadmap 3.4
import deliveryRetryJob from './deliveryRetry.job.js';
// billing: prepaid-term lifecycle (expiry, grace, restriction, reminders).
import billingLifecycleJob from './billingLifecycle.job.js';
// detection: platform security detection rules (roadmap 2.6).
import securityDetectionJob from './securityDetection.job.js';
// members: invitation expiry sweep and tenant purge (roadmap 2.10).
import invitationExpiryJob from './invitationExpiry.job.js';
import tenantPurgeJob from './tenantPurge.job.js';
// backups: tenant data export expiry (roadmap 2.9).
import tenantExportExpiryJob from './tenantExportExpiry.job.js';
// observability: each tick runs in its own trace context (job name on every
// log line), records job metrics and reports failures.
import { runWithTrace, childTraceContext, currentTraceCarrier } from '../utils/traceContext.js';
import { observeJobRun } from '../utils/metrics.js';
import { reportError } from '../services/errorReporter.service.js';

/** All background jobs known to the platform. */
const jobs = [
  sheetSyncJob,
  emailJob,
  cleanupJob,
  anomalyJob,
  reportScheduleJob,
  alertEvalJob,
  billingReconcileJob,
  staleJobRecoveryJob,
  usageReconcileJob,
  // delivery: roadmap 3.4
  deliveryRetryJob,
  // billing:
  billingLifecycleJob,
  // members: invitation expiry sweep and tenant purge (roadmap 2.10).
  invitationExpiryJob,
  tenantPurgeJob,
  // backups:
  tenantExportExpiryJob,
  // detection:
  securityDetectionJob,
];

/**
 * After a tick finishes, keep its lock taken until this long after the
 * scheduled tick time, so an instance whose clock fires a little later does
 * not run the same tick again (it still runs every following tick).
 */
const TICK_FENCE_MS = 30 * 1000;

/** name -> cron task handle, for stop() on shutdown. */
const scheduledTasks = new Map();
/** Executions currently running in this process. */
const inFlight = new Set();
let stopping = false;
let startedAt = null;

/** Static description of every registered job (monitoring). */
export function getRegisteredJobs() {
  return jobs.map((job) => ({
    name: job.name,
    cronExpression: job.cronExpression,
    enabled: Boolean(job.enabled),
  }));
}

/** Snapshot of this process's scheduler (monitoring). */
export function getSchedulerState() {
  return {
    enabled: Boolean(schedulerConfig.enabled),
    role: getProcessRole(),
    instanceId: getInstanceId(),
    running: scheduledTasks.size > 0 && !stopping,
    startedAt: startedAt ? startedAt.toISOString() : null,
    inFlight: inFlight.size,
    scheduledJobs: Array.from(scheduledTasks.keys()),
  };
}

/**
 * Schedule every enabled job. No-op when the scheduler is globally disabled
 * or this process's role does not run background work.
 *
 * @returns {boolean} whether the scheduler started.
 */
export function initScheduler() {
  if (!schedulerConfig.enabled) {
    logger.info('Scheduler is disabled (SCHEDULER_ENABLED=false)');
    return false;
  }
  if (!runsBackgroundWork()) {
    logger.info({ role: getProcessRole() }, 'Scheduler not started in this process (PROCESS_ROLE=web)');
    return false;
  }
  stopping = false;
  startedAt = new Date();

  for (const job of jobs) {
    if (!job.enabled) {
      logger.info({ job: job.name }, 'Job disabled, not scheduling');
      continue;
    }
    if (scheduledTasks.has(job.name)) continue;
    try {
      const task = cron.schedule(
        job.cronExpression,
        (context) => runJob(job, { tickAt: context?.date ?? new Date() }),
        // noOverlap: node-cron skips a tick while this process's previous
        // run is still going; the distributed lock covers other processes.
        { timezone: schedulerConfig.timezone, name: job.name, noOverlap: true },
      );
      scheduledTasks.set(job.name, task);
      logger.info({ job: job.name, cron: job.cronExpression }, 'Job scheduled');
    } catch (err) {
      logger.error({ err: { message: err.message }, job: job.name }, 'Failed to schedule job');
    }
  }
  return true;
}

/** Keep only finite numeric counters from a handler result. */
function toCounts(result) {
  if (!result || typeof result !== 'object') return null;
  const counts = {};
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'number' && Number.isFinite(value)) counts[key] = value;
  }
  return Object.keys(counts).length > 0 ? counts : null;
}

/**
 * Run one job tick under the distributed lock and record a JobRun.
 *
 * @param {Object} job - `{ name, handler, leaseMs? }`.
 * @param {Object} [options]
 * @param {Date} [options.tickAt] - scheduled tick time (enables tick fencing).
 * @param {Object} [options.lock] - lock implementation (tests inject one).
 * @param {string} [options.instanceId]
 * @param {'schedule'|'manual'} [options.trigger='schedule']
 * @returns {Promise<{ status: 'succeeded'|'failed'|'skipped', reason?: string, runId?: string, counts?: Object|null }>}
 */
export async function runJob(job, {
  tickAt = null,
  lock = getJobLock(),
  instanceId = getInstanceId(),
  trigger = 'schedule',
} = {}) {
  if (stopping) return { status: 'skipped', reason: 'stopping' };
  const leaseMs = job.leaseMs ?? schedulerConfig.lockLeaseMs ?? env.scheduler.lockLeaseMs;
  const lockKey = `job:${job.name}`;

  let token = null;
  try {
    token = await lock.acquire(lockKey, { owner: instanceId, leaseMs });
  } catch (err) {
    // Fail closed: an unreachable lock backend skips the tick.
    logger.warn({ err: { message: err?.message }, job: job.name }, 'Job lock unavailable, skipping tick');
    return { status: 'skipped', reason: 'lock_unavailable' };
  }
  if (!token) {
    logger.debug({ job: job.name }, 'Job already running elsewhere, skipping tick');
    return { status: 'skipped', reason: 'locked' };
  }

  const execution = runWithTrace(childTraceContext(currentTraceCarrier(), { job: job.name }), () =>
    execute(job, { token, lock, lockKey, leaseMs, tickAt, trigger, instanceId }));
  inFlight.add(execution);
  try {
    return await execution;
  } finally {
    inFlight.delete(execution);
  }
}

async function execute(job, { token, lock, lockKey, leaseMs, tickAt, trigger, instanceId }) {
  const started = new Date();
  logger.info({ job: job.name, instanceId }, 'Job started');

  let run = null;
  try {
    run = await jobRunRepository.create({
      job: job.name,
      instanceId,
      trigger,
      status: 'running',
      tickAt,
      startedAt: started,
      heartbeatAt: started,
      leaseUntil: new Date(started.getTime() + leaseMs),
    });
  } catch (err) {
    // Recording is best-effort; the job itself still runs.
    logger.warn({ err: { message: err?.message }, job: job.name }, 'Could not record job run');
  }

  const heartbeat = setInterval(() => {
    const now = new Date();
    Promise.resolve()
      .then(() => lock.renew(lockKey, token, { leaseMs }))
      .then((renewed) => {
        // The lease lapsed (e.g. a long pause) and another instance may now
        // hold the lock; work items stay safe through their own claims.
        if (renewed === false) logger.warn({ job: job.name, instanceId }, 'Job lock lost while running');
      })
      .then(() => (run ? jobRunRepository.heartbeat(run._id, { now, leaseUntil: new Date(now.getTime() + leaseMs) }) : null))
      .catch((err) => logger.warn({ err: { message: err?.message }, job: job.name }, 'Job heartbeat failed'));
  }, Math.max(1000, Math.floor(leaseMs / 3)));
  heartbeat.unref?.();

  let status = 'succeeded';
  let counts = null;
  let error = null;
  try {
    const result = await job.handler({ tickAt, instanceId });
    counts = toCounts(result);
    logger.info({ job: job.name, counts }, 'Job completed');
  } catch (err) {
    status = 'failed';
    error = sanitizeError(err);
    // retention: a handler that failed part-way may attach the counts of
    // the work it did finish (`err.counts`), so the run report survives.
    counts = toCounts(err?.counts);
    logger.error({ err: { message: err?.stack ?? err?.message }, job: job.name }, 'Job failed');
    void reportError(err, { source: 'job', extra: { job: job.name, trigger } });
  } finally {
    clearInterval(heartbeat);
  }

  const finishedAt = new Date();
  observeJobRun(job.name, status, (finishedAt.getTime() - started.getTime()) / 1000);
  if (run) {
    await jobRunRepository.finish(run._id, {
      status,
      finishedAt,
      durationMs: finishedAt.getTime() - started.getTime(),
      counts,
      error,
      retentionDays: env.retention?.jobRunDays ?? 30,
    }).catch((err) => logger.warn({ err: { message: err?.message }, job: job.name }, 'Could not close job run'));
  }

  const holdUntil = tickAt ? new Date(new Date(tickAt).getTime() + Math.min(TICK_FENCE_MS, leaseMs)) : null;
  await Promise.resolve()
    .then(() => lock.release(lockKey, token, { holdUntil }))
    .catch((err) => logger.warn({ err: { message: err?.message }, job: job.name }, 'Could not release job lock'));

  return { status, runId: run ? String(run._id) : null, counts, error };
}

/**
 * Stop all scheduled tasks (graceful shutdown) and wait for in-flight runs,
 * bounded by `timeoutMs`.
 *
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=0]
 * @returns {Promise<{ drained: boolean, inFlight: number }>}
 */
export async function stopScheduler({ timeoutMs = 0 } = {}) {
  stopping = true;
  for (const task of scheduledTasks.values()) {
    try {
      await task.stop();
    } catch (err) {
      logger.warn({ err: { message: err?.message } }, 'Failed to stop cron task');
    }
  }
  scheduledTasks.clear();

  const pending = Array.from(inFlight);
  let drained = pending.length === 0;
  if (!drained && timeoutMs > 0) {
    let timer;
    drained = await Promise.race([
      Promise.allSettled(pending).then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  }
  logger.info({ drained, inFlight: inFlight.size }, 'Scheduler stopped');
  return { drained, inFlight: inFlight.size };
}

/** Test hook: allow runs again after `stopScheduler()`. */
export function resetSchedulerForTests() {
  stopping = false;
  scheduledTasks.clear();
  startedAt = null;
}
