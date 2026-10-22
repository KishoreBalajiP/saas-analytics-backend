/**
 * Per-tenant analytics query concurrency limiter (in-process).
 *
 * WHY IT EXISTS
 *   Every analytics consumer (the analytics endpoint, dashboard widgets,
 *   public embeds, reports, alerts, the external API) runs aggregations on
 *   the shared MongoDB. Without a bound, one workspace opening several large
 *   dashboards can hold the whole connection pool. The engine runs every
 *   aggregation through `queryLimiter.run(tenantId, fn)`.
 *
 * POLICY
 *   - At most `maxConcurrent` aggregations run at once per tenant.
 *   - Up to `maxQueued` more wait (FIFO) for a slot, each for at most
 *     `queueTimeoutMs`.
 *   - Beyond that, or after waiting too long, the call fails with
 *     429 `QUERY_CONCURRENCY_LIMIT`. Tenants never share slots.
 *
 * SCOPE
 *   The limit is per process. With N API instances a tenant can run up to
 *   N x maxConcurrent queries; a cluster-wide limit needs a shared store.
 */

import ApiError from '../utils/ApiError.js';
import env from '../config/env.js';
// observability: count refusals (analytics_queries_total{outcome="rejected"}).
import { observeAnalyticsQuery } from '../utils/metrics.js';

export const QUERY_CONCURRENCY_LIMIT = 'QUERY_CONCURRENCY_LIMIT';

function limitError() {
  observeAnalyticsQuery('rejected');
  return new ApiError(
    429,
    'Too many analytics queries are running for this workspace. Wait a moment and try again.',
    { code: QUERY_CONCURRENCY_LIMIT },
  );
}

export class TenantConcurrencyLimiter {
  constructor({ maxConcurrent = 4, maxQueued = 16, queueTimeoutMs = 10000 } = {}) {
    this.configure({ maxConcurrent, maxQueued, queueTimeoutMs });
    /** @type {Map<string, { active: number, queue: Array<{ resolve: Function, reject: Function, timer: any }> }>} */
    this.tenants = new Map();
  }

  configure({ maxConcurrent, maxQueued, queueTimeoutMs } = {}) {
    if (maxConcurrent !== undefined) this.maxConcurrent = Math.max(1, Math.floor(Number(maxConcurrent) || 1));
    if (maxQueued !== undefined) this.maxQueued = Math.max(0, Math.floor(Number(maxQueued) || 0));
    if (queueTimeoutMs !== undefined) this.queueTimeoutMs = Math.max(0, Math.floor(Number(queueTimeoutMs) || 0));
    return this;
  }

  state(tenantId) {
    const key = String(tenantId);
    let entry = this.tenants.get(key);
    if (!entry) {
      entry = { active: 0, queue: [] };
      this.tenants.set(key, entry);
    }
    return entry;
  }

  /** Current usage for a tenant (diagnostics and tests). */
  stats(tenantId) {
    const entry = this.tenants.get(String(tenantId));
    return { active: entry?.active ?? 0, queued: entry?.queue.length ?? 0 };
  }

  acquire(tenantId) {
    const entry = this.state(tenantId);
    if (entry.active < this.maxConcurrent) {
      entry.active += 1;
      return Promise.resolve();
    }
    if (entry.queue.length >= this.maxQueued || this.queueTimeoutMs === 0) {
      return Promise.reject(limitError());
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = entry.queue.indexOf(waiter);
        if (index !== -1) entry.queue.splice(index, 1);
        reject(limitError());
      }, this.queueTimeoutMs);
      entry.queue.push(waiter);
    });
  }

  release(tenantId) {
    const key = String(tenantId);
    const entry = this.tenants.get(key);
    if (!entry) return;
    const next = entry.queue.shift();
    if (next) {
      // Hand the slot straight to the next waiter (active count unchanged).
      clearTimeout(next.timer);
      next.resolve();
      return;
    }
    entry.active = Math.max(0, entry.active - 1);
    if (entry.active === 0) this.tenants.delete(key);
  }

  /** Run `fn` once a slot for `tenantId` is free; always releases the slot. */
  async run(tenantId, fn) {
    await this.acquire(tenantId);
    try {
      return await fn();
    } finally {
      this.release(tenantId);
    }
  }
}

/** The process-wide limiter used by the analytics engine. */
export const queryLimiter = new TenantConcurrencyLimiter({
  maxConcurrent: env.analytics.maxConcurrentPerTenant ?? 4,
  maxQueued: env.analytics.maxQueuedPerTenant ?? 16,
  queueTimeoutMs: env.analytics.queueTimeoutMs ?? 10000,
});

export default { TenantConcurrencyLimiter, queryLimiter, QUERY_CONCURRENCY_LIMIT };
