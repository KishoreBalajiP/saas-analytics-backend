/**
 * Redis cache provider placeholder.
 *
 * WHY IT EXISTS
 *   Production multi-instance deployments need a shared cache; Redis is the
 *   standard choice. `REDIS_URL` is already reserved in `.env.example` and
 *   exposed as `config.redis`.
 *
 * RESPONSIBILITY
 *   Return a driver implementing the same `CacheDriver` surface as every other
 *   provider. PLACEHOLDER - all methods fail closed until implemented.
 *
 * DRIVER SURFACE (identical to memory.js - see its JSDoc):
 *   get, set, del, ttl, increment, flushAll, getOrSet
 *
 * CONFIG (future):
 *   { provider: 'redis', url, keyPrefix, ttlDefault }
 *
 * HOW TO EXTEND
 *   Implement with `redis` (or `ioredis`) from `config.redis.url`, apply
 *   `keyPrefix`, and add `getOrSet` via Lua/`get`+`set nx` for atomic
 *   memoization. Keep the driver surface identical so callers never change.
 */

import { createStubDriver } from '../utils/stubs.js';

const DRIVER_METHODS = ['get', 'set', 'del', 'ttl', 'increment', 'flushAll', 'getOrSet'];

/**
 * Create the Redis cache driver.
 * PLACEHOLDER - returns a fail-closed stub in Phase 1.1.
 *
 * @param {Object} [config] - { url, keyPrefix, ttlDefault }.
 * @returns {Object} CacheDriver (stub).
 */
export function createRedisCache(config = {}) {
  return Object.freeze({
    provider: 'redis',
    config: Object.freeze({
      url: config.url ?? '',
      keyPrefix: config.keyPrefix ?? 'saas:',
      ttlDefault: config.ttlDefault ?? 300,
    }),
    ...createStubDriver('redisCache', DRIVER_METHODS),
  });
}
