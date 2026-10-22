/**
 * Readiness: dependency-aware ready / degraded / not-ready evaluation
 * (roadmap 2.8, findings ops.07, ops2.05, ops.05, ops2.02, ops2.12).
 *
 * WHY IT EXISTS
 *   `/health` answers "is the process alive" (cheap, always 200). An
 *   orchestrator, a load balancer and an uptime monitor also need "can this
 *   instance serve traffic", which depends on MongoDB, Redis and the job
 *   queue, and operators want early warning when slower dependencies
 *   (object storage, SMTP, the scheduler on the worker) fail. This module
 *   evaluates both and is shared by `GET /health/ready`, the public
 *   `GET /status` summary and the `analivo_dependency_up` metric.
 *
 * SEMANTICS
 *   critical      database, redis (when REDIS_URL is set), queue transport.
 *                 Checked on every call, each within READINESS_CHECK_TIMEOUT_MS.
 *                 Any `down` -> `not_ready` (HTTP 503: take the instance out
 *                 of rotation, and restart it if it persists).
 *   non-critical  storage, scheduler heartbeat (JobRun records written by the
 *                 worker), SMTP. Re-checked at most every
 *                 READINESS_CACHE_TTL_MS (SMTP: READINESS_SMTP_TTL_MS), in
 *                 the background once a value exists, so probes stay fast.
 *                 Any `down`/`degraded` -> `degraded` (HTTP 200: keep
 *                 serving, alert someone).
 *   Check statuses: ok | degraded | down | disabled | unknown.
 *
 *   Status transitions are logged once (warn when a dependency fails, info
 *   when it recovers), so the logs show when e.g. SMTP went down.
 *
 * OUTPUT
 *   Component names and statuses only: no hosts, versions, latencies or
 *   error text (the readiness endpoint is unauthenticated).
 */

import env from '../config/env.js';
import logger from '../utils/logger.js';
import { isDatabaseConnected } from '../config/database.js';
import * as monitoringService from './monitoring.service.js';
import { dependencyUp, registerCollector } from '../utils/metrics.js';

export const CRITICAL_CHECKS = Object.freeze(['database', 'redis', 'queue']);
export const NON_CRITICAL_CHECKS = Object.freeze(['storage', 'scheduler', 'smtp']);
const PROBLEM = new Set(['down', 'degraded']);

function bound(promise, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve().then(() => promise),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ status: 'down', timedOut: true }), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Default probes; every one resolves to `{ status }` and never throws. */
export function defaultChecks() {
  return {
    database: async () => ({ status: isDatabaseConnected() ? 'ok' : 'down' }),
    redis: () => monitoringService.getRedisHealth(),
    queue: async () => {
      const state = await monitoringService.getQueueReadiness();
      return { status: state === 'down' ? 'down' : 'ok', transport: state === 'memory' ? 'memory' : 'redis' };
    },
    storage: () => monitoringService.getStorageHealth(),
    scheduler: async () => {
      if (!env.scheduler.enabled) return { status: 'disabled' };
      if (!isDatabaseConnected()) return { status: 'unknown' };
      const health = await monitoringService.getSchedulerHealth();
      return { status: health.status === 'disabled' ? 'disabled' : health.status };
    },
    smtp: () => monitoringService.getSmtpHealth(),
  };
}

/**
 * Build a readiness evaluator. The module exports one configured instance;
 * tests build their own with fake checks and a fake clock.
 *
 * @param {Object} [options]
 * @param {Object<string, () => Promise<{status: string}>>} [options.checks]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.cacheTtlMs]
 * @param {number} [options.smtpTtlMs]
 * @param {() => number} [options.now]
 * @param {Object} [options.log]
 */
