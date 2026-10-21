/**
 * Scrape-time metric collectors (roadmap 2.8).
 *
 * WHY IT EXISTS
 *   Some series are state, not events: how many jobs wait in each queue,
 *   when each scheduled job last succeeded, how many emails are waiting.
 *   They are read when Prometheus scrapes (each collector is time-boxed by
 *   `utils/metrics.js#collect`) instead of being polled in the background.
 *
 * SERIES
 *   analivo_queue_jobs{queue,state}         waiting/active/delayed/failed
 *   analivo_queue_up{queue}                 1 when the transport answered
 *   analivo_outbox_backlog{source}          email backlog; `email_queue` is
 *                                           the delivery queue's waiting +
 *                                           delayed jobs. Other sources (the
 *                                           durable email outbox) register
 *                                           with `registerOutboxBacklogSource`.
 *   analivo_job_last_success_timestamp_seconds{job}  from JobRun records
 *   analivo_build_info{version,env,role,node}
 *
 * Importing this module registers the collectors once.
 */

import env from '../config/env.js';
import * as queueService from './queue.service.js';
import jobRunRepository from '../repositories/jobRun.repository.js';
import { getRegisteredJobs } from '../jobs/scheduler.js';
import { QUEUE_NAMES } from '../queues/constants.js';
import { isDatabaseConnected } from '../config/database.js';
// retention: the durable email outbox is a backlog source.
import outboxRepository from '../repositories/outboundEmail.repository.js';
import {
  registerCollector,
  queueDepth,
  queueUp,
  outboxBacklog,
  jobLastSuccess,
  buildInfo,
} from '../utils/metrics.js';

const QUEUE_STATES = ['waiting', 'active', 'delayed', 'failed'];
/** source -> async () => number */
const backlogSources = new Map();

/**
 * Register a backlog source for `analivo_outbox_backlog{source}` (e.g. the
 * durable email outbox counting its pending rows). Returns an unregister
 * function.
 *
 * @param {string} source - short label (`[a-z_]+`).
 * @param {() => Promise<number>} count
 * @returns {() => void}
 */
export function registerOutboxBacklogSource(source, count) {
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(source)) throw new Error(`Invalid backlog source "${source}"`);
  if (typeof count !== 'function') throw new TypeError('registerOutboxBacklogSource requires a function');
  backlogSources.set(source, count);
  return () => backlogSources.delete(source);
}

async function queueCollector() {
  const stats = await queueService.getQueueStats({ timeoutMs: 1500, ensureNames: Object.values(QUEUE_NAMES) });
  // In-process transport: a queue this process never opened is empty. (With
  // BullMQ every platform queue is opened above, so all are reported.)
  if (!env.redis.enabled) {
    const seen = new Set(stats.map((entry) => entry.name));
    for (const name of Object.values(QUEUE_NAMES)) {
      if (!seen.has(name)) stats.push({ name, status: 'ok', waiting: 0, active: 0, delayed: 0, failed: 0 });
    }
  }
  for (const entry of stats) {
    queueUp.set({ queue: entry.name }, entry.status === 'down' ? 0 : 1);
    if (entry.status === 'down') continue;
    for (const state of QUEUE_STATES) {
      if (typeof entry[state] === 'number') queueDepth.set({ queue: entry.name, state }, entry[state]);
    }
    if (entry.name === QUEUE_NAMES.EMAIL_DELIVERY) {
      outboxBacklog.set({ source: 'email_queue' }, (entry.waiting ?? 0) + (entry.delayed ?? 0));
    }
  }
}
queueCollector.collectorName = 'queues';

async function backlogCollector() {
  await Promise.all(Array.from(backlogSources, async ([source, count]) => {
    const value = Number(await count());
    if (Number.isFinite(value) && value >= 0) outboxBacklog.set({ source }, value);
  }));
}
backlogCollector.collectorName = 'outbox';

async function jobCollector() {
  if (!isDatabaseConnected()) return;
  const names = getRegisteredJobs().map((job) => job.name);
  const latest = await jobRunRepository.latestByJob(names);
  for (const name of names) {
    const success = latest[name]?.lastSuccess;
    const at = success?.finishedAt ?? success?.startedAt;
    if (at) jobLastSuccess.set({ job: name }, Math.floor(new Date(at).getTime() / 1000));
  }
}
jobCollector.collectorName = 'jobs';

function buildCollector() {
  buildInfo.set({ version: env.app.version, env: env.app.env, role: env.runtime?.role ?? 'all', node: process.version }, 1);
}
buildCollector.collectorName = 'build';

let registered = false;

/** Register the collectors (idempotent). */
export function registerDefaultCollectors() {
  if (registered) return;
  registered = true;
  registerCollector(queueCollector);
  registerCollector(backlogCollector);
  registerCollector(jobCollector);
  registerCollector(buildCollector);
  // retention: durable outbox backlog (pending + retrying rows).
  registerOutboxBacklogSource('outbox', async () => {
    if (!isDatabaseConnected()) return NaN;
    const counts = await outboxRepository.countByStatus();
    return (counts.pending ?? 0) + (counts.retrying ?? 0);
  });
}

registerDefaultCollectors();

export default { registerDefaultCollectors, registerOutboxBacklogSource };
