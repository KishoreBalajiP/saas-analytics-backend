/**
 * Cache abstraction facade (placeholder).
 *
 * WHY IT EXISTS
 *   Analytics queries and connector previews are good cache targets. Where the
 *   cache physically lives (in-memory for dev, Redis for production) is a
 *   deployment concern; this facade keeps business logic on one interface.
 *
 * RESPONSIBILITY
 *   - Define the canonical provider names.
 *   - Route `createCache(config)` to the right provider factory.
 *   - Each provider returns a driver with the SAME method surface.
 *
 * HOW TO EXTEND
 *   Add a provider by creating `<name>.js` exporting a factory returning the
 *   documented driver surface, then map it here. Selection is config-driven.
 *
 *   ```js
 *   import { createCache } from '../cache/index.js';
 *   const cache = createCache({ provider: CACHE_PROVIDERS.REDIS, url: 'redis://...' });
 *   await cache.set('dash:abc', payload, 300);
 *   ```
 */

import { createMemoryCache } from './memory.js';
import { createRedisCache } from './redis.js';

/** Canonical cache providers. */
export const CACHE_PROVIDERS = Object.freeze({
  MEMORY: 'memory',
  REDIS: 'redis',
});

/**
 * Create a cache driver for the requested provider.
 * PLACEHOLDER in Phase 1.1 - providers return fail-closed stubs.
 *
 * @param {Object} [config] - { provider, ttlDefault?, url?, keyPrefix?, ... }.
 * @returns {Object} CacheDriver (stub until implemented).
 */
export function createCache(config = {}) {
  const provider = config.provider ?? CACHE_PROVIDERS.MEMORY;
  switch (provider) {
    case CACHE_PROVIDERS.MEMORY:
      return createMemoryCache(config);
    case CACHE_PROVIDERS.REDIS:
      return createRedisCache(config);
    default:
      throw new Error(`Unknown cache provider "${provider}"`);
  }
}

export { createMemoryCache, createRedisCache };

export default {
  CACHE_PROVIDERS,
  createCache,
  createMemoryCache,
  createRedisCache,
};
