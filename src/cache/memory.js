/**
 * In-memory cache driver.
 *
 * WHY IT EXISTS
 *   Default cache for development, tests and single-instance deployments.
 *   No external dependency; ideal for local `npm run dev`.
 *
 * RESPONSIBILITY
 *   Return a driver implementing the `CacheDriver` surface shared by every
 *   provider. Single-instance only - use the Redis driver for multi-
 *   instance deployments.
 *
 * DRIVER SURFACE (documented, shared by all providers):
 *   - get(key)                   -> Promise<any | null>
 *   - set(key, value, ttlSec?)   -> Promise<void>
 *   - del(key)                   -> Promise<boolean>
 *   - ttl(key)                   -> Promise<number | -1 | -2>
 *   - increment(key, by)         -> Promise<number>
 *   - flushAll()                 -> Promise<void>
 *   - getOrSet(key, fn, ttlSec)  -> Promise<any>   (memoize helper)
 *   - close()                    -> Promise<void>  (release resources)
 *
 * CONFIG:
 *   { provider: 'memory', ttlDefault, keyPrefix }
 *
 * HOW TO EXTEND
 *   The implementation uses a `Map` + per-key expiry timestamps, applies
 *   `keyPrefix`, and keeps the surface identical to the Redis driver.
 */

const DEFAULT_TTL_SEC = 300;
const DEFAULT_KEY_PREFIX = 'saas:';

/**
 * Create the in-memory cache driver.
 *
 * @param {Object} [config] - { ttlDefault, keyPrefix }.
 * @returns {Object} CacheDriver.
 */
export function createMemoryCache(config = {}) {
  const ttlDefault = Number.isInteger(config.ttlDefault) && config.ttlDefault > 0
    ? config.ttlDefault
    : DEFAULT_TTL_SEC;
  const keyPrefix = typeof config.keyPrefix === 'string' ? config.keyPrefix : DEFAULT_KEY_PREFIX;

  /** @type {Map<string, { value: any, expiresAt: number | null }>} */
  const store = new Map();

  function applyPrefix(key) {
    return keyPrefix + key;
  }

  function isExpired(entry) {
    return entry.expiresAt !== null && entry.expiresAt <= Date.now();
  }

  /**
   * Lazily remove expired entries on read paths so memory does not grow
   * unbounded.
   *
   * @param {string} fullKey
   */
  function purgeIfExpired(fullKey) {
    const entry = store.get(fullKey);
    if (entry && isExpired(entry)) {
      store.delete(fullKey);
    }
  }

  return Object.freeze({
    provider: 'memory',
    config: Object.freeze({ ttlDefault, keyPrefix }),

    async get(key) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error('cache.get requires a non-empty key');
      }
      const fullKey = applyPrefix(key);
      purgeIfExpired(fullKey);
      const entry = store.get(fullKey);
      return entry ? entry.value : null;
    },

    async set(key, value, ttlSec) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error('cache.set requires a non-empty key');
      }
      const fullKey = applyPrefix(key);
      // When ttlSec is omitted the value never expires; an explicit `0`
      // or negative value also opts out so callers can pass user-provided
      // TTLs without sanitising them.
      const effectiveTtl = ttlSec === undefined ? null : ttlSec;
      const expiresAt = Number.isInteger(effectiveTtl) && effectiveTtl > 0
        ? Date.now() + effectiveTtl * 1000
        : null;
      store.set(fullKey, { value, expiresAt });
    },

    async del(key) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error('cache.del requires a non-empty key');
      }
      const fullKey = applyPrefix(key);
      return store.delete(fullKey);
    },

    async ttl(key) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error('cache.ttl requires a non-empty key');
      }
      const fullKey = applyPrefix(key);
      const entry = store.get(fullKey);
      if (!entry) return -2;
      if (entry.expiresAt === null) return -1;
      const remaining = Math.ceil((entry.expiresAt - Date.now()) / 1000);
      if (remaining <= 0) {
        store.delete(fullKey);
        return -2;
      }
      return remaining;
    },

    async increment(key, by = 1) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error('cache.increment requires a non-empty key');
      }
      const fullKey = applyPrefix(key);
      const entry = store.get(fullKey);
      const current = entry ? Number(entry.value) : 0;
      const next = current + Number(by);
      if (!Number.isFinite(next)) {
        throw new Error('cache.increment produced a non-finite value');
      }
      const expiresAt = entry?.expiresAt ?? null;
      store.set(fullKey, { value: next, expiresAt });
      return next;
    },

    async flushAll() {
      store.clear();
    },

    async getOrSet(key, fn, ttlSec) {
      if (typeof fn !== 'function') {
        throw new Error('cache.getOrSet requires a function');
      }
      const fullKey = applyPrefix(key);
      purgeIfExpired(fullKey);
      const entry = store.get(fullKey);
      if (entry) return entry.value;
      const value = await fn();
      // Match the Redis driver's semantics: a `null`/`undefined` miss is NOT
      // memoized, so a later write for the same key is picked up immediately.
      // Only cache concrete values (including empty arrays / empty Sets, which
      // are truthy and legitimate cache hits).
      if (value === null || value === undefined) return value;
      const effectiveTtl = ttlSec === undefined ? null : ttlSec;
      const expiresAt = Number.isInteger(effectiveTtl) && effectiveTtl > 0
        ? Date.now() + effectiveTtl * 1000
        : null;
      store.set(fullKey, { value, expiresAt });
      return value;
    },

    async close() {
      store.clear();
    },
  });
}

export default createMemoryCache;
