/**
 * End-to-end HTTP integration tests for `/api/v1/reports/*` (Sprint 7).
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

const PASSWORD = 'Password123!';

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => { await resetMongo(); await rbacCache.clearAll(); });
after(async () => { await stopHttp(); await stopMongo(); });

async function onboard() {
  const owner = { email: `owner-${shortToken(10).toLowerCase()}@example.com`, name: 'Owner', password: PASSWORD };
  const { tenant } = await tenantService.create({ tenant: { name: `Rep ${shortToken(10)}` }, owner, initialize: true, by: 'root' });
  const tenantId = tenant._id.toString();
  const login = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email: owner.email, password: PASSWORD } });
  assert.equal(login.status, 200);
  return { tenantId, auth: { authorization: `Bearer ${login.json.data.accessToken}`, 'X-Tenant-Id': tenantId } };
}

async function onboardNoRights() {
  const { tenantId } = await onboard();
  const email = `nobody-${shortToken(10).toLowerCase()}@example.com`;
  await userRepository.create({ tenantId, email, status: 'active', passwordHash: await hash(PASSWORD), profile: { name: 'Nobody' } });
  const login = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email, password: PASSWORD } });
  return { tenantId, auth: { authorization: `Bearer ${login.json.data.accessToken}`, 'X-Tenant-Id': tenantId } };
}

async function seedDataset(tenantId) {
  const connector = await connectorRepository.create({ tenantId, type: 'csv', name: 'Orders', status: 'active', createdBy: 'u1' });
  await ConnectorRow.insertMany([
    { tenantId, connectorId: connector._id, sourceRowId: 'r1', data: { region: 'EU', amount: 100 }, ingestedAt: new Date('2024-01-02') },
    { tenantId, connectorId: connector._id, sourceRowId: 'r2', data: { region: 'US', amount: 200 }, ingestedAt: new Date('2024-01-03') },
  ]);
  return String(connector._id);
}

async function pollReady(auth, id, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await api(`/api/v1/reports/${id}`, { headers: auth });
    if (res.json?.data?.lastRun?.status === 'ready') return res.json.data;
    if (res.json?.data?.lastRun?.status === 'failed') return res.json.data;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

test('report CRUD, tenant isolation, RBAC and run/export over HTTP', async () => {
  const { tenantId, auth } = await onboard();
  const datasetId = await seedDataset(tenantId);

  const list = await api('/api/v1/reports', { headers: auth });
  assert.equal(list.status, 200);
  assert.equal(list.json.data.length, 0);

  const created = await api('/api/v1/reports', {
    method: 'POST', headers: auth,
    body: { name: 'Monthly', source: 'query', query: { datasetId }, format: 'csv' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const reportId = created.json.data._id;

  const got = await api(`/api/v1/reports/${reportId}`, { headers: auth });
  assert.equal(got.status, 200);

  const updated = await api(`/api/v1/reports/${reportId}`, { method: 'PATCH', headers: auth, body: { status: 'active' } });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.data.status, 'active');

  const run = await api(`/api/v1/reports/${reportId}/run`, { method: 'POST', headers: auth, body: { format: 'csv' } });
  assert.equal(run.status, 202, JSON.stringify(run.json));
  const ready = await pollReady(auth, reportId);
  assert.ok(ready, 'report should reach a terminal run state');
  assert.equal(ready.lastRun.status, 'ready');
  assert.ok(ready.lastRun.rowCount >= 1, 'artefact should contain rows');

  const dl = await api(`/api/v1/reports/${reportId}/download`, { headers: auth });
  assert.equal(dl.status, 200);
  assert.ok(dl.json.data.url, 'download returns a presigned url');

  const del = await api(`/api/v1/reports/${reportId}`, { method: 'DELETE', headers: auth });
  assert.equal(del.status, 204);
  const gone = await api(`/api/v1/reports/${reportId}`, { headers: auth });
  assert.equal(gone.status, 404);
});

test('report routes are 401 without a token and 403 without permission', async () => {
  const noAuth = await api('/api/v1/reports');
  assert.equal(noAuth.status, 401);

  const password = 'Password123!';
  const { tenantId } = await onboard();
  const email = `nobody-${shortToken(10).toLowerCase()}@example.com`;
  await userRepository.create({ tenantId, email, status: 'active', passwordHash: await hash(password), profile: { name: 'Nobody' } });
  const login = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email, password } });
  const noRightsAuth = { authorization: `Bearer ${login.json.data.accessToken}`, 'X-Tenant-Id': tenantId };
  const denied = await api('/api/v1/reports', { method: 'POST', headers: noRightsAuth, body: { name: 'Nope' } });
  assert.equal(denied.status, 403);
});

test('invalid report input is 422 and cross-tenant access is 404', async () => {
  const { auth } = await onboard();
  const other = await onboard();

  const bad = await api('/api/v1/reports', { method: 'POST', headers: auth, body: { name: '' } });
  assert.equal(bad.status, 422);

  const created = await api('/api/v1/reports', { method: 'POST', headers: other.auth, body: { name: 'Secret', source: 'query', query: { datasetId: '000000000000000000000000' } } });
  const foreignId = created.json.data._id;

  const get = await api(`/api/v1/reports/${foreignId}`, { headers: auth });
  assert.equal(get.status, 404);
});
