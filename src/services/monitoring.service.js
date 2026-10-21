/**
 * Monitoring Service (Sprint 8 - implemented).
 *
 * PURPOSE
 *   Read-only operational health probes. Every subsystem that owns a probe
 *   returns a structured result; nothing here throws to the caller.
 *
 * RESPONSIBILITY
 *   - getSystemHealth      process uptime / memory / CPU / Node version
 *   - getDbHealth          MongoDB connection state + ping latency
 *   - getWsHealth          Socket.IO client + room counts
 *   - getQueueHealth       per-queue counts (BullMQ getJobCounts / memory)
 *   - getSchedulerHealth   registered jobs + last run/success/failure from
 *                          JobRun records, overdue detection
 *   - listJobRuns          paginated JobRun history (admin)
 *   - getQueueReadiness    bounded queue-transport ping for /health/ready
 *   - getRedisHealth       cache round trip on the shared Redis (roadmap 2.8)
 *   - getStorageHealth     storage provider round trip (local dir / S3 HEAD)
 *   - getSmtpHealth        SMTP transport verify (disabled when mail is off)
 *   - getConnectorHealth   platform-wide connector status counts
 *   - getAggregateHealth   5 s cached fan-out over every probe; a cache
 *                          failure (Redis down) computes it uncached instead
 *                          of failing (finding ops.08)
 *   - getMetrics           JSON snapshot of the metrics registry (the
 *                          Prometheus exposition is GET /api/v1/metrics)
 *   - getMailHealth        mail transport + email outbox (retention 2.7)
 *   - listOutbox / requeueOutboxMessage   outbox operations (retention 2.7)
 *   - getRetentionStatus   retention policies, legal holds, last cleanup run
 *
 * CODING GUIDELINES
 *   - Every live probe is wrapped in a 2-second timeout; a hanging probe
 *     reports `{ status: 'degraded', error: 'timeout' }` instead of blocking.
 *   - Probes never throw; they return `{ status, latencyMs?, error? }`.
 *     Statuses: ok | degraded | down | disabled (dependency not configured).
 *   - `/aggregate` is cached for 5 seconds via `services/cache.service.js`
 *     so the status page cannot hammer the platform.
 */

import os from 'node:os';
import mongoose from 'mongoose';
import env from '../config/env.js';
import ApiError from '../utils/ApiError.js';
import * as cacheService from './cache.service.js';
import * as queueService from './queue.service.js';
import { getIO, isSocketInitialized } from '../websocket/index.js';
import { QUEUE_NAMES } from '../queues/constants.js';
import { guardProducer } from '../queues/errors.js';
import { connectorQueue } from '../queues/connector.queue.js';
import { getRegisteredJobs, getSchedulerState } from '../jobs/scheduler.js';
import { runsBackgroundWork, getProcessRole, getInstanceId } from '../jobs/runtime.js';
import jobRunRepository from '../repositories/jobRun.repository.js';
import { JOB_RUN_STATUSES } from '../models/JobRun.js';
import { nextCronDate } from '../utils/cron.js';
// observability: real dependency probes + metrics snapshot (roadmap 2.8).
import * as storageService from './storage.service.js';
import * as emailService from './email.service.js';
import { getTransportType } from './mail.transport.js';
import monitoringRepository from '../repositories/monitoring.repository.js';
import { snapshot as metricsSnapshot } from '../utils/metrics.js';
import { sanitizeError } from '../utils/sanitizeError.js';
// retention: mail/outbox health and the retention surface (roadmap 2.7).
import { JOB } from '../config/constants.js';
import outboxService from './outbox.service.js';
import retentionService from './retention.service.js';

export const PROBE_TIMEOUT_MS = 2000;
/** Readiness probes run constantly: the queue ping gets a short budget. */
export const READINESS_QUEUE_TIMEOUT_MS = 1000;
export const AGGREGATE_CACHE_KEY = 'monitoring:aggregate';
export const AGGREGATE_CACHE_TTL_SEC = 5;

/* ---------------------------- live probes -------------------------------- */

/**
 * System probe: process + host resource snapshot. Synchronous by nature;
 * kept async so the probe surface is uniform.
 *
 * @returns {Promise<{ status: 'ok', latencyMs: number, uptimeSec: number, memory: Object, cpu: Object, nodeVersion: string, pid: number, hostname: string }>}
 */
