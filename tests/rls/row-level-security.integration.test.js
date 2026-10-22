/**
 * Dataset grants and row-level security (roadmap 4.E4, rls) over real HTTP.
 *
 * Fixture: workspace with an Owner (administers data access, bypasses it)
 * and an "analyst" holding the default Admin role (analytics, dashboards,
 * reports, exports, embeds, API keys - but NOT data_access.configure).
 * Datasets: Orders (EU/US/APAC rows, row rule region = user.region) and
 * Secret (restricted, no grant). The analyst has region EU.
 *
 * Every query path is checked: GET /analytics (raw, grouped, client
 * filters, all-datasets), connector listings and raw rows, dashboards,
 * embeds, external API (query + rows + listing), queued exports, reports,
 * alerts, preview-as-user, plus permissions and tenant isolation.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import { shortToken } from '../../src/utils/id.js';
import { hash } from '../../src/utils/password.js';
import * as tenantService from '../../src/services/tenant.service.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import userRepository from '../../src/repositories/user.repository.js';
import roleRepository from '../../src/repositories/role.repository.js';
import connectorRepository from '../../src/repositories/connector.repository.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import { UserRole } from '../../src/models/UserRole.js';
import * as alertService from '../../src/services/alert.service.js';
import dataAccess from '../../src/services/dataAccess.service.js';
import { entitleTenant } from '../helpers/billing.js';

const PASSWORD = 'Password123!';
const EMBED_ORIGIN = 'https://embed.example.com';

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => { await resetMongo(); await rbacCache.clearAll(); await cacheService.flushAll(); });
after(async () => { await stopHttp(); await stopMongo(); });

async function login(tenantId, email) {
  const res = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email, password: PASSWORD } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return { authorization: `Bearer ${res.json.data.accessToken}`, 'X-Tenant-Id': tenantId };
}

async function addMember(tenantId, roleName) {
  const email = `${roleName.toLowerCase()}-${shortToken(8).toLowerCase()}@example.com`;
  const user = await userRepository.create({ tenantId, email, status: 'active', passwordHash: await hash(PASSWORD), profile: { name: roleName } });
  const role = await roleRepository.findByName({ tenantId, name: roleName });
  await new UserRole({ tenantId, userId: String(user._id), roleId: String(role._id), grantedAt: new Date() }).save();
  await rbacCache.clearAll();
  return { id: String(user._id), email, roleId: String(role._id), auth: await login(tenantId, email) };
}

async function seed(tenantId, name, rows) {
  const connector = await connectorRepository.create({ tenantId, type: 'csv', name, status: 'active', createdBy: 'seed' });
  await ConnectorRow.insertMany(rows.map((data, i) => ({
    tenantId, connectorId: connector._id, sourceRowId: `${name}-${i}`, data, ingestedAt: new Date('2024-01-02'),
  })));
  return String(connector._id);
}

/** Workspace with Orders (row rule on region) and a restricted Secret dataset. */
async function workspace({ analystRegion = 'EU' } = {}) {
  const owner = { email: `owner-${shortToken(8).toLowerCase()}@example.com`, name: 'Owner', password: PASSWORD };
  const { tenant } = await tenantService.create({ tenant: { name: `RLS ${shortToken(8)}` }, owner, initialize: true, by: 'root' });
  const tenantId = String(tenant._id);
  await entitleTenant(tenantId);
  const ownerAuth = await login(tenantId, owner.email);
  const orders = await seed(tenantId, 'Orders', [
    { region: 'EU', amount: 100 }, { region: 'US', amount: 200 }, { region: 'APAC', amount: 300 },
  ]);
  const secret = await seed(tenantId, 'Secret', [{ region: 'EU', salary: 1 }, { region: 'US', salary: 2 }]);
  const analyst = await addMember(tenantId, 'Admin');

  const policy = await api(`/api/v1/data-access/datasets/${orders}/policies`, {
    method: 'POST', headers: ownerAuth, body: { field: 'region', op: 'eq', attribute: 'region' },
  });
  assert.equal(policy.status, 201, JSON.stringify(policy.json));
  const restrict = await api(`/api/v1/data-access/datasets/${secret}`, { method: 'PUT', headers: ownerAuth, body: { restricted: true, grants: [] } });
  assert.equal(restrict.status, 200, JSON.stringify(restrict.json));
  if (analystRegion) {
    const attrs = await api(`/api/v1/data-access/users/${analyst.id}/attributes`, {
      method: 'PUT', headers: ownerAuth, body: { attributes: { region: analystRegion } },
    });
    assert.equal(attrs.status, 200, JSON.stringify(attrs.json));
  }
  return { tenantId, ownerAuth, orders, secret, analyst };
}

