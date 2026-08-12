/**
 * End-to-end HTTP integration tests for `/api/v1/dashboards/*`.
 *
 * Proves the wired surface works through the real Express app: onboarding a
 * tenant (which now seeds the `dashboards` module + permissions), owner
 * login, dashboard + widget CRUD, widget execution over ingested connector
 * rows, share grants, and RBAC default-deny (401/403) + validation (422).
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import { shortToken } from '../../src/utils/id.js';
import { hash } from '../../src/utils/password.js';
import * as tenantService from '../../src/services/tenant.service.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import userRepository from '../../src/repositories/user.repository.js';
import connectorRepository from '../../src/repositories/connector.repository.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import { User } from '../../src/models/User.js';

const PASSWORD = 'Password123!';

before(async () => {
  await startMongo();
  await startHttp();
});

beforeEach(async () => {
  await resetMongo();
  await rbacCache.clearAll();
});

after(async () => {
  await stopHttp();
  await stopMongo();
});

/** Onboard a tenant + owner, then log the owner in. Returns auth headers. */
async function onboard() {
  const owner = { email: `owner-${shortToken(10).toLowerCase()}@example.com`, name: 'Owner', password: PASSWORD };
  const { tenant } = await tenantService.create({
    tenant: { name: `Dash ${shortToken(10)}` },
    owner,
    initialize: true,
    by: 'root',
  });
  const tenantId = tenant._id.toString();
  const login = await api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenantId },
    body: { email: owner.email, password: PASSWORD },
  });
  assert.equal(login.status, 200);
  return {
    tenantId,
    auth: { authorization: `Bearer ${login.json.data.accessToken}`, 'X-Tenant-Id': tenantId },
  };
}

/** Create a role-less user (no grants -> default-deny on every dashboards route). */
async function onboardNoRights() {
  const { tenantId } = await onboard();
  const email = `nobody-${shortToken(10).toLowerCase()}@example.com`;
  await userRepository.create({
    tenantId,
    email,
    status: 'active',
    passwordHash: await hash(PASSWORD),
    profile: { name: 'Nobody', locale: 'en', timezone: 'UTC' },
  });
  const login = await api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenantId },
    body: { email, password: PASSWORD },
  });
  assert.equal(login.status, 200);
  return {
    tenantId,
    auth: { authorization: `Bearer ${login.json.data.accessToken}`, 'X-Tenant-Id': tenantId },
  };
}

/** Create a connector + two rows for the tenant, return the connector id. */
async function seedDataset(tenantId) {
  const connector = await connectorRepository.create({
    tenantId, type: 'csv', name: 'Orders', status: 'active', createdBy: 'u1',
  });
  await ConnectorRow.insertMany([
    { tenantId, connectorId: connector._id, sourceRowId: 'r1', data: { region: 'EU', amount: 100 }, ingestedAt: new Date('2024-01-02') },
    { tenantId, connectorId: connector._id, sourceRowId: 'r2', data: { region: 'US', amount: 200 }, ingestedAt: new Date('2024-01-03') },
  ]);
  return String(connector._id);
}

