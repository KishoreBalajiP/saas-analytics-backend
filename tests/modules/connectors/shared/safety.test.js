/**
 * Unit tests for connector safety helpers: the sync deadline, tenant-safe
 * error mapping, and the cache primitives behind replay protection and
 * analytics invalidation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { withDeadline, ingestRecords } from '../../../../src/modules/connectors/shared/sync-engine.js';
import { toPublicSyncError, ConnectorError, RowLimitError } from '../../../../src/modules/connectors/shared/errors.js';
import { createMemoryCache } from '../../../../src/cache/memory.js';
import * as cacheService from '../../../../src/services/cache.service.js';
import { buildCacheKey, invalidateTenant } from '../../../../src/services/analytics.cache.js';
import { claimDelivery, releaseDelivery } from '../../../../src/modules/connectors/webhook/webhook.replay.js';

test('withDeadline fails a stalled source within the budget and asks it to clean up', async () => {
  let returned = false;
  const stalled = {
    [Symbol.asyncIterator]() {
      let n = 0;
      return {
        next: () => (n++ < 2 ? Promise.resolve({ value: { i: n }, done: false }) : new Promise(() => {})),
        return: () => { returned = true; return Promise.resolve({ done: true }); },
      };
    },
  };
  const started = Date.now();
  const seen = [];
  await assert.rejects(async () => {
    for await (const r of withDeadline(stalled, 150)) seen.push(r);
  }, (e) => e.code === 'CONNECTOR_SYNC_TIMEOUT');
  assert.ok(Date.now() - started < 2000, 'fails close to the budget');
  assert.equal(seen.length, 2);
  await new Promise((r) => setImmediate(r));
  assert.equal(returned, true);
});

test('withDeadline passes arrays and fast sources through unchanged', async () => {
  const result = await ingestRecords({ records: withDeadline([{ a: 1 }, { a: 2 }], 1000) });
  assert.equal(result.processed, 2);
});

test('toPublicSyncError never echoes driver / network messages', () => {
  const driver = new Error('connect ECONNREFUSED 10.0.0.5:27017 (user admin:hunter2@db.internal)');
  for (const type of ['mongodb', 'csv', 'xlsx', 'webhook', undefined]) {
    const out = toPublicSyncError(driver, type);
    for (const leak of ['10.0.0.5', 'hunter2', 'db.internal', 'ECONNREFUSED', 'admin']) {
      assert.equal(out.message.includes(leak), false, `${type}: leaks ${leak}`);
    }
  }
  assert.equal(toPublicSyncError(driver, 'mongodb').code, 'CONNECTOR_SOURCE_UNAVAILABLE');
  // Our own messages pass through (they are written to be safe).
  assert.equal(toPublicSyncError(new RowLimitError(10), 'csv').code, 'ROW_LIMIT_EXCEEDED');
  const csvErr = Object.assign(new Error('Invalid Record Length: expect 2, got 3 on line 4'), { code: 'CSV_RECORD_INCONSISTENT_COLUMNS' });
  assert.match(toPublicSyncError(csvErr, 'csv').message, /line 4/);
  assert.equal(toPublicSyncError(new ConnectorError('X', 'safe text'), 'mongodb').message, 'safe text');
});

test('memory cache: setIfAbsent is a one-time claim with TTL; delByPrefix removes only the prefix', async () => {
  const cache = createMemoryCache({ keyPrefix: 't:' });
  assert.equal(await cache.setIfAbsent('claim', 1, 60), true);
  assert.equal(await cache.setIfAbsent('claim', 1, 60), false);
  await cache.set('analytics:query:A:1', 1);
  await cache.set('analytics:query:A:2', 2);
  await cache.set('analytics:query:B:1', 3);
  assert.equal(await cache.delByPrefix('analytics:query:A:'), 2);
  assert.equal(await cache.get('analytics:query:B:1'), 3);
});

test('analytics invalidateTenant drops only that tenant\'s cached results', async () => {
  const keyA = buildCacheKey({ tenantId: 'tenant-A', connectorIds: ['c1'] });
  const keyA2 = `${buildCacheKey({ tenantId: 'tenant-A' })}:widget:w1`;
  const keyB = buildCacheKey({ tenantId: 'tenant-B', connectorIds: ['c1'] });
  await cacheService.set(keyA, { rows: [] }, 300);
  await cacheService.set(keyA2, { rows: [] }, 300);
  await cacheService.set(keyB, { rows: [] }, 300);
  assert.equal(await invalidateTenant('tenant-A'), 2);
  assert.equal(await cacheService.get(keyA), null);
  assert.equal(await cacheService.get(keyA2), null);
  assert.deepEqual(await cacheService.get(keyB), { rows: [] });
});

test('replay store: first claim wins, the second is a replay, release allows a retry', async () => {
  const claim = { connectorId: 'c-replay', signature: 'ab'.repeat(32), ttlSeconds: 60 };
  assert.equal(await claimDelivery(claim), true);
  assert.equal(await claimDelivery(claim), false);
  assert.equal(await claimDelivery({ ...claim, connectorId: 'other' }), true, 'claims are per connector');
  await releaseDelivery(claim);
  assert.equal(await claimDelivery(claim), true);
});

test('redis prefix delete: SCAN pattern carries the client prefix, DEL keys do not (ioredis re-adds it)', async () => {
  const { prefixScan } = await import('../../../../src/cache/redis.js');
  const { pattern, toCommandKey } = prefixScan('cache:', 'analytics:query:t1:');
  assert.equal(pattern, 'cache:analytics:query:t1:*');
  assert.equal(toCommandKey('cache:analytics:query:t1:abc'), 'analytics:query:t1:abc');
  assert.equal(toCommandKey('cache:analytics:query:t2:abc'), null, 'never deletes outside the prefix');
  assert.equal(prefixScan('cache:', 'a*b?[c]').pattern, 'cache:a\\*b\\?\\[c\\]*', 'glob characters are escaped');
});

test('dependencyHealth: only updates that touch a reference field can repair a broken dependant', async () => {
  const { updateTouchesFields } = await import('../../../../src/models/plugins/dependencyHealth.js');
  const fields = ['source', 'widgetId', 'query'];
  assert.equal(updateTouchesFields({ $set: { 'query': { datasetId: 'x' } } }, fields), true);
  assert.equal(updateTouchesFields({ $set: { 'query.datasetId': 'x' } }, fields), true);
  assert.equal(updateTouchesFields({ $set: { widgetId: 'w2' } }, fields), true);
  assert.equal(updateTouchesFields({ $set: { lastEvaluatedAt: new Date(), nextEvaluationAt: null } }, fields), false);
  assert.equal(updateTouchesFields({ $push: { runs: {} }, $set: { lastRun: {} } }, fields), false);
  assert.equal(updateTouchesFields({ $set: { 'runs.$.status': 'ok' } }, fields), false);
  assert.equal(updateTouchesFields({ datasetId: 'x' }, ['datasetId']), true);
  assert.equal(updateTouchesFields(null, fields), false);
});

test('dependencyHealth: updateEnables detects a schedule switched back on (direct path or inside its parent object)', async () => {
  const { updateEnables } = await import('../../../../src/models/plugins/dependencyHealth.js');
  assert.equal(updateEnables({ $set: { enabled: true } }, ['enabled']), true);
  assert.equal(updateEnables({ $set: { enabled: false } }, ['enabled']), false);
  assert.equal(updateEnables({ $set: { name: 'x' } }, ['enabled']), false);
  assert.equal(updateEnables({ $set: { schedule: { enabled: true, cron: '0 * * * *' } } }, ['schedule.enabled']), true);
  assert.equal(updateEnables({ $set: { 'schedule.enabled': true } }, ['schedule.enabled']), true);
  assert.equal(updateEnables({ $set: { schedule: { enabled: false } } }, ['schedule.enabled']), false);
  assert.equal(updateEnables({ enabled: true }, ['enabled']), true, 'plain (non-operator) update');
  assert.equal(updateEnables([{ $set: { enabled: true } }], ['enabled']), false, 'pipelines are not inspected');
  assert.equal(updateEnables(null, ['enabled']), false);
  assert.equal(updateEnables({ $set: { enabled: true } }, []), false);
});