const qs = (query) => Object.entries(query)
  .map(([k, v]) => `${k}=${encodeURIComponent(k === 'connectorIds' ? v.join(',') : typeof v === 'string' ? v : JSON.stringify(v))}`)
  .join('&');
const analytics = (auth, query) => api(`/api/v1/analytics?${qs(query)}`, { headers: auth });
const regions = (rows) => rows.map((r) => r.region ?? r.data?.region).sort();

async function poll(fn, done, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out');
}

/* ------------------------------- analytics ------------------------------- */

test('GET /analytics: row rules apply, client filters only narrow, cache is per scope', async () => {
  const ws = await workspace();
  // Owner first, so a cache shared across scopes would leak to the analyst.
  const ownerRaw = await analytics(ws.ownerAuth, { connectorIds: [ws.orders] });
  assert.equal(ownerRaw.status, 200);
  assert.deepEqual(regions(ownerRaw.json.data), ['APAC', 'EU', 'US']);

  const raw = await analytics(ws.analyst.auth, { connectorIds: [ws.orders] });
  assert.equal(raw.status, 200, JSON.stringify(raw.json));
  assert.deepEqual(regions(raw.json.data), ['EU']);

  const grouped = await analytics(ws.analyst.auth, {
    connectorIds: [ws.orders], groupBy: [{ field: 'region' }], metrics: [{ alias: 'total', op: 'sum', field: 'amount' }],
  });
  assert.deepEqual(grouped.json.data.map((r) => [r.region, r.total]), [['EU', 100]]);

  const kpi = await analytics(ws.analyst.auth, { connectorIds: [ws.orders], metrics: [{ alias: 'total', op: 'sum', field: 'amount' }] });
  assert.equal(kpi.json.data[0].total, 100, 'aggregates never include hidden rows');

  for (const filters of [
    { filters: [{ field: 'region', op: 'eq', value: 'US' }] },
    { filters: [{ field: 'region', op: 'in', value: ['US', 'APAC'] }] },
    { filters: [{ field: 'region', op: 'eq', value: 'US' }, { field: 'region', op: 'exists', value: true }], filtersOp: 'or' },
    { filters: [{ field: 'region', op: 'neq', value: 'EU' }] },
  ]) {
    const res = await analytics(ws.analyst.auth, { connectorIds: [ws.orders], ...filters });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.ok(regions(res.json.data).every((r) => r === 'EU'), JSON.stringify(filters));
  }

  // The scope cannot be supplied by the client.
  const spoof = await api(`/api/v1/analytics?${qs({ connectorIds: [ws.orders] })}&access=${encodeURIComponent(JSON.stringify({ bypass: true, denied: [], hidden: [], rowScopes: [] }))}`, { headers: ws.analyst.auth });
  assert.ok(spoof.status === 400 || regions(spoof.json.data).join() === 'EU');
});

test('restricted datasets are invisible and unqueryable without a grant', async () => {
  const ws = await workspace();
  const explicit = await analytics(ws.analyst.auth, { connectorIds: [ws.secret] });
  assert.equal(explicit.status, 404);
  // Querying every dataset never returns Secret rows.
  const all = await analytics(ws.analyst.auth, {});
  assert.equal(all.status, 200);
  assert.ok(all.json.data.every((r) => r.data?.salary === undefined));
  assert.deepEqual(regions(all.json.data), ['EU']);

  const list = await api('/api/v1/connectors', { headers: ws.analyst.auth });
  assert.deepEqual(list.json.data.map((c) => c.name), ['Orders']);
  assert.equal((await api(`/api/v1/connectors/${ws.secret}`, { headers: ws.analyst.auth })).status, 404);
  assert.equal((await api(`/api/v1/connectors/${ws.secret}/rows`, { headers: ws.analyst.auth })).status, 404);
  const rows = await api(`/api/v1/connectors/${ws.orders}/rows`, { headers: ws.analyst.auth });
  assert.equal(rows.status, 200);
  assert.deepEqual(regions(rows.json.data), ['EU']);

  // The Owner sees everything.
  assert.equal((await api('/api/v1/connectors', { headers: ws.ownerAuth })).json.data.length, 2);
  assert.equal((await analytics(ws.ownerAuth, { connectorIds: [ws.secret] })).json.data.length, 2);
});