test('dashboard + widget CRUD, execution and sharing over HTTP', async () => {
  const { tenantId, auth } = await onboard();
  const datasetId = await seedDataset(tenantId);

  const list = await api('/api/v1/dashboards', { headers: auth });
  assert.equal(list.status, 200);
  assert.equal(list.json.data.length, 0);

  const created = await api('/api/v1/dashboards', {
    method: 'POST',
    headers: auth,
    body: { name: 'Revenue', layout: { columns: 12, rowHeight: 80 } },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.data.status, 'draft');
  const dashId = created.json.data._id;

  const widget = await api(`/api/v1/dashboards/${dashId}/widgets`, {
    method: 'POST',
    headers: auth,
    body: {
      name: 'Total orders',
      type: 'kpi',
      datasetId,
      query: { metrics: [{ alias: 'total', op: 'count', field: 'amount' }], groupBy: [{ field: 'region' }] },
    },
  });
  assert.equal(widget.status, 201);
  const widgetId = widget.json.data._id;

  const detail = await api(`/api/v1/dashboards/${dashId}`, { headers: auth });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.data.widgets.length, 1);

  const run = await api(`/api/v1/dashboards/${dashId}/widgets/${widgetId}/execute`, { headers: auth });
  assert.equal(run.status, 200);
  assert.equal(run.json.data.total, 2, 'one group per region');
  assert.equal(run.json.data.rows.length, 2);
  assert.equal(run.json.data.rows.find((r) => r.region === 'EU').total, 1);
  assert.equal(run.json.meta.cached, false);

  const warm = await api(`/api/v1/dashboards/${dashId}/widgets/${widgetId}/execute`, { headers: auth });
  assert.equal(warm.status, 200);
  assert.equal(warm.json.meta.cached, true);

  const shared = await api(`/api/v1/dashboards/${dashId}/share`, {
    method: 'POST',
    headers: auth,
    body: { email: 'viewer@example.com' },
  });
  assert.equal(shared.status, 201);
  const shareId = shared.json.data._id;

  const revoked = await api(`/api/v1/dashboards/${dashId}/share/${shareId}`, { method: 'DELETE', headers: auth });
  assert.equal(revoked.status, 204);

  const dup = await api(`/api/v1/dashboards/${dashId}/duplicate`, { method: 'POST', headers: auth });
  assert.equal(dup.status, 201);
  assert.equal(dup.json.data.name, 'Revenue (copy)');

  const published = await api(`/api/v1/dashboards/${dashId}/publish`, { method: 'POST', headers: auth });
  assert.equal(published.status, 200);
  assert.equal(published.json.data.status, 'published');

  const removed = await api(`/api/v1/dashboards/${dashId}`, { method: 'DELETE', headers: auth });
  assert.equal(removed.status, 204);
  const gone = await api(`/api/v1/dashboards/${dashId}`, { headers: auth });
  assert.equal(gone.status, 404);
});

test('run-dashboard executes every widget (partial failures allowed)', async () => {
  const { tenantId, auth } = await onboard();
  const datasetId = await seedDataset(tenantId);

  const created = await api('/api/v1/dashboards', { method: 'POST', headers: auth, body: { name: 'Ops' } });
  const dashId = created.json.data._id;
  await api(`/api/v1/dashboards/${dashId}/widgets`, {
    method: 'POST', headers: auth,
    body: { name: 'ok', type: 'kpi', datasetId, query: { metrics: [{ alias: 'total', op: 'count', field: 'amount' }] } },
  });

  const run = await api(`/api/v1/dashboards/${dashId}/execute`, { headers: auth });
  assert.equal(run.status, 200);
  assert.equal(run.json.data.length, 1);
  assert.equal(run.json.data[0].status, 'ok');
  assert.equal(run.json.data[0].result.result.total, 2);
});

test('dashboard routes are 401 without a token and 403 without permission', async () => {
  const noAuth = await api('/api/v1/dashboards');
  assert.equal(noAuth.status, 401);

  const { tenantId, auth } = await onboardNoRights();
  const denied = await api('/api/v1/dashboards', {
    method: 'POST',
    headers: auth,
    body: { name: 'Nope' },
  });
  assert.equal(denied.status, 403);

  const deniedList = await api('/api/v1/dashboards', { headers: auth });
  assert.equal(deniedList.status, 403);
});

test('invalid input is rejected with 422 and cross-tenant access is 404', async () => {
  const { tenantId, auth } = await onboard();
  const other = await onboard();

  const bad = await api('/api/v1/dashboards', { method: 'POST', headers: auth, body: { name: '' } });
  assert.equal(bad.status, 422);

  // A dashboard created in another tenant must be invisible here.
  const created = await api('/api/v1/dashboards', { method: 'POST', headers: other.auth, body: { name: 'Secret' } });
  const foreignId = created.json.data._id;

  const get = await api(`/api/v1/dashboards/${foreignId}`, { headers: auth });
  assert.equal(get.status, 404);

  // Widget execution against a non-existent dataset is a clean 400.
  const dash = await api('/api/v1/dashboards', { method: 'POST', headers: auth, body: { name: 'Mine' } });
  const widget = await api(`/api/v1/dashboards/${dash.json.data._id}/widgets`, {
    method: 'POST',
    headers: auth,
    body: { name: 'Broken', type: 'kpi', datasetId: '000000000000000000000000' },
  });
  assert.equal(widget.status, 400);
});
