/**
 * Per-tenant query concurrency (roadmap 1.1) and cache coherence through
 * dataset versions (roadmap 1.10).
 */

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { useMongo, resetMongo } from '../helpers/index.js';
import { TenantConcurrencyLimiter, queryLimiter } from '../../src/services/analytics.limiter.js';
import { queryRows } from '../../src/services/analytics.engine.js';
import * as analyticsService from '../../src/services/analytics.service.js';
import * as dashboardService from '../../src/services/dashboard.service.js';
import * as connectorService from '../../src/services/connector.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import connectorRepository from '../../src/repositories/connector.repository.js';
import connectorRowRepository from '../../src/repositories/connectorRow.repository.js';
import { factories } from '../helpers/factories.js';

useMongo();
const { ObjectId } = mongoose.Types;

beforeEach(async () => { await resetMongo(); await cacheService.flushAll(); });

/** A promise plus its resolver, to hold a limiter slot open. */
function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

const isLimit = (err) => err.statusCode === 429 && err.code === 'QUERY_CONCURRENCY_LIMIT';

test('limiter: runs up to maxConcurrent, queues up to maxQueued, then refuses with 429', async () => {
  const limiter = new TenantConcurrencyLimiter({ maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 5000 });
  const g = gate();
  const order = [];
  const first = limiter.run('t1', async () => { order.push('first'); await g.promise; return 1; });
  const second = limiter.run('t1', async () => { order.push('second'); return 2; });
  await assert.rejects(() => limiter.run('t1', async () => 3), isLimit);
  assert.deepEqual(limiter.stats('t1'), { active: 1, queued: 1 });
  // Another tenant is never blocked by t1.
  assert.equal(await limiter.run('t2', async () => 'other'), 'other');
  g.open();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ['first', 'second']);
  assert.deepEqual(limiter.stats('t1'), { active: 0, queued: 0 });
});