export async function getSystemHealth() {
  const started = Date.now();
  const memory = process.memoryUsage();
  return {
    status: 'ok',
    latencyMs: Date.now() - started,
    uptimeSec: Math.round(process.uptime()),
    memory: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
    },
    cpu: {
      loadAvg1m: os.loadavg()[0],
      cores: os.cpus().length,
      uptimeSec: Math.round(os.uptime()),
    },
    nodeVersion: process.version,
    pid: process.pid,
    hostname: os.hostname(),
  };
}

/**
 * Database probe: connection state + a real ping through the active pool.
 * Never throws: a disconnected pool or a slow ping is `down`/`degraded`.
 *
 * @returns {Promise<{ status: 'ok'|'down', latencyMs: number, error?: string, readyState?: string }>}
 */
export async function getDbHealth() {
  const started = Date.now();
  const state = mongoose.connection?.readyState ?? 0;
  if (state !== 1) {
    return {
      status: 'down',
      latencyMs: Date.now() - started,
      readyState: String(state),
      error: 'database is not connected',
    };
  }
  try {
    const db = mongoose.connection.db;
    await db.command({ ping: 1 });
    return {
      status: 'ok',
      latencyMs: Date.now() - started,
      readyState: String(state),
    };
  } catch (err) {
    return {
      status: 'down',
      latencyMs: Date.now() - started,
      readyState: String(state),
      error: err?.message ?? 'database ping failed',
    };
  }
}

/**
 * WebSocket probe: client + room counts from the Socket.IO server. When
 * Socket.IO was never initialised this is `degraded`, not `down` - the
 * server may simply be a test process.
 *
 * @returns {Promise<{ status: 'ok'|'degraded', latencyMs: number, sockets?: number, rooms?: number, error?: string }>}
 */
export async function getWsHealth() {
  const started = Date.now();
  if (!isSocketInitialized()) {
    return {
      status: 'degraded',
      latencyMs: Date.now() - started,
      error: 'websocket server is not initialised',
    };
  }
  const io = getIO();
  const sockets = io?.engine?.clientsCount ?? 0;
  const rooms = io?.of?.('/').adapter.rooms?.size ?? 0;
  return {
    status: 'ok',
    latencyMs: Date.now() - started,
    sockets,
    rooms,
  };
}

/* -------------------------- dependency probes ---------------------------- */

/** Cache key read by the Redis probe (a miss is a successful round trip). */
export const REDIS_PROBE_KEY = 'monitoring:probe';
/** Storage key probed with an existence check (never written). */
export const STORAGE_PROBE_KEY = '.health/probe';

/** A short, credential-free reason for a failed probe. */
function probeError(err) {
  return sanitizeError(err, { fallbackCode: 'PROBE_FAILED', maxLength: 200 })?.message ?? 'probe failed';
}

/**
 * Redis probe: one GET round trip through the cache driver, bounded. With
 * no REDIS_URL the platform runs on in-process drivers and Redis is
 * `disabled`.
 *
 * @param {Object} [options] - injectable for tests.
 * @param {boolean} [options.enabled]
 * @param {() => Promise<unknown>} [options.roundTrip]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ status: 'ok'|'down'|'disabled', latencyMs: number, error?: string }>}
 */
