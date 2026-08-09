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
 *   - A single `cachedQuery` helper returns a `{ result, cached }` pair so the
 *     controller/service can surface cache-hit metadata to the client, which
 *     is what makes the "warm cache" UX honest.
 *
 * RESPONSIBILITY
 *   - buildCacheKey(params)        -> stable, tenant-scoped cache key.
 *   - cachedQuery(key, fn, ttlSec) -> { result, cached } with memoisation.
 *   - invalidate(key)              -> drop one key (best-effort).
 */

import { createHash } from 'node:crypto';
import * as cacheService from './cache.service.js';

const PREFIX = 'analytics:query:';
export const DEFAULT_TTL_SEC = 300;

/** Normalise the mutable params into a stable, tenant-scoped key. */
export function buildCacheKey({ tenantId, connectorIds, filters, filtersOp, dateRange, metrics, groupBy, orderBy, pagination }) {
  const payload = {
    t: tenantId,
    c: Array.isArray(connectorIds) ? [...connectorIds].sort() : [],
    f: filters,
    o: filtersOp,
    d: dateRange,
    m: metrics,
    g: groupBy,
    b: orderBy,
    p: pagination,
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

export default { buildCacheKey, cachedQuery, invalidate, DEFAULT_TTL_SEC };
