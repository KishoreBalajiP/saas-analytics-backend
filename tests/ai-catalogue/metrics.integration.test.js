/**
 * ai-catalogue: metric definitions over HTTP (versioning, approval
 * permission, tenant isolation), metric refs / ratio / count_distinct /
 * period-over-period through the engine, and P7 attribution.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import connectorRepository from '../../src/repositories/connector.repository.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import { AnalyticsQuery } from '../../src/models/AnalyticsQuery.js';
import * as engine from '../../src/services/analytics.engine.js';
import { onboardTenant, memberOf } from '../platform-config/helpers.js';
import * as datasetSchemaService from '../../src/services/datasetSchema.service.js';

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => { await resetMongo(); await rbacCache.clearAll(); await cacheService.flushAll(); });
after(async () => { await stopHttp(); await stopMongo(); });

async function seed(tenantId) {
  const c = await connectorRepository.create({ tenantId, type: 'csv', name: 'Orders', status: 'active', createdBy: 'u1' });
  const rows = [
    ['2024-01-05', 'paid', 100, 'a'], ['2024-01-20', 'refunded', 50, 'b'], ['2024-01-25', 'paid', 30, 'a'],
    ['2024-02-03', 'paid', 200, 'c'], ['2024-02-10', 'paid', 20, 'c'],
  ];
  await ConnectorRow.insertMany(rows.map(([d, s, amount, cust], i) => ({
    tenantId, connectorId: c._id, sourceRowId: `r${i}`, data: { order_date: d, status: s, amount, customer: cust },
  })));
  await datasetSchemaService.profileConnector({ tenantId, connectorId: String(c._id) });
  return String(c._id);
}

const post = (path, headers, body) => api(path, { method: 'POST', headers, body });

test('versioning, approval permission, only approved resolve, tenant isolation', async () => {
  const a = await onboardTenant();
  const b = await onboardTenant();
  const ds = await seed(a.tenantId);
  const created = await post('/api/v1/metrics', a.headers, { key: 'revenue', label: 'Revenue', connectorId: ds, aggregation: 'sum', field: 'amount' });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.data.status, 'draft');

  // Draft does not resolve.
  const draftRun = await api(`/api/v1/analytics?metrics=${encodeURIComponent(JSON.stringify([{ ref: 'metric:revenue' }]))}`, { headers: a.headers });
  assert.equal(draftRun.status, 400);

  const manager = await memberOf(a.tenantId, 'Manager');
  assert.equal((await post('/api/v1/metrics/revenue/versions/1/approve', manager.headers, {})).status, 403);
  const viewer = await memberOf(a.tenantId, 'Viewer');
  assert.equal((await post('/api/v1/metrics', viewer.headers, { key: 'x', label: 'X', connectorId: ds, aggregation: 'count' })).status, 403);
  assert.equal((await api('/api/v1/metrics', { headers: viewer.headers })).status, 200);

  assert.equal((await post('/api/v1/metrics/revenue/versions/1/approve', a.headers, {})).status, 200);
  const v2 = await api('/api/v1/metrics/revenue', { method: 'PATCH', headers: a.headers, body: { filters: [{ field: 'status', op: 'eq', value: 'paid' }] } });
  assert.equal(v2.status, 201);
  assert.equal(v2.json.data.version, 2);
  assert.equal(v2.json.data.status, 'draft');

  const run = async (ref) => (await engine.queryRows({ tenantId: a.tenantId, metrics: [{ ref }] })).rows[0];
  assert.equal((await run('metric:revenue')).revenue, 400, 'latest approved = v1');
  await post('/api/v1/metrics/revenue/versions/2/approve', a.headers, {});
  assert.equal((await run('metric:revenue')).revenue, 350, 'v2 filters paid');
  assert.equal((await run('metric:revenue@1')).revenue, 400, 'old version still resolvable');

  // Tenant isolation.
  assert.equal((await api('/api/v1/metrics/revenue', { headers: b.headers })).status, 404);
  assert.equal((await post('/api/v1/metrics/revenue/versions/2/approve', b.headers, {})).status, 404);
  assert.equal((await post('/api/v1/metrics', b.headers, { key: 'stolen', label: 'S', connectorId: ds, aggregation: 'count' })).status, 400);
  await assert.rejects(engine.queryRows({ tenantId: b.tenantId, metrics: [{ ref: 'metric:revenue' }] }), /Invalid analytics query/);
});

test('ratio, count_distinct, period-over-period and attribution', async () => {
  const a = await onboardTenant();
  const ds = await seed(a.tenantId);
  await post('/api/v1/metrics', a.headers, {
    key: 'paid_share', label: 'Paid share', connectorId: ds, aggregation: 'ratio',
    numerator: { aggregation: 'sum', field: 'amount', filters: [{ field: 'status', op: 'eq', value: 'paid' }] },
    denominator: { aggregation: 'sum', field: 'amount' },
  });
  await post('/api/v1/metrics/paid_share/versions/1/approve', a.headers, {});
  const r = await engine.queryRows({ tenantId: a.tenantId, metrics: [{ ref: 'metric:paid_share' }, { op: 'count_distinct', field: 'customer' }] });
  assert.equal(r.rows[0].paid_share, 350 / 400);
  assert.equal(r.rows[0].count_distinct_customer, 3);

  const q = new URLSearchParams({
    metrics: JSON.stringify([{ op: 'sum', field: 'amount', alias: 'rev' }]),
    dateRange: JSON.stringify({ field: 'order_date', from: '2024-02-01', to: '2024-02-29' }),
    compare: JSON.stringify({ type: 'previous_period' }),
  });
  const cmp = await api(`/api/v1/analytics?${q}`, { headers: a.headers });
  assert.equal(cmp.status, 200, JSON.stringify(cmp.json));
  assert.deepEqual(
    { rev: cmp.json.data[0].rev, prev: cmp.json.data[0].rev_previous, change: cmp.json.data[0].rev_change },
    { rev: 220, prev: 180, change: 40 },
  );
  const hist = await AnalyticsQuery.findById(cmp.json.meta.queryId).lean();
  assert.equal(hist.attribution.source, 'analytics');
  assert.equal(hist.attribution.datasets.length >= 1, true);
  assert.ok(hist.attribution.window.from);

  // Widget with a metric ref records a `run` attribution with the pinned version.
  const dash = await post('/api/v1/dashboards', a.headers, { name: 'D' });
  const w = await post(`/api/v1/dashboards/${dash.json.data._id}/widgets`, a.headers, { name: 'Share', type: 'kpi', datasetId: ds, query: { metrics: [{ ref: 'metric:paid_share' }] } });
  assert.equal(w.status, 201, JSON.stringify(w.json));
  const ex = await api(`/api/v1/dashboards/${dash.json.data._id}/widgets/${w.json.data._id}/execute`, { headers: a.headers });
  assert.equal(ex.status, 200, JSON.stringify(ex.json));
  assert.equal(ex.json.data.rows[0].paid_share, 350 / 400);
  const runRec = await AnalyticsQuery.findOne({ kind: 'run', 'attribution.source': 'widget' }).lean();
  assert.deepEqual(runRec.attribution.metricRefs, [{ key: 'paid_share', version: 1 }]);
  const listed = await api('/api/v1/analytics/queries', { headers: a.headers });
  assert.ok(listed.json.data.every((d) => d.kind !== 'run'));
});

test('profiler suggests drafts', async () => {
  const a = await onboardTenant();
  const ds = await seed(a.tenantId);
  const res = await post('/api/v1/metrics/suggest', a.headers, { connectorId: ds });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const keys = res.json.data.created.map((m) => m.key);
  assert.ok(keys.includes('total_amount'));
  assert.ok(res.json.data.created.every((m) => m.status === 'draft' && m.source === 'profiler'));
});