export async function getRedisHealth({
  enabled = env.redis.enabled,
  roundTrip = () => cacheService.get(REDIS_PROBE_KEY),
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const started = Date.now();
  if (!enabled) return { status: 'disabled', latencyMs: 0, provider: 'memory' };
  try {
    await raceTimeout(roundTrip(), timeoutMs);
    return { status: 'ok', latencyMs: Date.now() - started, provider: 'redis' };
  } catch (err) {
    return { status: 'down', latencyMs: Date.now() - started, provider: 'redis', error: probeError(err) };
  }
}

/**
 * Storage probe: an existence check on a fixed key through the configured
 * provider (local directory or S3 HEAD). Any answer, "missing" included,
 * proves the provider is reachable; an S3 403 means reachable but the
 * credentials lack read/list rights (`degraded`).
 *
 * @param {Object} [options] - injectable for tests.
 * @param {() => Promise<boolean>} [options.exists]
 * @param {string} [options.provider]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ status: 'ok'|'degraded'|'down', provider: string, latencyMs: number, error?: string }>}
 */
export async function getStorageHealth({
  exists = () => storageService.exists(STORAGE_PROBE_KEY),
  provider = env.storage.provider === 's3' && env.storage.bucket ? 's3' : 'local',
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const started = Date.now();
  try {
    await raceTimeout(exists(), timeoutMs);
    return { status: 'ok', provider, latencyMs: Date.now() - started };
  } catch (err) {
    const forbidden = err?.$metadata?.httpStatusCode === 403 || /access ?denied|forbidden/i.test(String(err?.message));
    return {
      status: forbidden ? 'degraded' : 'down',
      provider,
      latencyMs: Date.now() - started,
      error: forbidden ? 'storage credentials were refused' : probeError(err),
    };
  }
}

/**
 * SMTP probe: `transport.verify()` (connect, greet, authenticate), bounded.
 * `disabled` when mail is off or no SMTP host is configured.
 *
 * @param {Object} [options] - injectable for tests.
 * @param {string} [options.transportType]
 * @param {() => Promise<unknown>} [options.verify]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ status: 'ok'|'down'|'disabled', latencyMs: number, error?: string }>}
 */
export async function getSmtpHealth({
  transportType = getTransportType(),
  verify = () => emailService.verify(),
  timeoutMs = Math.max(PROBE_TIMEOUT_MS, env.mail?.connectionTimeoutMs ?? 10000),
} = {}) {
  const started = Date.now();
  if (transportType !== 'smtp') return { status: 'disabled', latencyMs: 0 };
  try {
    await raceTimeout(verify(), timeoutMs);
    return { status: 'ok', latencyMs: Date.now() - started };
  } catch (err) {
    return { status: 'down', latencyMs: Date.now() - started, error: probeError(err) };
  }
}

/* --------------------------- jobs + queues ------------------------------- */

/** Public JobRun shape. */
function toPublicJobRun(run) {
  if (!run) return null;
  return {
    id: String(run._id),
    job: run.job,
    instanceId: run.instanceId ?? null,
    trigger: run.trigger,
    status: run.status,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    durationMs: run.durationMs ?? null,
    counts: run.counts ?? null,
    error: run.error ?? null,
  };
}

/**
 * Queue probe: per-queue counts for every queue this process has opened,
 * plus whether this process consumes. With BullMQ the counts are Redis-wide
 * (all instances); an unreachable Redis reports `down` within the probe
 * timeout instead of hanging.
 *
 * @returns {Promise<{ status: 'ok'|'degraded'|'down', transport: string, role: string, consumersInProcess: boolean, queues: Array<Object> }>}
 */
export async function getQueueHealth() {
  const started = Date.now();
  const stats = await queueService.getQueueStats({
    timeoutMs: PROBE_TIMEOUT_MS,
    ensureNames: Object.values(QUEUE_NAMES),
  });
  const byName = new Map(stats.map((entry) => [entry.name, entry]));
  const queues = Object.values(QUEUE_NAMES).map((name) => byName.get(name) ?? { name, status: 'idle', initialised: false });
  const anyDown = queues.some((q) => q.status === 'down');
  return {
    status: anyDown ? 'down' : 'ok',
    latencyMs: Date.now() - started,
    transport: env.redis.enabled ? 'bullmq' : 'memory',
    role: getProcessRole(),
    instanceId: getInstanceId(),
    consumersInProcess: runsBackgroundWork(),
    queues,
  };
}

/**
 * Readiness check for the job queue transport (finding ops2.13). With Redis
 * configured, the producer connection must answer a PING within the budget,
 * otherwise every sync/report enqueue would fail with 503 and the instance
 * reports `not_ready`. The in-process transport is always reachable.
 *
 * @param {Object} [options] - injectable for tests.
 * @param {boolean} [options.redisEnabled]
 * @param {() => Promise<unknown>} [options.ping]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<'memory'|'ok'|'down'>}
 */
export async function getQueueReadiness({
  redisEnabled = env.redis.enabled,
  ping = ({ timeoutMs: budget } = {}) => connectorQueue.getQueue().ping({ timeoutMs: budget }),
  timeoutMs = READINESS_QUEUE_TIMEOUT_MS,
} = {}) {
  if (!redisEnabled) return 'memory';
  try {
    await guardProducer(() => ping({ timeoutMs }), { timeoutMs, queue: QUEUE_NAMES.CONNECTOR_SYNC });
    return 'ok';
  } catch {
    return 'down';
  }
}

/** Approximate interval of a cron expression in ms (null when unknown). */
function cronIntervalMs(expr) {
  try {
    const first = nextCronDate(expr, new Date());
    const second = first ? nextCronDate(expr, first) : null;
    return first && second ? second.getTime() - first.getTime() : null;
  } catch {
    return null;
  }
}

/**
 * Scheduler probe: every registered job with its last run, last success and
 * last failure (from JobRun records, so it reflects the worker even when
 * read from a web instance). An enabled job is `overdue` when it has not
 * started within twice its interval (plus a minute of slack); any overdue
 * job or a failing latest run makes the scheduler `degraded`.
 *
 * @returns {Promise<Object>}
 */
export async function getSchedulerHealth() {
  const started = Date.now();
  const now = new Date();
  const registered = getRegisteredJobs();
  const enabled = Boolean(env.scheduler.enabled);
  const latest = await jobRunRepository.latestByJob(registered.map((j) => j.name));
  const uptimeMs = process.uptime() * 1000;

  const jobs = registered.map((job) => {
    const { lastRun, lastSuccess, lastFailure } = latest[job.name] ?? {};
    const intervalMs = cronIntervalMs(job.cronExpression);
    const graceMs = intervalMs ? intervalMs * 2 + 60 * 1000 : null;
    let overdue = false;
    if (enabled && job.enabled && graceMs) {
      overdue = lastRun
        ? now.getTime() - new Date(lastRun.startedAt).getTime() > graceMs
        : uptimeMs > graceMs;
    }
    return {
      name: job.name,
      cronExpression: job.cronExpression,
      enabled: job.enabled,
      intervalMs,
      overdue,
      lastRun: toPublicJobRun(lastRun),
      lastSuccessAt: lastSuccess?.finishedAt ?? lastSuccess?.startedAt ?? null,
      lastFailure: toPublicJobRun(lastFailure),
    };
  });

  const active = jobs.filter((j) => j.enabled);
  const failing = active.some((j) => ['failed', 'abandoned'].includes(j.lastRun?.status));
  const overdue = active.some((j) => j.overdue);
  const lastTickAt = jobs.reduce((acc, j) => {
    const t = j.lastRun?.startedAt ? new Date(j.lastRun.startedAt).getTime() : 0;
    return Math.max(acc, t);
  }, 0);

  return {
    status: !enabled ? 'disabled' : overdue || failing ? 'degraded' : 'ok',
    latencyMs: Date.now() - started,
    enabled,
    lastTickAt: lastTickAt ? new Date(lastTickAt).toISOString() : null,
    process: getSchedulerState(),
    jobs,
  };
}

/**
 * Paginated JobRun history (newest first).
 *
 * @param {Object} [query]
 * @param {string} [query.job] - registered job name.
 * @param {string} [query.status] - one of JOB_RUN_STATUSES.
 * @param {number} [query.page]
 * @param {number} [query.limit]
 * @returns {Promise<{ docs: Array<Object>, total: number, page: number, limit: number, pages: number }>}
 */
export async function listJobRuns({ job, status, page = 1, limit = 20 } = {}) {
  const filter = {};
  if (job !== undefined && job !== '') {
    const names = getRegisteredJobs().map((j) => j.name);
    if (typeof job !== 'string' || !names.includes(job)) {
      throw ApiError.badRequest('Unknown job', [{ field: 'job', message: `must be one of ${names.join(', ')}` }]);
    }
    filter.job = job;
  }
  if (status !== undefined && status !== '') {
    if (typeof status !== 'string' || !JOB_RUN_STATUSES.includes(status)) {
      throw ApiError.badRequest('Invalid status', [{ field: 'status', message: `must be one of ${JOB_RUN_STATUSES.join(', ')}` }]);
    }
    filter.status = status;
  }
  const safePage = Math.max(1, Math.floor(Number(page)) || 1);
  const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 20));
  const result = await jobRunRepository.list({ filter, page: safePage, limit: safeLimit });
  return { ...result, docs: result.docs.map(toPublicJobRun) };
}

