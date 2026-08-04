/**
 * Tests for `cache/memory.js` and `services/cache.service.js`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryCache, CACHE_PROVIDERS } from '../../src/cache/index.js';
import * as cacheService from '../../src/services/cache.service.js';

test('memory cache: get/set round-trip', async () => {
  const cache = createMemoryCache({ provider: CACHE_PROVIDERS.MEMORY, keyPrefix: 't:' });
  await cache.set('user:1', { name: 'Ada' }, 60);
  assert.deepEqual(await cache.get('user:1'), { name: 'Ada' });
  await cache.close();
});

test('memory cache: get returns null on miss', async () => {
  const cache = createMemoryCache({ provider: CACHE_PROVIDERS.MEMORY });
  assert.equal(await cache.get('absent'), null);
  await cache.close();
});

test('memory cache: del returns true when key existed', async () => {
  const cache = createMemoryCache({ provider: CACHE_PROVIDERS.MEMORY });
  await cache.set('k', 'v');
  assert.equal(await cache.del('k'), true);
  assert.equal(await cache.del('k'), false);
  await cache.close();
});

test('memory cache: ttl returns -1/-2 appropriately', async () => {
  const cache = createMemoryCache({ provider: CACHE_PROVIDERS.MEMORY });
  await cache.set('ephemeral', 'x');
  assert.equal(await cache.ttl('ephemeral'), -1);
  assert.equal(await cache.ttl('absent'), -2);
  await cache.set('expiring', 'y', 1);
  // Wait > TTL.
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(await cache.ttl('expiring'), -2);
  await cache.close();
});

test('memory cache: increment produces a counter', async () => {
  const cache = createMemoryCache({ provider: CACHE_PROVIDERS.MEMORY });
  assert.equal(await cache.increment('counter'), 1);
  assert.equal(await cache.increment('counter', 5), 6);
  await cache.close();
});

test('memory cache: getOrSet memoizes', async () => {
  const cache = createMemoryCache({ provider: CACHE_PROVIDERS.MEMORY });
  let calls = 0;
  const fn = async () => { calls += 1; return { x: calls }; };
  const first = await cache.getOrSet('k', fn, 60);
  const second = await cache.getOrSet('k', fn, 60);
  assert.deepEqual(first, { x: 1 });
  assert.deepEqual(second, { x: 1 });
  assert.equal(calls, 1);
  await cache.close();
});

test('memory cache: flushAll clears every key', async () => {
  const cache = createMemoryCache({ provider: CACHE_PROVIDERS.MEMORY });
  await cache.set('a', 1);
  await cache.set('b', 2);
  await cache.flushAll();
  assert.equal(await cache.get('a'), null);
  assert.equal(await cache.get('b'), null);
  await cache.close();
});

test('cache service applies the `cache:` prefix', async () => {
  await cacheService.reset();
  await cacheService.set('hello', 'world', 60);
  assert.equal(await cacheService.get('hello'), 'world');
  await cacheService.del('hello');
  assert.equal(await cacheService.get('hello'), null);
});