test('grants: view lists the dataset, query (user or role) makes it queryable', async () => {
  const ws = await workspace();
  await api(`/api/v1/data-access/datasets/${ws.secret}`, {
    method: 'PUT', headers: ws.ownerAuth, body: { restricted: true, grants: [{ subjectType: 'user', subjectId: ws.analyst.id, level: 'view' }] },
  });
  assert.equal((await api('/api/v1/connectors', { headers: ws.analyst.auth })).json.data.length, 2);
  assert.equal((await analytics(ws.analyst.auth, { connectorIds: [ws.secret] })).status, 404);

  await api(`/api/v1/data-access/datasets/${ws.secret}`, {
    method: 'PUT', headers: ws.ownerAuth, body: { restricted: true, grants: [{ subjectType: 'role', subjectId: ws.analyst.roleId, level: 'query' }] },
  });
  const ok = await analytics(ws.analyst.auth, { connectorIds: [ws.secret] });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.data.length, 2);
});

test('a member without the rule attribute sees no rows of that dataset (fail closed)', async () => {
  const ws = await workspace({ analystRegion: null });
  const res = await analytics(ws.analyst.auth, { connectorIds: [ws.orders] });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.length, 0);
  const rows = await api(`/api/v1/connectors/${ws.orders}/rows`, { headers: ws.analyst.auth });
  assert.equal(rows.json.data.length, 0);
});

/* ------------------------- dashboards and embeds ------------------------- */

test('dashboards and embeds apply the viewer / token creator scope', async () => {
  const ws = await workspace();
  const dash = await api('/api/v1/dashboards', { method: 'POST', headers: ws.analyst.auth, body: { name: 'Regions' } });
  assert.equal(dash.status, 201, JSON.stringify(dash.json));
  const dashId = dash.json.data._id;
  const widget = await api(`/api/v1/dashboards/${dashId}/widgets`, {
    method: 'POST', headers: ws.analyst.auth,
    body: { name: 'By region', type: 'table', datasetId: ws.orders, query: { metrics: [{ alias: 'n', op: 'count', field: 'amount' }], groupBy: [{ field: 'region' }] } },
  });
  assert.equal(widget.status, 201, JSON.stringify(widget.json));

  const view = await api(`/api/v1/dashboards/${dashId}/execute`, { headers: ws.analyst.auth });
  assert.equal(view.status, 200, JSON.stringify(view.json));
  const entry = view.json.data.widgets?.[0] ?? view.json.data[0];
  assert.deepEqual(regions(entry.result.rows), ['EU']);

  // A widget on a restricted dataset fails for the analyst.
  await api(`/api/v1/data-access/datasets/${ws.orders}`, { method: 'PUT', headers: ws.ownerAuth, body: { restricted: true, grants: [] } });
  const blocked = await api(`/api/v1/dashboards/${dashId}/execute`, { headers: ws.analyst.auth });
  const blockedEntry = blocked.json.data.widgets?.[0] ?? blocked.json.data[0];
  assert.ok(blockedEntry.error || blockedEntry.status !== 'ok', JSON.stringify(blockedEntry));
  await api(`/api/v1/data-access/datasets/${ws.orders}`, { method: 'PUT', headers: ws.ownerAuth, body: { restricted: false, grants: [] } });

  assert.equal((await api(`/api/v1/dashboards/${dashId}/publish`, { method: 'POST', headers: ws.analyst.auth })).status, 200);
  const minted = await api('/api/v1/embed/tokens', { method: 'POST', headers: ws.analyst.auth, body: { dashboardId: dashId, ttlSec: 600, allowedOrigins: [EMBED_ORIGIN] } });
  assert.equal(minted.status, 201, JSON.stringify(minted.json));
  const session = await api('/api/v1/embed/public/session', {
    method: 'POST', headers: { Origin: EMBED_ORIGIN }, body: { token: minted.json.data.secret },
  });
  assert.equal(session.status, 200, JSON.stringify(session.json));
  const embed = await api('/api/v1/embed/public/view', {
    method: 'POST',
    headers: { Origin: EMBED_ORIGIN, Authorization: `Bearer ${session.json.data.sessionToken}` },
    body: {},
  });
  assert.equal(embed.status, 200, JSON.stringify(embed.json));
  const embedWidget = embed.json.data.widgets[0];
  assert.deepEqual(regions(embedWidget.result.rows), ['EU'], 'embed shows the creator scope');
});

