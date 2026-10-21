/**
 * One strict query contract for every consumer (roadmap 1.1), over real HTTP.
 *
 * Each rejection rule (unknown keys, bad operators, bad fields, bad types,
 * bad presets, bad buckets) is sent through every consumer path that accepts
 * a query: the analytics endpoint and export, widget authoring, dashboard
 * filters and widget execution overrides, reports (query, filters, run
 * overrides), alerts (definition and evaluation), and the external API. Every one must answer 400
 * INVALID_QUERY with a field-level error at the right path. Valid queries
 * keep working on every path, and the concurrency limit answers 429.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import { shortToken } from '../../src/utils/id.js';
import * as tenantService from '../../src/services/tenant.service.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import connectorRepository from '../../src/repositories/connector.repository.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import { Widget } from '../../src/models/Widget.js';
import { AlertRule } from '../../src/models/AlertRule.js';
import { queryLimiter } from '../../src/services/analytics.limiter.js';
// billing: tenants exercising paid features need a plan that includes them.
import { entitleTenant } from '../helpers/billing.js';

const PASSWORD = 'Password123!';

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => { await resetMongo(); await rbacCache.clearAll(); await cacheService.flushAll(); });
after(async () => { await stopHttp(); await stopMongo(); });

async function onboard() {
  const owner = { email: `owner-${shortToken(10).toLowerCase()}@example.com`, name: 'Owner', password: PASSWORD };
  const { tenant } = await tenantService.create({ tenant: { name: `Contract ${shortToken(10)}` }, owner, initialize: true, by: 'root' });
  await entitleTenant(tenant._id);
  const tenantId = tenant._id.toString();
  const login = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email: owner.email, password: PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  const auth = { authorization: `Bearer ${login.json.data.accessToken}`, 'X-Tenant-Id': tenantId };
  const connector = await connectorRepository.create({ tenantId, type: 'csv', name: 'Orders', status: 'active', createdBy: 'u1' });
  await ConnectorRow.insertMany([
    { tenantId, connectorId: connector._id, sourceRowId: 'r1', data: { region: 'EU', amount: '100', order_date: '2024-01-02' } },
    { tenantId, connectorId: connector._id, sourceRowId: 'r2', data: { region: 'US', amount: '200', order_date: '2024-02-03' } },
  ]);
  return { tenantId, auth, datasetId: String(connector._id) };
}

/** Violations of the full query contract, with the error path they produce. */
const QUERY_RULES = [
  { rule: 'unknown key', query: { select: '*' }, field: 'select' },
  { rule: 'bad operator', query: { filters: [{ field: 'region', op: 'contains', value: 'E' }] }, field: 'filters[0].op' },
  { rule: 'bad field', query: { filters: [{ field: '$where', op: 'eq', value: 1 }] }, field: 'filters[0].field' },
  { rule: 'bad type', query: { filters: [{ field: 'amount', op: 'gt', value: { $gt: 1 } }] }, field: 'filters[0].value' },
  { rule: 'bad preset', query: { dateRange: { field: 'order_date', preset: 'last_fortnight' } }, field: 'dateRange.preset' },
  { rule: 'bad bucket', query: { groupBy: [{ field: 'order_date', bucket: 'hour' }] }, field: 'groupBy[0].bucket' },
];

/** Violations of a filter envelope { dateRange, filters, filtersOp }. */
const ENVELOPE_RULES = [
  { rule: 'unknown key', query: { groupBy: ['region'] }, field: 'groupBy' },
  ...QUERY_RULES.slice(1, 5),
  { rule: 'missing date field', query: { dateRange: { preset: 'today' } }, field: 'dateRange.field' },
];

const qs = (obj) => Object.entries(obj)
  .map(([k, v]) => `${k}=${encodeURIComponent(typeof v === 'string' ? v : JSON.stringify(v))}`)
  .join('&');

function expectRejected(res, field, label) {
  assert.equal(res.status, 400, `${label}: expected 400, got ${res.status} ${JSON.stringify(res.json)}`);
  assert.equal(res.json.code, 'INVALID_QUERY', `${label}: code`);
  assert.ok(
    Array.isArray(res.json.errors) && res.json.errors.some((e) => e.field === field && e.message),
    `${label}: expected a field error for "${field}", got ${JSON.stringify(res.json.errors)}`,
  );
}