/**
 * Connector probe: platform-wide counts by lifecycle and sync status. Many
 * connectors in `error` or with a failed last sync makes it `degraded` (a
 * provider-side problem or a broken release), never `down`.
 *
 * @param {Object} [options] - injectable for tests.
 * @param {() => Promise<Object>} [options.summary]
 * @returns {Promise<Object>}
 */
export async function getConnectorHealth({ summary = () => monitoringRepository.connectorStatusSummary() } = {}) {
  const started = Date.now();
  try {
    const counts = await summary();
    const failing = (counts.byStatus?.error ?? 0) + (counts.bySyncStatus?.failed ?? 0);
    const share = counts.total > 0 ? failing / counts.total : 0;
    return {
      status: counts.total >= 10 && share >= 0.25 ? 'degraded' : 'ok',
      latencyMs: Date.now() - started,
      ...counts,
      failing,
    };
  } catch (err) {
    return { status: 'down', latencyMs: Date.now() - started, error: probeError(err) };
  }
}

/* ------------------------------ aggregate --------------------------------- */

/* ------------------------- mail + retention (2.7) ------------------------- */

/**
 * Mail transport + email outbox health: `disabled` (no transport, mail is
 * not delivered), `down` (transport verify failed or repeated send
 * failures), `degraded` (dead letters or an old backlog), `ok`. With
 * `probe`, an SMTP transport is verified (bounded, cached for a minute).
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.probe=true]
 * @returns {Promise<Object>}
 */