/* ----------------------------- external API ----------------------------- */

test('external API keys query with their creator scope', async () => {
  const ws = await workspace();
  const created = await api('/api/v1/api-keys', { method: 'POST', headers: ws.analyst.auth, body: { name: 'bi', scopes: ['datasets:read', 'analytics:query'] } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const headers = { 'X-Api-Key': created.json.data.secret };

  const list = await api('/api/v1/external/datasets', { headers });
  assert.deepEqual(list.json.data.map((d) => d.name), ['Orders']);
  assert.equal((await api(`/api/v1/external/datasets/${ws.secret}`, { headers })).status, 404);
  assert.equal((await api(`/api/v1/external/datasets/${ws.secret}/query`, { headers })).status, 404);
  assert.equal((await api(`/api/v1/external/datasets/${ws.secret}/rows`, { headers })).status, 404);

  const query = await api(`/api/v1/external/datasets/${ws.orders}/query?${qs({ filters: [{ field: 'region', op: 'eq', value: 'US' }] })}`, { headers });
  assert.equal(query.status, 200, JSON.stringify(query.json));
  assert.equal(query.json.data.rows.length, 0);
  const rows = await api(`/api/v1/external/datasets/${ws.orders}/rows`, { headers });
  assert.deepEqual(regions(rows.json.data), ['EU']);
});

/* ------------------------- exports, reports, alerts ------------------------- */

test('queued exports and reports contain only the requester rows', async () => {
  const ws = await workspace();
  const queued = await api('/api/v1/analytics/export', { method: 'POST', headers: ws.analyst.auth, body: { connectorIds: [ws.orders], format: 'csv' } });
  assert.equal(queued.status, 202, JSON.stringify(queued.json));
  const done = await poll(
    () => api(`/api/v1/analytics/exports/${queued.json.data.exportId}`, { headers: ws.analyst.auth }),
    (r) => ['ready', 'failed'].includes(r.json?.data?.status),
  );
  assert.equal(done.json.data.status, 'ready', done.json.data.error);
  assert.equal(done.json.data.rowCount, 1);

  const report = await api('/api/v1/reports', { method: 'POST', headers: ws.analyst.auth, body: { name: 'Mine', source: 'query', query: { datasetId: ws.orders }, format: 'csv' } });
  assert.equal(report.status, 201, JSON.stringify(report.json));
  const run = await api(`/api/v1/reports/${report.json.data._id}/run`, { method: 'POST', headers: ws.analyst.auth, body: { format: 'csv' } });
  assert.equal(run.status, 202, JSON.stringify(run.json));
  const ready = await poll(
    () => api(`/api/v1/reports/${report.json.data._id}`, { headers: ws.analyst.auth }),
    (r) => ['ready', 'failed'].includes(r.json?.data?.lastRun?.status),
  );
  assert.equal(ready.json.data.lastRun.status, 'ready');
  assert.equal(ready.json.data.lastRun.rowCount, 1);
});

test('alerts measure with the creator scope; no identity sees nothing restricted', async () => {
  const ws = await workspace();
  const params = { metrics: [{ alias: 'n', op: 'count', field: 'amount' }] };
  const base = { metric: 'n', condition: 'gt', threshold: 0 };
  const analystAlert = await alertService.measure({ tenantId: ws.tenantId, datasetId: ws.orders, params, alert: { ...base, createdBy: ws.analyst.id }, now: new Date() });
  assert.equal(analystAlert.value, 1);
  const orphan = await alertService.measure({ tenantId: ws.tenantId, datasetId: ws.orders, params, alert: { ...base, createdBy: null }, now: new Date() });
  assert.equal(orphan.value, 0, 'no identity -> no rows of a dataset with row rules');
  await assert.rejects(
    () => alertService.measure({ tenantId: ws.tenantId, datasetId: ws.secret, params, alert: { ...base, createdBy: ws.analyst.id }, now: new Date() }),
    (err) => err.statusCode === 404,
  );
});

/* ------------------------ preview, permissions, isolation ------------------------ */

test('preview-as-user matches what the member gets', async () => {
  const ws = await workspace();
  const query = { connectorIds: [ws.orders], groupBy: [{ field: 'region' }], metrics: [{ alias: 'n', op: 'count', field: 'amount' }] };
  const own = await analytics(ws.analyst.auth, query);
  const preview = await api('/api/v1/data-access/preview', { method: 'POST', headers: ws.ownerAuth, body: { userId: ws.analyst.id, query } });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.deepEqual(preview.json.data.rows, own.json.data);
  assert.equal(preview.json.data.scope.rowRules, 1);
  assert.deepEqual(preview.json.data.scope.deniedDatasets, [ws.secret]);
});

test('only data_access.configure changes rules; members cannot widen their own access', async () => {
  const ws = await workspace();
  const a = ws.analyst.auth;
  assert.equal((await api(`/api/v1/data-access/datasets/${ws.orders}`, { headers: a })).status, 200, 'Admins may read');
  assert.equal((await api(`/api/v1/data-access/users/${ws.analyst.id}/attributes`, { method: 'PUT', headers: a, body: { attributes: { region: ['EU', 'US', 'APAC'] } } })).status, 403);
  assert.equal((await api(`/api/v1/data-access/datasets/${ws.secret}`, { method: 'PUT', headers: a, body: { restricted: false } })).status, 403);
  assert.equal((await api('/api/v1/data-access/preview', { method: 'POST', headers: a, body: { userId: ws.analyst.id } })).status, 403);
  const policy = (await api(`/api/v1/data-access/datasets/${ws.orders}`, { headers: a })).json.data.policies[0];
  assert.equal((await api(`/api/v1/data-access/policies/${policy.id}`, { method: 'DELETE', headers: a })).status, 403);
  // Profile edits cannot set attributes.
  await api('/api/v1/users/me', { method: 'PATCH', headers: a, body: { name: 'x', attributes: { region: 'US' } } });
  assert.deepEqual(regions((await analytics(a, { connectorIds: [ws.orders] })).json.data), ['EU']);
  // Invalid rule fields are refused.
  const bad = await api(`/api/v1/data-access/datasets/${ws.orders}/policies`, { method: 'POST', headers: ws.ownerAuth, body: { field: 'tenantId', attribute: 'region' } });
  assert.equal(bad.status, 400);
});

test('tenant isolation: rules, attributes and grants stay inside their workspace', async () => {
  const a = await workspace();
  const b = await workspace();
  assert.equal((await api(`/api/v1/data-access/datasets/${a.orders}`, { headers: b.ownerAuth })).status, 404);
  assert.equal((await api(`/api/v1/data-access/users/${a.analyst.id}/attributes`, { headers: b.ownerAuth })).status, 404);
  const foreign = await api(`/api/v1/data-access/datasets/${b.secret}`, {
    method: 'PUT', headers: b.ownerAuth, body: { restricted: true, grants: [{ subjectType: 'user', subjectId: a.analyst.id, level: 'query' }] },
  });
  assert.equal(foreign.status, 400);
  const policyB = (await api(`/api/v1/data-access/datasets/${b.orders}`, { headers: b.ownerAuth })).json.data.policies[0];
  assert.equal((await api(`/api/v1/data-access/policies/${policyB.id}`, { method: 'DELETE', headers: a.ownerAuth })).status, 404);
  // Scopes are per tenant.
  const scope = await dataAccess.resolveAccessScope({ tenantId: b.tenantId, actor: { type: 'user', id: a.analyst.id } });
  assert.deepEqual([...scope.denied].sort(), [b.secret]);
  assert.equal(scope.rowScopes[0].none, true, 'a foreign user has no attributes here');
});