test('analytics endpoint and export reject every contract violation with field errors', async () => {
  const { auth } = await onboard();
  for (const { rule, query, field } of QUERY_RULES) {
    expectRejected(await api(`/api/v1/analytics?${qs(query)}`, { headers: auth }), field, `GET /analytics ${rule}`);
    expectRejected(await api('/api/v1/analytics/export', { method: 'POST', headers: auth, body: { ...query, format: 'csv' } }), field, `POST /analytics/export ${rule}`);
  }
  // Malformed JSON and repeated parameters are field errors too.
  expectRejected(await api('/api/v1/analytics?filters=%7Bbad', { headers: auth }), 'filters', 'bad JSON');
  expectRejected(await api('/api/v1/analytics?filtersOp=and&filtersOp=or', { headers: auth }), 'filtersOp', 'repeated param');
  expectRejected(await api('/api/v1/analytics?limit=500', { headers: auth }), 'pagination.limit', 'limit over max');
});

test('widget authoring, dashboard filters and widget execution reject every violation', async () => {
  const { auth, datasetId } = await onboard();
  const dash = await api('/api/v1/dashboards', { method: 'POST', headers: auth, body: { name: 'Contract' } });
  assert.equal(dash.status, 201, JSON.stringify(dash.json));
  const dashboardId = dash.json.data._id;
  const widget = await api(`/api/v1/dashboards/${dashboardId}/widgets`, {
    method: 'POST', headers: auth, body: { name: 'ok', type: 'table', datasetId, query: { metrics: [{ op: 'count' }] } },
  });
  assert.equal(widget.status, 201, JSON.stringify(widget.json));
  const widgetId = widget.json.data._id;

  for (const { rule, query, field } of QUERY_RULES) {
    expectRejected(await api(`/api/v1/dashboards/${dashboardId}/widgets`, {
      method: 'POST', headers: auth, body: { name: 'bad', type: 'table', datasetId, query },
    }), `query.${field}`, `create widget ${rule}`);
    expectRejected(await api(`/api/v1/dashboards/${dashboardId}/widgets/${widgetId}`, {
      method: 'PATCH', headers: auth, body: { query },
    }), `query.${field}`, `update widget ${rule}`);
  }
  for (const { rule, query, field } of ENVELOPE_RULES) {
    expectRejected(await api(`/api/v1/dashboards/${dashboardId}`, {
      method: 'PATCH', headers: auth, body: { filters: query },
    }), `filters.${field}`, `dashboard filters ${rule}`);
    expectRejected(await api(`/api/v1/dashboards/${dashboardId}/widgets/${widgetId}/execute?${qs(query)}`, { headers: auth }), field, `execute overrides ${rule}`);
  }

  // A definition stored before the strict contract is rejected at run time
  // (never executed with parts dropped), and the dashboard view shows why.
  await Widget.collection.updateOne({ _id: Widget.castObject({ _id: widgetId })._id }, { $set: { query: { filters: [{ field: 'region', op: 'like', value: 'E' }] } } });
  expectRejected(await api(`/api/v1/dashboards/${dashboardId}/widgets/${widgetId}/execute`, { headers: auth }), 'filters[0].op', 'legacy widget');
  const view = await api(`/api/v1/dashboards/${dashboardId}/execute`, { headers: auth });
  assert.equal(view.status, 200);
  assert.equal(view.json.data[0].status, 'error');
  assert.equal(view.json.data[0].error.code, 'INVALID_QUERY');
  assert.ok(view.json.data[0].error.errors.some((e) => e.field === 'filters[0].op'));
});

