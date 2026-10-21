/**
 * Analytics cache (Sprint 5 - implemented).
 *
 * PURPOSE
 *   Thin cache surface for repeated analytics queries. Wraps the shared
 *   `cache.service` so the engine stays a pure database function and the
 *   service layer owns memoisation policy (keying, TTL, hit/miss signalling).
 *
 * WHY A DEDICATED MODULE
 *   - The cache key encodes the *effective* query shape (tenancy + every
 *     parameter) so two tenants can never share a cached result.
 *   - Callers key on the PREPARED query (`engine.prepareQuery`): relative
 *     presets are already resolved to an absolute window in the workspace
 *     time zone, so "today" never serves yesterday's result.
 *   - The key also carries the dataset versions of every connector the
 *     query reads (`Connector.dataVersion`, bumped on each sync/ingest/
 *     purge), so a sync invalidates cached results immediately instead of
 *     after the TTL.
 *   - A single `cachedQuery` helper returns a `{ result, cached }` pair so the
 *     controller/service can surface cache-hit metadata to the client, which
 *     is what makes the "warm cache" UX honest.
 *
 * RESPONSIBILITY
 *   - buildCacheKey(params)        -> stable, tenant-scoped cache key.
 *   - cachedQuery(key, fn, ttlSec) -> { result, cached } with memoisation.
 *   - invalidate(key)              -> drop one key (best-effort).
 *   - invalidateTenant(tenantId)   -> drop every cached result of a tenant
 *                                     (a dataset was deleted or replaced).
 */

// rls: the data access scope is part of the key (no cross-scope hits).
import { accessCacheView } from './dataAccess.service.js';
import { createHash } from 'node:crypto';
import * as cacheService from './cache.service.js';

const PREFIX = 'analytics:query:';
export const DEFAULT_TTL_SEC = 300;

/** Normalise the mutable params into a stable, tenant-scoped key. */
export function buildCacheKey({
  tenantId, connectorIds, filters, filtersOp, filterGroups, dateRange, metrics, groupBy, orderBy, pagination,
  timezone, dataVersions, access, compare,
}) {
  const payload = {
    t: tenantId,
    c: Array.isArray(connectorIds) ? [...connectorIds].sort() : [],
    f: filters,
    o: filtersOp,
    x: filterGroups && filterGroups.length ? filterGroups : undefined,
    d: dateRange,
    m: metrics,
    g: groupBy,
    b: orderBy,
    p: pagination,
    z: timezone,
    v: dataVersions,
    // rls
    a: accessCacheView(access),
    // ai-catalogue: a compared query is a different result.
    k: compare || undefined,
  };
  const digest = createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
  return `${PREFIX}${tenantId}:${digest}`;
}

/**
 * Memoise `fn` for `ttlSec`. On a cache hit the stored result is returned and
 * `cached` is true; otherwise `fn` is invoked, its return value is stored, and
 * `cached` is false. Cache writes are best-effort (a cache failure must never
 * take down a live query).
 *
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @param {number} [ttlSec]
 * @returns {Promise<{ result: T, cached: boolean }>}
 */
export async function cachedQuery(key, fn, ttlSec = DEFAULT_TTL_SEC) {
  const hit = await cacheService.get(key);
  if (hit !== null && hit !== undefined) {
    return { result: hit, cached: true };
  }
  const result = await fn();
  if (result !== null && result !== undefined) {
    try {
      await cacheService.set(key, result, ttlSec);
    } catch {
      // Cache backend unavailable: degrade gracefully, the result is still valid.
    }
  }
  return { result, cached: false };
}

/** Drop a single cached query result. */
export async function invalidate(key) {
  return cacheService.del(key);
}

/**
 * Drop every cached analytics / widget result of a tenant. Used when a
 * dataset is deleted: tenant-wide queries (no connectorIds) include every
 * dataset, so all of the tenant's entries are stale, not only the ones that
 * named the deleted connector. Returns the number of entries removed.
 *
 * @param {string} tenantId
 * @returns {Promise<number>}
 */
export async function invalidateTenant(tenantId) {
  if (!tenantId) return 0;
  return cacheService.delByPrefix(`${PREFIX}${tenantId}:`);
}

export default { buildCacheKey, cachedQuery, invalidate, invalidateTenant, DEFAULT_TTL_SEC };