export async function getMailHealth({ probe = true } = {}) {
  const started = Date.now();
  try {
    const health = await outboxService.getOutboxHealth({ probe });
    return { ...health, latencyMs: Date.now() - started };
  } catch (err) {
    return { status: 'degraded', error: 'unavailable', latencyMs: Date.now() - started };
  }
}

/** Paginated outbox messages (recipients masked, variables never returned). */
export async function listOutbox({ status, tenantId, scopeTenantId = null, page, limit } = {}) {
  return outboxService.listMessages({ status, tenantId, scopeTenantId, page, limit });
}

/** Put a dead-lettered message back in the queue. */
export async function requeueOutboxMessage({ id, actor, scopeTenantId = null } = {}) {
  return outboxService.requeueDeadMessage({ id, actor, scopeTenantId });
}

/**
 * Retention surface: every policy with its window and cutoff, the tenants
 * under legal hold, and the cleanup job's latest run (its counts are the
 * per-collection purge report).
 *
 * @returns {Promise<Object>}
 */
export async function getRetentionStatus() {
  const now = new Date();
  const job = getRegisteredJobs().find((j) => j.name === JOB.NAMES.CLEANUP) ?? null;
  const [policies, legalHoldTenantIds, latest] = await Promise.all([
    retentionService.getPolicies({ now }),
    retentionService.getLegalHoldTenantIds(),
    jobRunRepository.latestByJob([JOB.NAMES.CLEANUP]),
  ]);
  const { lastRun, lastSuccess } = latest[JOB.NAMES.CLEANUP] ?? {};
  return {
    checkedAt: now.toISOString(),
    job: {
      name: JOB.NAMES.CLEANUP,
      enabled: Boolean(job?.enabled),
      cronExpression: job?.cronExpression ?? null,
      dryRun: Boolean(env.retention.dryRun),
      batchSize: env.retention.batchSize,
      maxBatchesPerRun: env.retention.maxBatchesPerRun,
    },
    legalHoldTenantIds,
    policies,
    lastRun: toPublicJobRun(lastRun),
    lastSuccessAt: lastSuccess?.finishedAt ?? lastSuccess?.startedAt ?? null,
  };
}

/**
 * Run every probe once (each time-boxed) and roll the result up.
 *
 * Rollup: the database, Redis and the queue transport are hard
 * dependencies (any `down` -> `down`); everything else can only make the
 * platform `degraded`. Disabled dependencies never count.
 *
 * @returns {Promise<Object>}
 */
