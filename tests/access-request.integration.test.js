import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from './helpers/mongo.js';
import { startHttp, stopHttp, api } from './helpers/http.js';
import { factories } from './helpers/factories.js';
import tenantInitializationService from '../src/services/tenantInitialization.service.js';
import AccessRequest from '../src/models/AccessRequest.js';
import TenantInvitation from '../src/models/TenantInvitation.js';

const PASSWORD = 'Password123!';

function bearer(token) { return { authorization: `Bearer ${token}` }; }

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => { await resetMongo(); });
after(async () => { await stopHttp(); await stopMongo(); });

test('anonymous access requests are persisted and duplicate pending submissions are idempotent', async () => {
  const body = { name: 'Ada Requester', email: 'ada@example.test', workspaceName: 'Acme Inc.', reason: 'Need reporting access' };
  const first = await api('/api/v1/access-requests', { method: 'POST', body });
  const second = await api('/api/v1/access-requests', { method: 'POST', body });
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(first.json.data.reference, second.json.data.reference);
  assert.equal(await AccessRequest.countDocuments({ email: body.email }), 1);
});

test('access requests require Platform Admin authorization and approval hands off to invitations', async () => {
  const visitor = await api('/api/v1/access-requests', { method: 'POST', body: { name: 'Grace Visitor', email: 'grace@example.test', workspaceName: 'Acme Inc.' } });
  const requestId = (await AccessRequest.findOne({ email: 'grace@example.test' }))._id.toString();
  assert.equal(visitor.status, 202);
  assert.equal((await api('/api/v1/access-requests')).status, 401);

  const admin = await factories.admin.create({ adminType: 'platform' });
  const login = await api('/api/v1/admin-auth/login', { method: 'POST', body: { email: admin.email, password: PASSWORD } });
  assert.equal(login.status, 200);
  const token = login.json.data.accessToken;
  assert.equal((await api('/api/v1/access-requests', { headers: bearer(token) })).status, 200);

  const tenant = await factories.tenant.create();
  await tenantInitializationService.initialize({ tenantId: String(tenant._id), owner: { email: 'owner@example.test', name: 'Owner' } });
  const approved = await api(`/api/v1/access-requests/${requestId}/approve`, { method: 'POST', headers: bearer(token), body: { tenantId: String(tenant._id), roleName: 'Viewer' } });
  assert.equal(approved.status, 200);
  assert.equal(approved.json.data.request.status, 'approved');
  assert.equal(await TenantInvitation.countDocuments({ invitedEmail: 'grace@example.test', tenantId: String(tenant._id), status: 'pending' }), 1);
});

test('Platform Admin can reject a request without exposing request data to anonymous callers', async () => {
  await api('/api/v1/access-requests', { method: 'POST', body: { name: 'Ruth Visitor', email: 'ruth@example.test', workspaceName: 'Acme Inc.' } });
  const request = await AccessRequest.findOne({ email: 'ruth@example.test' });
  const admin = await factories.admin.create({ adminType: 'platform' });
  const login = await api('/api/v1/admin-auth/login', { method: 'POST', body: { email: admin.email, password: PASSWORD } });
  const rejected = await api(`/api/v1/access-requests/${request._id}/reject`, { method: 'POST', headers: bearer(login.json.data.accessToken), body: { note: 'Workspace could not be matched' } });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.json.data.status, 'rejected');
  assert.equal((await api(`/api/v1/access-requests/${request._id}`)).status, 404);
});