export function createReadiness({
  checks = defaultChecks(),
  timeoutMs = env.observability?.readinessCheckTimeoutMs ?? 1500,
  cacheTtlMs = env.observability?.readinessCacheTtlMs ?? 30000,
  smtpTtlMs = env.observability?.smtpCheckTtlMs ?? 120000,
  now = () => Date.now(),
  log = logger,
} = {}) {
  /** name -> { status, checkedAt, refreshing } */
  const cache = new Map();
  /** name -> last status seen (transition logging) */
  const lastStatus = new Map();

  function noteTransition(name, status) {
    const previous = lastStatus.get(name);
    lastStatus.set(name, status);
    if (previous === undefined || previous === status) {
      if (previous === undefined && PROBLEM.has(status)) {
        log.warn({ dependency: name, status }, `dependency ${name} is ${status}`);
      }
      return;
    }
    if (PROBLEM.has(status)) {
      log.warn({ dependency: name, status, previous }, `dependency ${name} is ${status}`);
    } else if (PROBLEM.has(previous)) {
      log.info({ dependency: name, status, previous }, `dependency ${name} recovered`);
    }
  }

  async function run(name, budget = timeoutMs) {
    const probe = checks[name];
    if (typeof probe !== 'function') return 'disabled';
    let status;
    try {
      const result = await bound(probe(), budget);
      status = typeof result?.status === 'string' ? result.status : 'unknown';
    } catch {
      status = 'down';
    }
    noteTransition(name, status);
    return status;
  }

  function ttlFor(name) {
    return name === 'smtp' ? smtpTtlMs : cacheTtlMs;
  }

  /** Cached non-critical check: refresh in the background once a value exists. */
  async function cached(name, { fresh }) {
    const entry = cache.get(name);
    const age = entry ? now() - entry.checkedAt : Infinity;
    if (entry && !fresh && age < ttlFor(name)) return entry.status;
    if (entry && !fresh) {
      if (!entry.refreshing) {
        entry.refreshing = true;
        // SMTP verify may take a full handshake: give it its own budget.
        run(name, name === 'smtp' ? Math.max(timeoutMs, env.mail?.connectionTimeoutMs ?? 10000) : timeoutMs)
          .then((status) => cache.set(name, { status, checkedAt: now(), refreshing: false }))
          .catch(() => { entry.refreshing = false; });
      }
      return entry.status;
    }
    const status = await run(name);
    cache.set(name, { status, checkedAt: now(), refreshing: false });
    return status;
  }

  /**
   * Evaluate readiness.
   *
   * @param {Object} [options]
   * @param {boolean} [options.fresh=false] - bypass the non-critical cache.
   * @returns {Promise<{ status: 'ready'|'degraded'|'not_ready', checks: Object<string, string>, checkedAt: string }>}
   */
  async function check({ fresh = false } = {}) {
    const names = [...CRITICAL_CHECKS, ...NON_CRITICAL_CHECKS].filter((name) => checks[name]);
    const statuses = await Promise.all(names.map((name) => (
      CRITICAL_CHECKS.includes(name) ? run(name) : cached(name, { fresh })
    )));
    const result = Object.fromEntries(names.map((name, i) => [name, statuses[i]]));
    const criticalDown = CRITICAL_CHECKS.some((name) => result[name] === 'down');
    const anyProblem = names.some((name) => PROBLEM.has(result[name]));
    return {
      status: criticalDown ? 'not_ready' : anyProblem ? 'degraded' : 'ready',
      checks: result,
      checkedAt: new Date(now()).toISOString(),
    };
  }

  function reset() {
    cache.clear();
    lastStatus.clear();
  }

  return { check, reset };
}

/** Process-wide evaluator. */
export const readiness = createReadiness();

/* --------------------------- public status page --------------------------- */

/** Public component names (no internal topology). */
const PUBLIC_COMPONENTS = Object.freeze({
  api: ['database', 'redis', 'queue'],
  background_jobs: ['queue', 'scheduler'],
  file_storage: ['storage'],
  email_delivery: ['smtp'],
});

function publicState(statuses) {
  const known = statuses.filter((s) => s && s !== 'disabled' && s !== 'unknown');
  if (known.length === 0) return 'operational';
  if (known.includes('down')) return 'outage';
  if (known.includes('degraded')) return 'degraded';
  return 'operational';
}

/**
 * Public summary of component health: `operational | degraded | outage` per
 * component and overall. Built from a readiness result.
 *
 * @param {{ checks: Object<string, string>, checkedAt: string }} result
 * @returns {{ status: string, components: Object<string, string>, updatedAt: string }}
 */
export function toPublicStatus(result) {
  const components = {};
  for (const [component, deps] of Object.entries(PUBLIC_COMPONENTS)) {
    const present = deps.filter((dep) => dep in (result.checks ?? {}));
    if (present.length === 0) continue;
    // Email is "operational" when it is simply not configured.
    components[component] = publicState(present.map((dep) => result.checks[dep]));
  }
  const states = Object.values(components);
  const status = components.api === 'outage'
    ? 'outage'
    : states.some((s) => s !== 'operational') ? 'degraded' : 'operational';
  return { status, components, updatedAt: result.checkedAt };
}

let statusCache = null;

/**
 * Cached public status (STATUS_CACHE_TTL_MS) so an unauthenticated endpoint
 * cannot drive dependency checks.
 *
 * @param {Object} [options]
 * @param {ReturnType<typeof createReadiness>} [options.evaluator]
 * @param {number} [options.ttlMs]
 * @returns {Promise<Object>}
 */
export async function getPublicStatus({
  evaluator = readiness,
  ttlMs = env.observability?.statusCacheTtlMs ?? 15000,
} = {}) {
  if (statusCache && Date.now() - statusCache.at < ttlMs && statusCache.evaluator === evaluator) {
    return statusCache.value;
  }
  const value = toPublicStatus(await evaluator.check());
  statusCache = { at: Date.now(), value, evaluator };
  return value;
}

/** Test hook. */
export function resetPublicStatusCache() {
  statusCache = null;
}

/* ------------------------------ metrics hook ------------------------------ */

const UP_VALUE = { ok: 1, degraded: 0.5, down: 0 };

/** Scrape-time: analivo_dependency_up{dependency} from the readiness checks. */
async function dependencyCollector() {
  const result = await readiness.check();
  for (const [name, status] of Object.entries(result.checks)) {
    if (status in UP_VALUE) dependencyUp.set({ dependency: name }, UP_VALUE[status]);
  }
}
dependencyCollector.collectorName = 'dependencies';
registerCollector(dependencyCollector);

export default { readiness, createReadiness, defaultChecks, toPublicStatus, getPublicStatus, CRITICAL_CHECKS, NON_CRITICAL_CHECKS };
