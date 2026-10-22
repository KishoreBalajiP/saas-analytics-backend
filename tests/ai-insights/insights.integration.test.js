/** ai-insights over HTTP: generate from engine data, feed, dismiss, feedback, permissions, tenant isolation. */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import connectorRepository from '../../src/repositories/connector.repository.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import { onboardTenant, memberOf } from '../platform-config/helpers.js';
import { entitleTenant } from '../helpers/billing.js';
import * as datasetSchemaService from '../../src/services/datasetSchema.service.js';

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => { await resetMongo(); await rbacCache.clearAll(); });
after(async () => { await stopHttp(); await stopMongo(); });

test('generate, feed, dismiss, feedback; isolation and permission', async () => {
  const a = await onboardTenant();
  const b = await onboardTenant();
  await entitleTenant(a.tenantId);
  await entitleTenant(b.tenantId);
  const c = await connectorRepository.create({ tenantId: a.tenantId, type: 'csv', name: 'Orders', status: 'active', createdBy: 'u' });
  const rows = [['2024-01-10', 'EU', 100], ['2024-01-11', 'US', 110], ['2024-01-12', 'APAC', 50], ['2024-02-10', 'EU', 150], ['2024-02-11', 'US', 100], ['2024-02-12', 'APAC', 60]];
  await ConnectorRow.insertMany(rows.map(([d, r, amount], i) => ({ tenantId: a.tenantId, connectorId: c._id, sourceRowId: `r${i}`, data: { order_date: d, region: r, amount } })));
  await datasetSchemaService.profileConnector({ tenantId: a.tenantId, connectorId: String(c._id) });
  const body = { connectorId: String(c._id), metric: { op: 'sum', field: 'amount' }, dateField: 'order_date', dimension: 'region', bucket: 'month' };
  const gen = await api('/api/v1/insights/generate', { method: 'POST', headers: a.headers, body });
  assert.equal(gen.status, 201, JSON.stringify(gen.json));
  const types = gen.json.data.insights.map((i) => i.type).sort();
  assert.deepEqual(types, ['period_change', 'top_movers']);
  const pc = gen.json.data.insights.find((i) => i.type === 'period_change');
  assert.deepEqual(pc.facts, { change: 50, changePct: 0.1923 });
  assert.equal(pc.narration, null, 'no provider -> deterministic only');

  assert.equal((await api('/api/v1/insights/generate', { method: 'POST', headers: b.headers, body })).status, 400, 'other tenant dataset');
  assert.equal((await api('/api/v1/insights', { headers: b.headers })).json.data.length, 0);
  assert.equal((await api(`/api/v1/insights/${pc._id}/dismiss`, { method: 'POST', headers: b.headers })).status, 404);
  const none = await memberOf(a.tenantId, null);
  assert.equal((await api('/api/v1/insights', { headers: none.headers })).status, 403);

  assert.equal((await api(`/api/v1/insights/${pc._id}/feedback`, { method: 'POST', headers: a.headers, body: { rating: 'down' } })).status, 200);
  assert.equal((await api(`/api/v1/insights/${pc._id}/dismiss`, { method: 'POST', headers: a.headers })).status, 200);
  const feed = await api('/api/v1/insights', { headers: a.headers });
  assert.equal(feed.json.data.length, 1);
});
