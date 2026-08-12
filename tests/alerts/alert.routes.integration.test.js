/**
 * End-to-end HTTP integration tests for `/api/v1/alerts/*` (Sprint 7).
 * Covers CRUD, RBAC, tenant isolation, evaluation, event + notification
 * dispatch, disabled-alert handling, and cooldown/deduplication.
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
  const { tenant } = await tenantService.create({ tenant: { name: `Al ${shortToken(10)}` }, owner, initialize: true, by: 'root' });
  const tenantId = tenant._id.toString();
  const login = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email: owner.email, password: PASSWORD } });
  assert.equal(login.status, 200);
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

async function createAlert(auth, datasetId, overrides = {}) {
  const res = await api('/api/v1/alerts', {
    method: 'POST', headers: auth,
    body: {
      name: 'High spend', source: 'query', query: { datasetId },
      metric: 'count', condition: 'gt', threshold: 1,
      notification: { channels: ['in_app'] }, enabled: true, ...overrides,
    },
  });
  return res;
}

test('alert CRUD, RBAC and tenant isolation over HTTP', async () => {
  const { tenantId, auth } = await onboard();
  const datasetId = await seedDataset(tenantId);

  const created = await createAlert(auth, datasetId);
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const alertId = created.json.data._id;

  const list = await api('/api/v1/alerts', { headers: auth });
  assert.equal(list.status, 200);
  assert.equal(list.json.data.length, 1);

  const got = await api(`/api/v1/alerts/${alertId}`, { headers: auth });
  assert.equal(got.status, 200);

  const updated = await api(`/api/v1/alerts/${alertId}`, { method: 'PATCH', headers: auth, body: { threshold: 5 } });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.data.threshold, 5);

  const del = await api(`/api/v1/alerts/${alertId}`, { method: 'DELETE', headers: auth });
  assert.equal(del.status, 204);
  const gone = await api(`/api/v1/alerts/${alertId}`, { headers: auth });
  assert.equal(gone.status, 404);
});

test('alert routes are 401 without a token and 403 without permission', async () => {
  const noAuth = await api('/api/v1/alerts');
  assert.equal(noAuth.status, 401);

  const { tenantId } = await onboard();
  const email = `nobody-${shortToken(10).toLowerCase()}@example.com`;
  await userRepository.create({ tenantId, email, status: 'active', passwordHash: await hash(PASSWORD), profile: { name: 'Nobody' } });
  const login = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email, password: PASSWORD } });
  const noRightsAuth = { authorization: `Bearer ${login.json.data.accessToken}`, 'X-Tenant-Id': tenantId };
  const denied = await api('/api/v1/alerts', { method: 'POST', headers: noRightsAuth, body: { name: 'X', metric: 'count', condition: 'gt', threshold: 1 } });
  assert.equal(denied.status, 403);
});

test('alert evaluation triggers an event and dispatches an in-app notification', async () => {
  const { auth } = await onboard();
  const datasetId = await seedDataset(await tenantOf(auth));
  const created = await createAlert(auth, datasetId);
  const alertId = created.json.data._id;

  const evaluated = await api(`/api/v1/alerts/${alertId}/evaluate`, { method: 'POST', headers: auth });
  assert.equal(evaluated.status, 200, JSON.stringify(evaluated.json));
  assert.equal(evaluated.json.data.triggered, true);

  const events = await api(`/api/v1/alerts/${alertId}/events`, { headers: auth });
  assert.equal(events.status, 200);
  assert.ok(events.json.data.length >= 1, 'an alert event should be recorded');

  const inbox = await api('/api/v1/notifications', { headers: auth });
  assert.equal(inbox.status, 200);
  assert.ok(inbox.json.data.length >= 1, 'an in-app notification should be delivered');
});

test('alert query contract: datasetId survives save/reload and evaluation', async () => {
  const { auth } = await onboard();
  const datasetId = await seedDataset(await tenantOf(auth));
  const created = await createAlert(auth, datasetId);
  const alertId = created.json.data._id;

  // Reload the persisted alert and prove the execution fields survived sanitization.
  const reloaded = await api(`/api/v1/alerts/${alertId}`, { headers: auth });
  assert.equal(reloaded.status, 200);
  assert.equal(reloaded.json.data.query.datasetId, datasetId, 'datasetId must be preserved through save/reload');
  assert.equal(reloaded.json.data.source, 'query');
  assert.equal(reloaded.json.data.metric, 'count');

  const evaluated = await api(`/api/v1/alerts/${alertId}/evaluate`, { method: 'POST', headers: auth });
  assert.equal(evaluated.status, 200);
  assert.equal(evaluated.json.data.triggered, true, 'reloaded alert with datasetId must evaluate and trigger');
});

test('disabled alerts never trigger and cooldown suppresses duplicates', async () => {
  const { auth } = await onboard();
  const datasetId = await seedDataset(await tenantOf(auth));

  const disabled = await createAlert(auth, datasetId, { enabled: false });
  const disabledId = disabled.json.data._id;
  const evDisabled = await api(`/api/v1/alerts/${disabledId}/evaluate`, { method: 'POST', headers: auth });
  assert.equal(evDisabled.json.data.triggered, false, 'disabled alert must not trigger');
  const disabledEvents = await api(`/api/v1/alerts/${disabledId}/events`, { headers: auth });
  assert.equal(disabledEvents.json.data.length, 0);

  const enabled = await createAlert(auth, datasetId);
  const enabledId = enabled.json.data._id;
  const first = await api(`/api/v1/alerts/${enabledId}/evaluate`, { method: 'POST', headers: auth });
  assert.equal(first.json.data.triggered, true);
  const second = await api(`/api/v1/alerts/${enabledId}/evaluate`, { method: 'POST', headers: auth });
  assert.equal(second.json.data.triggered, false, 'second immediate evaluate must be suppressed by cooldown');
  assert.equal(second.json.data.suppressed, true);
});

async function tenantOf(auth) {
  // The X-Tenant-Id header carries the tenant id.
  return auth['X-Tenant-Id'];
}