test('limiter: a queued call gives up after the queue timeout; failures always release the slot', async () => {
  const limiter = new TenantConcurrencyLimiter({ maxConcurrent: 1, maxQueued: 5, queueTimeoutMs: 20 });
  const g = gate();
  const held = limiter.run('t1', () => g.promise);
  await assert.rejects(() => limiter.run('t1', async () => 'late'), isLimit);
  g.open();
  await held;
  await assert.rejects(() => limiter.run('t1', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await limiter.run('t1', async () => 'free again'), 'free again');
});

test('engine: a tenant at its concurrency limit gets 429 QUERY_CONCURRENCY_LIMIT; other tenants are unaffected', async () => {
  const saved = { maxConcurrent: queryLimiter.maxConcurrent, maxQueued: queryLimiter.maxQueued, queueTimeoutMs: queryLimiter.queueTimeoutMs };
  queryLimiter.configure({ maxConcurrent: 1, maxQueued: 0 });
  const busy = new ObjectId().toString();
  const g = gate();
  const held = queryLimiter.run(busy, () => g.promise);
  try {
    await assert.rejects(() => queryRows({ tenantId: busy }), isLimit);
    await assert.rejects(() => analyticsService.query({ tenantId: busy }), isLimit);
    const other = await queryRows({ tenantId: new ObjectId().toString() });
    assert.equal(other.total, 0);
  } finally {
    g.open();
    await held;
    queryLimiter.configure(saved);
  }
  assert.equal((await queryRows({ tenantId: busy })).total, 0, 'the slot is free again');
});

async function seedWidget(tenantId) {
  const connector = await connectorService.createConnectorRecord({ tenantId, type: 'csv', name: 'Orders', config: { delimiter: ',' } });
  const connectorId = String(connector._id);
  const csv = (rows) => ({ data: { connectorId, tenantId, jobType: 'ingest', payload: { buffer: Buffer.from(rows).toString('base64') } } });
  await connectorService.processSyncMessage(csv('id,amount\n1,100\n2,200\n'));
  const dashboard = await dashboardService.createDashboard({ tenantId, name: 'Revenue' });
  const widget = await dashboardService.createWidget({
    tenantId,
    dashboardId: String(dashboard._id),
    data: { name: 'Total', type: 'kpi', datasetId: connectorId, query: { metrics: [{ op: 'sum', field: 'amount', alias: 'total' }], groupBy: [] } },
  });
  return { connectorId, dashboardId: String(dashboard._id), widgetId: String(widget._id), csv };
}

test('a connector sync bumps the dataset version and invalidates cached widget results', async () => {
  // The sync worker only runs for an existing, active workspace (it cancels
  // syncs of inactive tenants at execution time), so this uses a real tenant.
  const tenantId = String((await factories.tenant.create({ status: 'active' }))._id);
  const { connectorId, dashboardId, widgetId, csv } = await seedWidget(tenantId);
  const v1 = (await connectorRepository.findById(connectorId, { tenantId })).dataVersion;
  assert.ok(v1 >= 1, 'the first sync already bumped the version');

  const first = await dashboardService.executeWidget({ tenantId, dashboardId, widgetId });
  assert.equal(first.cached, false);
  assert.deepEqual(first.result.rows, [{ total: 300 }]);
  const again = await dashboardService.executeWidget({ tenantId, dashboardId, widgetId });
  assert.equal(again.cached, true, 'unchanged data is served from the cache');

  // A new sync through the real worker path adds a row.
  await connectorService.processSyncMessage(csv('id,amount\n3,300\n'));
  const v2 = (await connectorRepository.findById(connectorId, { tenantId })).dataVersion;
  assert.ok(v2 > v1, 'sync bumps the dataset version');

  const after = await dashboardService.executeWidget({ tenantId, dashboardId, widgetId });
  assert.equal(after.cached, false, 'the sync invalidated the cached result before the TTL');
  assert.notEqual(after.cacheKey, first.cacheKey);
  assert.deepEqual(after.result.rows, [{ total: 600 }]);
});

test('analytics endpoint results are invalidated by ingest and by a connector purge', async () => {
  const tenantId = new ObjectId().toString();
  const connector = await connectorRepository.create({ tenantId, type: 'csv', name: 'Orders', status: 'active' });
  const connectorId = String(connector._id);
  await connectorRowRepository.upsertRows(connectorId, tenantId, [{ sourceRowId: 'a', data: { n: 1 } }]);

  const q = { tenantId, connectorIds: [connectorId] };
  const first = await analyticsService.query(q);
  assert.equal(first.total, 1);
  assert.equal((await analyticsService.query(q)).cached, true);

  await connectorRowRepository.upsertRows(connectorId, tenantId, [{ sourceRowId: 'b', data: { n: 2 } }]);
  const afterIngest = await analyticsService.query(q);
  assert.equal(afterIngest.cached, false);
  assert.equal(afterIngest.total, 2);

  // Tenant-wide queries (no connectorIds) are versioned too.
  const wide = await analyticsService.query({ tenantId });
  assert.equal(wide.total, 2);
  await connectorService.deleteConnectorRecord({ tenantId, connectorId });
  const afterDelete = await analyticsService.query({ tenantId });
  assert.equal(afterDelete.cached, false);
  assert.equal(afterDelete.total, 0, 'a deleted dataset is never served from cache');
});

test('dataset versions are tenant scoped', async () => {
  const a = new ObjectId().toString();
  const b = new ObjectId().toString();
  const ca = await connectorRepository.create({ tenantId: a, type: 'csv', name: 'A', status: 'active' });
  await connectorRepository.create({ tenantId: b, type: 'csv', name: 'B', status: 'active' });
  await connectorRowRepository.upsertRows(String(ca._id), a, [{ sourceRowId: 'x', data: { n: 1 } }]);
  const versionsA = await connectorRepository.dataVersions(a);
  const versionsB = await connectorRepository.dataVersions(b);
  assert.deepEqual(versionsA.map((v) => v.version), [1]);
  assert.deepEqual(versionsB.map((v) => v.version), [0]);
  // Asking for another tenant's connector id returns nothing.
  assert.deepEqual(await connectorRepository.dataVersions(b, [String(ca._id)]), []);
});
