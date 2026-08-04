/**
 * In-memory cache provider placeholder.
 *
 * WHY IT EXISTS
 *   Default cache for development/tests and single-instance deployments - no
 *   external dependency, ideal for local `npm run dev`.
 *
 * RESPONSIBILITY
 *   Return a driver implementing the same `CacheDriver` surface as every other
 *   provider. PLACEHOLDER - all methods fail closed until implemented.
 *
 * DRIVER SURFACE (documented, shared by all providers):
 *   - get(key)                 -> Promise<any | null>
 *   - set(key, value, ttlSec?) -> Promise<void>
 *   - del(key)                 -> Promise<boolean>
 *   - ttl(key)                 -> Promise<number | -1 | -2>
 *   - increment(key, by)       -> Promise<number>
 *   - flushAll()               -> Promise<void>
 *   - getOrSet(key, fn, ttlSec) -> Promise<any>   (memoize helper)
 *
 * CONFIG (future):
 *   { provider: 'memory', ttlDefault: 300, keyPrefix: 'saas:' }
 *
 * HOW TO EXTEND
 *   Implement with a `Map` + per-key expiry timestamps, apply `keyPrefix`,
 *   and keep the surface identical. Note: single-instance only - use the
 *   Redis provider for multi-instance deployments.
 */

import { createStubDriver } from '../utils/stubs.js';

const DRIVER_METHODS = ['get', 'set', 'del', 'ttl', 'increment', 'flushAll', 'getOrSet'];

/**
 * Create the in-memory cache driver.
 * PLACEHOLDER - returns a fail-closed stub in Phase 1.1.
 *
 * @param {Object} [config] - { ttlDefault, keyPrefix }.
 * @returns {Object} CacheDriver (stub).
 */
export function createMemoryCache(config = {}) {
  return Object.freeze({
    provider: 'memory',
    config: Object.freeze({
      ttlDefault: config.ttlDefault ?? 300,
      keyPrefix: config.keyPrefix ?? 'saas:',
    }),
    ...createStubDriver('memoryCache', DRIVER_METHODS),
  });
}
