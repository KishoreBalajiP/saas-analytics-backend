/**
 * Redis production-readiness tests.
 *
 * Covers:
 *  - Missing REDIS_URL -> memory driver is used (test/dev mode).
 *  - Empty REDIS_URL + redis provider -> constructor refuses with a clear error.
 *  - Unreachable Redis URL -> get/set reject with a real error (not a swallowed one).
 *  - Cache service selects the right driver based on env.redis.enabled.
 *  - Test-mode compatibility: REDIS_URL= falls back to the memory driver safely.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createCache, CACHE_PROVIDERS } from '../../src/cache/index.js';
import * as cacheService from '../../src/services/cache.service.js';

test('createCache: memory provider works without REDIS_URL', async () => {
  const cache = createCache({ provider: CACHE_PROVIDERS.MEMORY, keyPrefix: 'test:' });
  assert.strictEqual(cache.provider, 'memory');
  await cache.set('k', 'v', 5);
  assert.equal(await cache.get('k'), 'v');
  await cache.close();
});

test('createCache: redis provider without url throws a clear error', async () => {
  const cache = createCache({ provider: CACHE_PROVIDERS.REDIS, url: '' });
  await assert.rejects(
    () => cache.get('anything'),
    /url/i,
    'redis cache driver should reject when no url is configured',
  );
  await cache.close?.();
});

test('createCache: redis provider with unreachable url rejects get/set', async () => {
  // Use a definitely-unreachable URL: 127.0.0.1:1 is reserved (tcpmux) and
  // nothing is listening; ioredis will surface a connect error.
  const cache = createCache({
    provider: CACHE_PROVIDERS.REDIS,
    url: 'redis://127.0.0.1:1',
    keyPrefix: 'test:',
  });
  await assert.rejects(
    () => cache.get('k'),
    /redis|cache|connect|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE/i,
  );
  await cache.close?.();
});

test('cacheService.init() returns a driver object', () => {
  // The test runner clears REDIS_URL, so the memory driver is selected.
  const driver = cacheService.init();
  assert.ok(driver);
  assert.ok(typeof driver.get === 'function');
  assert.ok(typeof driver.set === 'function');
  assert.ok(typeof driver.close === 'function');
});

test('cacheService: when REDIS_URL is empty, driver provider is "memory"', () => {
  // After the test runner clears REDIS_URL, the driver should be memory.
  const driver = cacheService.init();
  assert.strictEqual(driver.provider, 'memory');
});

test('createCache: with REDIS_URL set, driver is "redis" (provider selection)', () => {
  // We verify the provider-selection logic via createCache directly,
  // since cacheService caches the driver after first init().
  const cache = createCache({
    provider: CACHE_PROVIDERS.REDIS,
    url: 'redis://example.invalid:6379',
  });
  assert.strictEqual(cache.provider, 'redis');
  // Do not call get/set on this driver - the URL is invalid by design.
});

test('cacheService: get/set round-trip works with the selected driver', async () => {
  const key = `test:roundtrip:${Date.now()}`;
  await cacheService.set(key, { hello: 'world' }, 5);
  const value = await cacheService.get(key);
  assert.deepEqual(value, { hello: 'world' });
  await cacheService.del(key);
});

test('cacheService: close() is idempotent and safe', async () => {
  // Close should not throw even if called multiple times.
  await cacheService.close();
  await cacheService.close();
  // Re-init after close should still work.
  const driver = cacheService.init();
  assert.ok(driver);
});