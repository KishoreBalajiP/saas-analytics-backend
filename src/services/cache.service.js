/**
 * Cache service - the only public interface for the cache layer.
 *
 * WHY IT EXISTS
 *   Feature code (controllers, services, middleware) must never reach for
 *   `ioredis`, `Map` or the underlying cache directly. They call this
 *   service which:
 *     1. Resolves a driver lazily on first use.
 *     2. Adds a stable `cache:` prefix so cross-tenant keys can never
 *        collide.
 *     3. Centralises observability + error handling.
 *
 * RESPONSIBILITY
 *   - Lazy driver resolution (memory in dev/tests, Redis when REDIS_URL is
 *     configured).
 *   - Thin pass-through to the driver with typed errors.
 *   - Lifecycle: `init()`, `close()`.
 *
 * DESIGN CONSTRAINTS
 *   - Driver is a singleton per process. Tests can call `reset()` to force
 *     a fresh driver (e.g. between test suites).
 *   - All public methods return promises; failures throw `CacheError`.
 *
 * HOW TO EXTEND
 *   Add a typed helper (e.g. `getOrSetJSON`) by composing the primitives
 *   below. Do not import the underlying driver in feature code.
 */

import env from '../config/env.js';
import { createCache, CACHE_PROVIDERS } from '../cache/index.js';

const KEY_PREFIX = 'cache:';

let driver = null;

/* -------------------------------- errors -------------------------------- */

/**
 * Typed error so callers can map cache failures to HTTP responses.
 */
export class CacheError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CacheError';
    this.code = code;
    this.isOperational = true;
  }
}

/* ------------------------------ lifecycle ------------------------------- */

/**
 * Initialise the cache driver if not already initialised. Idempotent.
 *
 * @returns {Object} the cache driver.
 */
export function init() {
  if (driver) return driver;
  const provider = env.redis.enabled && env.redis.url
    ? CACHE_PROVIDERS.REDIS
    : CACHE_PROVIDERS.MEMORY;
  driver = createCache({
    provider,
    url: env.redis.url,
    ttlDefault: 300,
    keyPrefix: KEY_PREFIX,
  });
  return driver;
}

/**
 * Close the cache driver (releases Redis connection). Safe to call when
 * never initialised.
 *
 * @returns {Promise<void>}
 */
export async function close() {
  if (!driver) return;
  try {
    await driver.close?.();
  } finally {
    driver = null;
  }
}

/**
 * Reset the cache state. Primarily for tests; not for production code.
 */
export async function reset() {
  if (driver) await driver.flushAll?.();
}

/**
 * Return the underlying driver (lazy init). Useful when a helper needs
 * driver-specific behaviour (e.g. SCAN in flushAll).
 *
 * @returns {Object} the cache driver.
 */
export function getDriver() {
  return init();
}

/* ------------------------------- primitives ------------------------------ */

/**
 * Read a value from the cache. Returns `null` on miss.
 *
 * @param {string} key
 * @returns {Promise<any|null>}
 */
export async function get(key) {
  return safe(() => init().get(key));
}

/**
 * Write a value to the cache with an optional TTL in seconds.
 *
 * @param {string} key
 * @param {*} value
 * @param {number} [ttlSec]
 * @returns {Promise<void>}
 */
export async function set(key, value, ttlSec) {
  return safe(() => init().set(key, value, ttlSec));
}

/**
 * Delete a key. Returns `true` when the key existed.
 *
 * @param {string} key
 * @returns {Promise<boolean>}
 */
export async function del(key) {
  return safe(() => init().del(key));
}

/**
 * Get the remaining TTL of a key in seconds.
 * `-1` means no expiry, `-2` means the key does not exist.
 *
 * @param {string} key
 * @returns {Promise<number>}
 */
export async function ttl(key) {
  return safe(() => init().ttl(key));
}

/**
 * Atomically increment a counter.
 *
 * @param {string} key
 * @param {number} [by=1]
 * @returns {Promise<number>}
 */
export async function increment(key, by = 1) {
  return safe(() => init().increment(key, by));
}

/**
 * Memoize: run `fn()` on cache miss and store the result.
 *
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @param {number} [ttlSec]
 * @returns {Promise<T>}
 */
export async function getOrSet(key, fn, ttlSec) {
  return safe(() => init().getOrSet(key, fn, ttlSec));
}

/**
 * Clear the entire cache (or the scoped prefix). Use sparingly.
 *
 * @returns {Promise<void>}
 */
export async function flushAll() {
  return safe(() => init().flushAll());
}

/* -------------------------------- helpers -------------------------------- */

/**
 * Wrap a cache operation, normalising errors to `CacheError`.
 *
 * @param {() => Promise<any>} op
 * @returns {Promise<any>}
 */
async function safe(op) {
  try {
    return await op();
  } catch (err) {
    if (err instanceof CacheError) throw err;
    throw new CacheError('CACHE_OPERATION_FAILED', err?.message ?? 'Cache operation failed');
  }
}

export default {
  init,
  close,
  reset,
  getDriver,
  get,
  set,
  del,
  ttl,
  increment,
  getOrSet,
  flushAll,
  CacheError,
  KEY_PREFIX,
};
