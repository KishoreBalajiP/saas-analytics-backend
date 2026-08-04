/**
 * Redis cache driver.
 *
 * WHY IT EXISTS
 *   Production multi-instance deployments need a shared cache. Redis is the
 *   standard choice. `REDIS_URL` is already reserved in `.env.example` and
 *   exposed as `config.redis`.
 *
 * RESPONSIBILITY
 *   Return a driver implementing the same `CacheDriver` surface as every
 *   other provider. Uses `ioredis` under the hood (lazy connection).
 *
 * DRIVER SURFACE (identical to memory.js - see its JSDoc):
 *   get, set, del, ttl, increment, flushAll, getOrSet, close
 *
 * CONFIG:
 *   { provider: 'redis', url, keyPrefix, ttlDefault }
 *
 * HOW TO EXTEND
 *   The driver is provider-pluggable. Switching to KeyDB, DragonflyDB or a
 *   managed offering is a configuration change.
 */

import Redis from 'ioredis';

const DEFAULT_TTL_SEC = 300;
const DEFAULT_KEY_PREFIX = 'saas:';

/**
 * Create the Redis cache driver.
 *
 * @param {Object} [config] - { url, keyPrefix, ttlDefault }.
 * @returns {Object} CacheDriver.
 */
export function createRedisCache(config = {}) {
  const url = typeof config.url === 'string' ? config.url : '';
  const ttlDefault = Number.isInteger(config.ttlDefault) && config.ttlDefault > 0
    ? config.ttlDefault
    : DEFAULT_TTL_SEC;
  const keyPrefix = typeof config.keyPrefix === 'string' ? config.keyPrefix : DEFAULT_KEY_PREFIX;

  let client = null;

  /**
   * Lazily connect. We don't open a connection at creation time so an
   * application can boot even when Redis is temporarily unreachable;
   * individual calls then fail and the caller decides whether to retry.
   *
   * @returns {Redis}
   */
  function getClient() {
    if (client) return client;
    if (!url) {
      throw new Error('Redis cache requires url to be set');
    }
    client = new Redis(url, {
      keyPrefix,
      // Fail fast instead of queueing commands forever when the server is
      // unreachable; the caller can decide whether to retry.
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    return client;
  }

  return Object.freeze({
    provider: 'redis',
    config: Object.freeze({ url, ttlDefault, keyPrefix }),

    async get(key) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error('cache.get requires a non-empty key');
      }
      const raw = await getClient().get(key);
      if (raw === null || raw === undefined) return null;
      try {
        return JSON.parse(raw);
      } catch {
        // If the stored value is not JSON, return the raw string.
        return raw;
      }
    },

    async set(key, value, ttlSec = ttlDefault) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error('cache.set requires a non-empty key');
      }
      const payload = JSON.stringify(value);
      if (Number.isInteger(ttlSec) && ttlSec > 0) {
        await getClient().set(key, payload, 'EX', ttlSec);
      } else {
        await getClient().set(key, payload);
      }
    },

    async del(key) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error('cache.del requires a non-empty key');
      }
      const removed = await getClient().del(key);
      return removed > 0;
    },

    async ttl(key) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error('cache.ttl requires a non-empty key');
      }
      return getClient().ttl(key);
    },

    async increment(key, by = 1) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error('cache.increment requires a non-empty key');
      }
      return getClient().incrby(key, Number(by));
    },

    async flushAll() {
      // SCAN + DEL pattern would be safer on a shared Redis. We keep
      // `flushAll` semantics simple: it uses the configured keyPrefix scope.
      const stream = getClient().scanStream({ match: `${keyPrefix}*`, count: 200 });
      const pipeline = getClient().pipeline();
      await new Promise((resolve, reject) => {
        stream.on('data', (keys) => {
          for (const key of keys) pipeline.del(key);
        });
        stream.on('end', resolve);
        stream.on('error', reject);
      });
      await pipeline.exec();
    },

    async getOrSet(key, fn, ttlSec = ttlDefault) {
      if (typeof fn !== 'function') {
        throw new Error('cache.getOrSet requires a function');
      }
      const cached = await this.get(key);
      if (cached !== null) return cached;
      const value = await fn();
      await this.set(key, value, ttlSec);
      return value;
    },

    async close() {
      if (client) {
        try {
          await client.quit();
        } catch {
          client.disconnect();
        }
        client = null;
      }
    },
  });
}

export default createRedisCache;