export async function computeAggregateHealth() {
  const [system, db, websocket, queue, scheduler, redis, storage, smtp, connectors] = await Promise.all([
    withTimeout(getSystemHealth(), PROBE_TIMEOUT_MS),
    withTimeout(getDbHealth(), PROBE_TIMEOUT_MS),
    withTimeout(getWsHealth(), PROBE_TIMEOUT_MS),
    withTimeout(getQueueHealth(), PROBE_TIMEOUT_MS),
    withTimeout(safeProbe(getSchedulerHealth), PROBE_TIMEOUT_MS),
    withTimeout(getRedisHealth(), PROBE_TIMEOUT_MS),
    withTimeout(getStorageHealth(), PROBE_TIMEOUT_MS),
    // verify() can take a full SMTP handshake; it has its own bound.
    getSmtpHealth(),
    withTimeout(getConnectorHealth(), PROBE_TIMEOUT_MS),
  ]);
  // retention: mail/outbox health is reported, not rolled up (mail
  // being down does not make the platform down).
  const mail = await withTimeout(getMailHealth({ probe: false }), PROBE_TIMEOUT_MS);
  return {
    status: rollUp({ critical: [db, redis, queue], other: [system, websocket, scheduler, storage, smtp, connectors] }),
    checkedAt: new Date().toISOString(),
    system,
    db,
    websocket,
    queue,
    scheduler,
    redis,
    storage,
    smtp,
    connectors,
    mail,
  };
}

/**
 * One-shot rollup over every probe. Cached for 5 seconds so the status page
 * never fans out more than once per window. When the cache itself fails
 * (Redis down) the rollup is computed uncached and reports `redis: down`,
 * instead of failing the request with a 500 (finding ops.08).
 *
 * @param {Object} [deps] - injectable for tests.
 * @param {{ getOrSet: Function }} [deps.cache]
 * @param {() => Promise<Object>} [deps.compute]
 * @returns {Promise<Object>}
 */
export async function getAggregateHealth({ cache = cacheService, compute = computeAggregateHealth } = {}) {
  try {
    return await cache.getOrSet(AGGREGATE_CACHE_KEY, compute, AGGREGATE_CACHE_TTL_SEC);
  } catch (err) {
    if (!(err instanceof cacheService.CacheError)) throw err;
    const result = await compute();
    return { ...result, cached: false, cacheError: 'cache unavailable' };
  }
}

/**
 * JSON view of the in-process metrics registry (admin page). The
 * Prometheus text exposition is served at GET /api/v1/metrics.
 *
 * @returns {Promise<{ generatedAt: string, metrics: Array<Object> }>}
 */
export async function getMetrics() {
  return metricsSnapshot();
}

/* ------------------------------ internals -------------------------------- */

/**
 * Roll probe results up: a `down` hard dependency is `down`; any other
 * `down` or `degraded` probe is `degraded`; otherwise `ok`.
 *
 * @param {{ critical: Array<{ status: string }>, other: Array<{ status: string }> }} probes
 * @returns {'ok'|'degraded'|'down'}
 */
export function rollUp({ critical = [], other = [] }) {
  if (critical.some((p) => p?.status === 'down')) return 'down';
  if ([...critical, ...other].some((p) => ['down', 'degraded'].includes(p?.status))) return 'degraded';
  return 'ok';
}

/** Run a probe that may throw (e.g. a DB read) and turn a throw into `down`. */
async function safeProbe(probe) {
  try {
    return await probe();
  } catch (err) {
    return { status: 'down', error: probeError(err) };
  }
}

/** Reject after `timeoutMs` (the original promise keeps running). */
function raceTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Time-box a probe so a hanging subsystem can never block the dashboard.
 * On timeout the probe reports `degraded` with a stable error marker.
 *
 * @param {Promise<any>} probe
 * @param {number} timeoutMs
 * @returns {Promise<Object>} probe result with a guaranteed `status`.
 */
async function withTimeout(probe, timeoutMs) {
  const started = Date.now();
  try {
    const value = await Promise.race([
      Promise.resolve(probe),
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        t.unref?.();
      }),
    ]);
    return { ...(value ?? {}), latencyMs: Date.now() - started };
  } catch {
    return { status: 'degraded', error: 'timeout', latencyMs: Date.now() - started };
  }
}

export default {
  getSystemHealth,
  getDbHealth,
  getWsHealth,
  getQueueHealth,
  getSchedulerHealth,
  listJobRuns,
  getQueueReadiness,
  getRedisHealth,
  getStorageHealth,
  getSmtpHealth,
  getConnectorHealth,
  computeAggregateHealth,
  getAggregateHealth,
  getMetrics,
  rollUp,
  getMailHealth,
  listOutbox,
  requeueOutboxMessage,
  getRetentionStatus,
  PROBE_TIMEOUT_MS,
  AGGREGATE_CACHE_TTL_SEC,
  _meta: { probeTimeoutMs: PROBE_TIMEOUT_MS, aggregateCacheTtlSec: AGGREGATE_CACHE_TTL_SEC },
};