test('reports reject every violation in the query, the report filters and run overrides', async () => {
  const { auth, datasetId } = await onboard();
  for (const { rule, query, field } of QUERY_RULES) {
    expectRejected(await api('/api/v1/reports', {
      method: 'POST', headers: auth, body: { name: 'bad', source: 'query', query: { datasetId, ...query } },
    }), `query.${field}`, `create report ${rule}`);
  }
  const created = await api('/api/v1/reports', { method: 'POST', headers: auth, body: { name: 'ok', source: 'query', query: { datasetId } } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const reportId = created.json.data._id;
  for (const { rule, query, field } of QUERY_RULES) {
    expectRejected(await api(`/api/v1/reports/${reportId}`, {
      method: 'PATCH', headers: auth, body: { query: { datasetId, ...query } },
    }), `query.${field}`, `update report ${rule}`);
  }
  for (const { rule, query, field } of ENVELOPE_RULES) {
    expectRejected(await api('/api/v1/reports', {
      method: 'POST', headers: auth, body: { name: 'bad', source: 'query', query: { datasetId }, filters: query },
    }), `filters.${field}`, `report filters ${rule}`);
    expectRejected(await api(`/api/v1/reports/${reportId}/run`, {
      method: 'POST', headers: auth, body: { filters: query },
    }), `filters.${field}`, `run overrides ${rule}`);
  }
  // A rejected definition never consumed a report slot: only "ok" exists.
  const list = await api('/api/v1/reports', { headers: auth });
  assert.equal(list.json.data.length, 1);
});

test('alerts reject every violation in the query on create and update', async () => {
  const { auth, datasetId } = await onboard();
  const base = { name: 'a', source: 'query', condition: 'gt', threshold: 1 };
  for (const { rule, query, field } of QUERY_RULES) {
    expectRejected(await api('/api/v1/alerts', {
      method: 'POST', headers: auth, body: { ...base, query: { datasetId, ...query } },
    }), `query.${field}`, `create alert ${rule}`);
  }
  const created = await api('/api/v1/alerts', { method: 'POST', headers: auth, body: { ...base, query: { datasetId } } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  for (const { rule, query, field } of QUERY_RULES) {
    expectRejected(await api(`/api/v1/alerts/${created.json.data._id}`, {
      method: 'PATCH', headers: auth, body: { query: { datasetId, ...query } },
    }), `query.${field}`, `update alert ${rule}`);
  }
  assert.equal((await api(`/api/v1/alerts/${created.json.data._id}/evaluate`, { method: 'POST', headers: auth })).status, 200);

  // Evaluation: a rule stored before the strict contract is rejected with
  // field errors (never evaluated over a broader population).
  for (const { rule, query, field } of QUERY_RULES) {
    await AlertRule.collection.updateOne(
      { _id: AlertRule.castObject({ _id: created.json.data._id })._id },
      { $set: { query: { datasetId, ...query } } },
    );
    expectRejected(await api(`/api/v1/alerts/${created.json.data._id}/evaluate`, { method: 'POST', headers: auth }), field, `evaluate alert ${rule}`);
  }
});

test('the external API rejects every violation', async () => {
  const { auth, datasetId } = await onboard();
  const key = await api('/api/v1/api-keys', { method: 'POST', headers: auth, body: { name: 'ci', scopes: ['analytics:query'] } });
  assert.equal(key.status, 201, JSON.stringify(key.json));
  const headers = { 'X-Api-Key': key.json.data.secret };
  for (const { rule, query, field } of QUERY_RULES) {
    expectRejected(await api(`/api/v1/external/datasets/${datasetId}/query?${qs(query)}`, { headers }), field, `external ${rule}`);
  }
  expectRejected(await api(`/api/v1/external/datasets/${datasetId}/query?connectorIds=${datasetId}`, { headers }), 'connectorIds', 'external connectorIds');
  expectRejected(await api(`/api/v1/external/datasets/${datasetId}/query?${qs({ pagination: { limit: 1000 } })}`, { headers }), 'pagination.limit', 'external pagination');

  const ok = await api(`/api/v1/external/datasets/${datasetId}/query?${qs({ dateRange: { field: 'order_date', from: '2024-01-01', to: '2024-01-31' }, metrics: [{ op: 'count' }] })}`, { headers });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(ok.json.data.rows, [{ count: 1 }]);
  assert.equal(ok.json.data.timezone, 'UTC');
});

test('valid queries work on every consumer path, with presets kept as presets', async () => {
  const { auth, datasetId } = await onboard();
  const preset = { field: 'order_date', preset: 'last_30_days' };

  const live = await api(`/api/v1/analytics?${qs({ connectorIds: datasetId, groupBy: ['region'], metrics: [{ op: 'sum', field: 'amount', alias: 'revenue' }], orderBy: [{ field: 'revenue', dir: 'desc' }] })}`, { headers: auth });
  assert.equal(live.status, 200, JSON.stringify(live.json));
  assert.deepEqual(live.json.data, [{ region: 'US', revenue: 200 }, { region: 'EU', revenue: 100 }], 'UI shorthand groups and sorts');
  assert.equal(live.json.meta.timezone, 'UTC');

  const windowed = await api(`/api/v1/analytics?${qs({ dateRange: { field: 'order_date', from: '2024-02-01', to: '2024-02-29' } })}`, { headers: auth });
  assert.equal(windowed.json.meta.total, 1);
  assert.equal(windowed.json.meta.window.field, 'order_date');
  assert.equal(windowed.json.meta.window.preset, null);

  // The response names the preset that was asked for, fresh or cached.
  for (const expectCached of [false, true]) {
    const relative = await api(`/api/v1/analytics?${qs({ dateRange: preset })}`, { headers: auth });
    assert.equal(relative.status, 200, JSON.stringify(relative.json));
    assert.equal(relative.json.meta.cached, expectCached);
    assert.equal(relative.json.meta.window.preset, 'last_30_days');
    assert.ok(relative.json.meta.window.from && relative.json.meta.window.to, 'resolved to an absolute window');
  }

  const dash = await api('/api/v1/dashboards', { method: 'POST', headers: auth, body: { name: 'D', filters: { dateRange: preset } } });
  assert.equal(dash.status, 201, JSON.stringify(dash.json));
  assert.deepEqual(dash.json.data.filters.dateRange, preset, 'dashboard stores the preset, not a frozen window');
  const widget = await api(`/api/v1/dashboards/${dash.json.data._id}/widgets`, {
    method: 'POST', headers: auth, body: { name: 'W', type: 'line', datasetId, query: { groupBy: [{ field: 'order_date', bucket: 'month' }], metrics: [{ op: 'count' }] } },
  });
  assert.equal(widget.status, 201, JSON.stringify(widget.json));
  const run = await api(`/api/v1/dashboards/${dash.json.data._id}/widgets/${widget.json.data._id}/execute?${qs({ dateRange: { field: 'order_date', from: '2024-01-01', to: '2024-12-31' } })}`, { headers: auth });
  assert.equal(run.status, 200, JSON.stringify(run.json));
  assert.deepEqual(run.json.data.rows, [{ order_date: '2024-01-01', count: 1 }, { order_date: '2024-02-01', count: 1 }]);

  const report = await api('/api/v1/reports', { method: 'POST', headers: auth, body: { name: 'R', source: 'query', query: { datasetId, dateRange: preset }, filters: { dateRange: preset } } });
  assert.equal(report.status, 201, JSON.stringify(report.json));
  assert.deepEqual(report.json.data.query.dateRange, preset, 'report query keeps the preset');
  assert.deepEqual(report.json.data.filters.dateRange, preset, 'report filters keep the preset');

  const alert = await api('/api/v1/alerts', { method: 'POST', headers: auth, body: { name: 'A', source: 'query', condition: 'gt', threshold: 0, query: { datasetId, dateRange: preset } } });
  assert.equal(alert.status, 201, JSON.stringify(alert.json));
  assert.deepEqual(alert.json.data.query.dateRange, preset, 'alert query keeps the preset');
});

test('the analytics endpoint answers 429 QUERY_CONCURRENCY_LIMIT when the workspace is at its limit', async () => {
  const { tenantId, auth } = await onboard();
  const other = await onboard();
  const saved = { maxConcurrent: queryLimiter.maxConcurrent, maxQueued: queryLimiter.maxQueued };
  queryLimiter.configure({ maxConcurrent: 1, maxQueued: 0 });
  let open;
  const held = queryLimiter.run(tenantId, () => new Promise((resolve) => { open = resolve; }));
  try {
    const res = await api('/api/v1/analytics', { headers: auth });
    assert.equal(res.status, 429, JSON.stringify(res.json));
    assert.equal(res.json.code, 'QUERY_CONCURRENCY_LIMIT');
    const unaffected = await api('/api/v1/analytics', { headers: other.auth });
    assert.equal(unaffected.status, 200, 'other workspaces keep their own slots');
  } finally {
    open();
    await held;
    queryLimiter.configure(saved);
  }
  assert.equal((await api('/api/v1/analytics', { headers: auth })).status, 200);
});
