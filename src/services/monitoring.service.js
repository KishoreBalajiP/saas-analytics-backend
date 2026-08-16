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
 *   - getQueueHealth       deferred (Phase 3) - returns a structured result
 *   - getSchedulerHealth   deferred (Phase 3) - returns a structured result
 *   - getStorageHealth     deferred (Phase 3) - returns a structured result
 *   - getConnectorHealth   deferred (Phase 3) - returns a structured result
 *   - getAggregateHealth   5 s cached fan-out over the live probes
 *   - getMetrics           deferred (Phase 4) - prometheus exposition
 *
 * CODING GUIDELINES
 *   - Every live probe is wrapped in a 2-second timeout; a hanging probe
 *     reports `{ status: 'degraded', error: 'timeout' }` instead of blocking.
 *   - Probes never throw; they return `{ status, latencyMs?, error? }`.
 *   - `/aggregate` is cached for 5 seconds via `services/cache.service.js`
 *     so the status page cannot hammer the platform.
 *   - Deferred probes are first-class citizens: they return a structured
 *     `{ status: 'deferred', phase }` payload, NOT a 501.
 */

import os from 'node:os';
import mongoose from 'mongoose';
import * as cacheService from './cache.service.js';
import { getIO, isSocketInitialized } from '../websocket/index.js';

export const PROBE_TIMEOUT_MS = 2000;
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

/* --------------------------- deferred probes ----------------------------- */

/**
 * Structured "not available yet" result for subsystems whose probes land in
 * Phase 3. Probes are contract-first: callers get the same shape regardless
 * of whether the subsystem is live, deferred, or degraded.
 *
 * @param {string} phase - planned delivery phase.
 * @returns {{ status: 'deferred', phase: string, error: string }}
 */
function deferred(phase) {
  return {
    status: 'deferred',
    phase,
    error: `probe not available until Phase ${phase}`,
  };
}

/** Queue depth / in-flight / retries (Phase 3, deferred). */
export async function getQueueHealth() {
  return deferred('3');
}

/** Registered cron jobs + last-run status (Phase 3, deferred). */
export async function getSchedulerHealth() {
  return deferred('3');
}

/** Storage provider latency test (Phase 3, deferred). */
export async function getStorageHealth() {
  return deferred('3');
}

/** Connector uptime / last-sync (Phase 3, deferred). */
export async function getConnectorHealth() {
  return deferred('3');
}

/* ------------------------------ aggregate --------------------------------- */

/**
 * One-shot rollup over the live probes. Cached for 5 seconds so the status
 * page never fans out more than once per window. Every live probe is
 * time-boxed; deferred probes resolve immediately.
 *
 * @returns {Promise<{ status: 'ok'|'degraded'|'down', checkedAt: string, system: Object, db: Object, websocket: Object, queue: Object, scheduler: Object, storage: Object, connectors: Object }>}
 */
export async function getAggregateHealth() {
  return cacheService.getOrSet(
    AGGREGATE_CACHE_KEY,
    async () => {
      const [system, db, websocket, queue, scheduler, storage, connectors] = await Promise.all([
        withTimeout(getSystemHealth(), PROBE_TIMEOUT_MS),
        withTimeout(getDbHealth(), PROBE_TIMEOUT_MS),
        withTimeout(getWsHealth(), PROBE_TIMEOUT_MS),
        getQueueHealth(),
        getSchedulerHealth(),
        getStorageHealth(),
        getConnectorHealth(),
      ]);
      return {
        status: deriveOverall([system, db, websocket]),
        checkedAt: new Date().toISOString(),
        system,
        db,
        websocket,
        queue,
        scheduler,
        storage,
        connectors,
      };
    },
    AGGREGATE_CACHE_TTL_SEC,
  );
}

/**
 * Prometheus exposition endpoint (Phase 4, deferred). Returns a structured
 * placeholder so the route is real and never 501s.
 *
 * @returns {Promise<{ status: 'deferred', phase: string, error: string }>}
 */
export async function getMetrics() {
  return deferred('4');
}

/* ------------------------------ internals -------------------------------- */

/**
 * Derive the aggregate status from probe results. Any `down` wins over any
 * `degraded`, which wins over `ok`.
 *
 * @param {Array<{ status: string }>} probes
 * @returns {'ok'|'degraded'|'down'}
 */
function deriveOverall(probes) {
  if (probes.some((p) => p?.status === 'down')) return 'down';
  if (probes.some((p) => p?.status === 'degraded')) return 'degraded';
  return 'ok';
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
  getStorageHealth,
  getConnectorHealth,
  getAggregateHealth,
  getMetrics,
  PROBE_TIMEOUT_MS,
  AGGREGATE_CACHE_TTL_SEC,
  _meta: { probeTimeoutMs: PROBE_TIMEOUT_MS, aggregateCacheTtlSec: AGGREGATE_CACHE_TTL_SEC },
};
