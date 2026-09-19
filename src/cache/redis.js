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
 * CONNECTION LIFE CYCLE
 *   A single client is created lazily on first use. Every command awaits the
 *   connection reaching the `ready` state first, so a cold start (first cache
 *   operation after process restart) can never issue a command before Redis
 *   is ready - previously that raced and blew up the first caller.
 *     - Single connection per process (no duplicate clients).
 *     - Asynchronous failures reject instead of being swallowed; the ready
 *       wait is cleared on error so a later call succeeds once Redis is back.
 *     - ioredis keeps reconnecting in the background, so availability dips
 *       degrade to per-call errors rather than a broken driver.
 *
 * HOW TO EXTEND
 *   The driver is provider-pluggable. Switching to KeyDB, DragonflyDB or a
 *   managed offering is a configuration change.
 */

import Redis from 'ioredis';
import logger from '../utils/logger.js';

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
  let readyPromise = null;

  /**
   * Resolve to a connected Redis client (created lazily, exactly once per
   * process). The first call opens the connection and only resolves after
   * Redis emits `ready`, so no command can race the initial handshake.
   *
   * On a connection failure the returned promise rejects with the real
   * error (never swallowed). The ready wait is then cleared so the next
   * call can succeed once ioredis has reconnected. Commands issued while
   * the connection is down fail fast (`enableOfflineQueue: false`) and the
   * caller decides whether to retry.
   *
   * @returns {Promise<Redis>}
   */
  function getClient() {
    if (!client) {
      if (!url) {
        return Promise.reject(new Error('Redis cache requires url to be set'));
      }
      client = new Redis(url, {
        keyPrefix,
        // Fail fast instead of queueing commands forever when the server is
        // unreachable; the caller can decide whether to retry.
        maxRetriesPerRequest: 2,
        enableOfflineQueue: false,
        lazyConnect: false,
      });
      // ioredis throws when an 'error' event has no listener. Connection
      // failures must never crash a request path; the same errors are still
      // surfaced to callers via the rejected commands and ready wait below.
      client.on('error', (err) => {
        logger.warn({ err: { message: err.message } }, 'Redis cache connection error');
      });
    }

    if (client.status === 'ready') {
      readyPromise = null;
      return Promise.resolve(client);
    }

    if (!readyPromise) {
      readyPromise = new Promise((resolve, reject) => {
        const cleanup = () => {
          client.removeListener('ready', onReady);
          client.removeListener('error', onError);
        };
        const onReady = () => {
          cleanup();
          resolve(client);
        };
        const onError = (err) => {
          cleanup();
          readyPromise = null;
          reject(err);
        };
        client.once('ready', onReady);
        client.once('error', onError);
      });
    }
    return readyPromise;
  }

  return Object.freeze({
    provider: 'redis',
    config: Object.freeze({ url, ttlDefault, keyPrefix }),

    async get(key) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error('cache.get requires a non-empty key');
      }
      const raw = await (await getClient()).get(key);
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
      const client = await getClient();
      if (Number.isInteger(ttlSec) && ttlSec > 0) {
        await client.set(key, payload, 'EX', ttlSec);
      } else {
        await client.set(key, payload);
      }
    },

    async del(key) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error('cache.del requires a non-empty key');
      }
      const removed = await (await getClient()).del(key);
      return removed > 0;
    },

    async ttl(key) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error('cache.ttl requires a non-empty key');
      }
      return (await getClient()).ttl(key);
    },

    async increment(key, by = 1) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error('cache.increment requires a non-empty key');
      }
      return (await getClient()).incrby(key, Number(by));
    },

    async flushAll() {
      // SCAN + DEL pattern would be safer on a shared Redis. We keep
      // `flushAll` semantics simple: it uses the configured keyPrefix scope.
      const client = await getClient();
      const stream = client.scanStream({ match: `${keyPrefix}*`, count: 200 });
      const pipeline = client.pipeline();
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
        readyPromise = null;
      }
    },
  });
}

export default createRedisCache;