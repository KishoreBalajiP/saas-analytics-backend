import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as cacheService from '../../src/services/cache.service.js';
import * as analyticsCache from '../../src/services/analytics.cache.js';

test('buildCacheKey is deterministic and tenant-scoped', () => {
  const a = analyticsCache.buildCacheKey({ tenantId: 't1', connectorIds: ['x'] });
  const b = analyticsCache.buildCacheKey({ tenantId: 't1', connectorIds: ['x'] });
  const c = analyticsCache.buildCacheKey({ tenantId: 't2', connectorIds: ['x'] });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('cachedQuery miss runs fn and caches; hit returns cached', async () => {
  await cacheService.init();
  await cacheService.flushAll();
  let calls = 0;
  const fn = async () => { calls++; return { rows: [{ a: 1 }] }; };
  const key = `analytics:test:${Math.random()}`;
  const first = await analyticsCache.cachedQuery(key, fn, 60);
  assert.equal(first.cached, false);
  assert.deepEqual(first.result, { rows: [{ a: 1 }] });
  assert.equal(calls, 1);
  const second = await analyticsCache.cachedQuery(key, fn, 60);
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
  await cacheService.del(key);
});

test('cachedQuery treats null result as a miss', async () => {
  await cacheService.flushAll();
  const key = `analytics:test:null:${Math.random()}`;
  let calls = 0;
  const fn = async () => { calls++; return null; };
  const a = await analyticsCache.cachedQuery(key, fn, 60);
  assert.equal(a.cached, false);
  assert.equal(a.result, null);
  assert.equal(calls, 1);
});
