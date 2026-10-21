import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from './helpers/mongo.js';
import { startHttp, stopHttp, api } from './helpers/http.js';
import { factories } from './helpers/factories.js';
import tenantInitializationService from '../src/services/tenantInitialization.service.js';
import adminBootstrapService from '../src/services/adminBootstrap.service.js';
import adminRepository from '../src/repositories/admin.repository.js';
import roleRepository from '../src/repositories/role.repository.js';
import rbacCache from '../src/services/rbac.cache.service.js';
import AccessRequest from '../src/models/AccessRequest.js';
import TenantInvitation from '../src/models/TenantInvitation.js';

const PASSWORD = 'Password123!';

function bearer(token) { return { authorization: `Bearer ${token}` }; }

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => { await resetMongo(); await rbacCache.clearAll(); });
after(async () => { await stopHttp(); await stopMongo(); });

/** An admin of `adminType` holding the built-in platform role `roleName` (or none). */
async function adminWithRole({ adminType = 'platform', roleName = 'platform_admin', tenantScope = null } = {}) {
  await adminBootstrapService.syncPlatformCatalogue({ by: 'test' });
  const admin = await factories.admin.create({ adminType, ...(tenantScope ? { tenantScope } : {}) });
  if (roleName) {
    const role = await roleRepository.findByName({ tenantId: null, name: roleName });
    await adminRepository.assignRole(String(admin._id), role._id, { tenantId: null, by: 'test' });
  }
  const login = await api('/api/v1/admin-auth/login', { method: 'POST', body: { email: admin.email, password: PASSWORD } });
  assert.equal(login.status, 200);
  return { admin, token: login.json.data.accessToken };
}

async function submitRequest(email) {
  const res = await api('/api/v1/access-requests', { method: 'POST', body: { name: 'Grace Visitor', email, workspaceName: 'Acme Inc.' } });
  assert.equal(res.status, 202);
  return (await AccessRequest.findOne({ email }))._id.toString();
}

async function activeTenant() {
  const tenant = await factories.tenant.create();
  await tenantInitializationService.initialize({ tenantId: String(tenant._id), owner: { email: `owner-${tenant._id}@example.test`, name: 'Owner' } });
  return tenant;
}

test('anonymous access requests are persisted and duplicate pending submissions are idempotent', async () => {
  const body = { name: 'Ada Requester', email: 'ada@example.test', workspaceName: 'Acme Inc.', reason: 'Need reporting access' };
  const first = await api('/api/v1/access-requests', { method: 'POST', body });
  const second = await api('/api/v1/access-requests', { method: 'POST', body });
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(first.json.data.reference, second.json.data.reference);
  assert.equal(await AccessRequest.countDocuments({ email: body.email }), 1);
});

test('access requests require the approval permission and approval hands off to invitations', async () => {
  const requestId = await submitRequest('grace@example.test');
  assert.equal((await api('/api/v1/access-requests')).status, 401);

  const { token } = await adminWithRole({ adminType: 'platform', roleName: 'platform_admin' });
  assert.equal((await api('/api/v1/access-requests', { headers: bearer(token) })).status, 200);

  const tenant = await activeTenant();
  const approved = await api(`/api/v1/access-requests/${requestId}/approve`, { method: 'POST', headers: bearer(token), body: { tenantId: String(tenant._id), roleName: 'Viewer' } });
  assert.equal(approved.status, 200);
  assert.equal(approved.json.data.request.status, 'approved');
  assert.equal(await TenantInvitation.countDocuments({ invitedEmail: 'grace@example.test', tenantId: String(tenant._id), status: 'pending' }), 1);
});

test('Platform Admin can reject a request without exposing request data to anonymous callers', async () => {
  const requestId = await submitRequest('ruth@example.test');
  const { token } = await adminWithRole({ adminType: 'platform', roleName: 'platform_admin' });
  const rejected = await api(`/api/v1/access-requests/${requestId}/reject`, { method: 'POST', headers: bearer(token), body: { note: 'Workspace could not be matched' } });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.json.data.status, 'rejected');
  assert.equal((await api(`/api/v1/access-requests/${requestId}`)).status, 404);
});

test('a platform admin without the approval permission cannot list, approve or reject (adminType alone is not enough)', async () => {
  const requestId = await submitRequest('nobody@example.test');
  const tenant = await activeTenant();
  const { token } = await adminWithRole({ adminType: 'platform', roleName: null });
  assert.equal((await api('/api/v1/access-requests', { headers: bearer(token) })).status, 403);
  const approve = await api(`/api/v1/access-requests/${requestId}/approve`, { method: 'POST', headers: bearer(token), body: { tenantId: String(tenant._id), roleName: 'Viewer' } });
  assert.equal(approve.status, 403);
  assert.equal((await api(`/api/v1/access-requests/${requestId}/reject`, { method: 'POST', headers: bearer(token), body: {} })).status, 403);
  assert.equal((await AccessRequest.findById(requestId)).status, 'pending');
});

test('auditors and support operators cannot approve; auditors may view the queue', async () => {
  const requestId = await submitRequest('audit@example.test');
  const tenant = await activeTenant();
  const auditor = await adminWithRole({ adminType: 'auditor', roleName: 'auditor' });
  assert.equal((await api('/api/v1/access-requests', { headers: bearer(auditor.token) })).status, 200);
  const byAuditor = await api(`/api/v1/access-requests/${requestId}/approve`, { method: 'POST', headers: bearer(auditor.token), body: { tenantId: String(tenant._id) } });
  assert.equal(byAuditor.status, 403);

  const support = await adminWithRole({ adminType: 'support', roleName: 'support_operator' });
  assert.equal((await api('/api/v1/access-requests', { headers: bearer(support.token) })).status, 403);
  const bySupport = await api(`/api/v1/access-requests/${requestId}/approve`, { method: 'POST', headers: bearer(support.token), body: { tenantId: String(tenant._id) } });
  assert.equal(bySupport.status, 403);
  assert.equal(await TenantInvitation.countDocuments({ invitedEmail: 'audit@example.test' }), 0);
});

test('approval only invites with an allowed role (never Owner or Admin)', async () => {
  const requestId = await submitRequest('owner-attempt@example.test');
  const tenant = await activeTenant();
  const { token } = await adminWithRole({ adminType: 'platform', roleName: 'platform_admin' });
  for (const roleName of ['Owner', 'Admin', 'Superuser']) {
    const res = await api(`/api/v1/access-requests/${requestId}/approve`, { method: 'POST', headers: bearer(token), body: { tenantId: String(tenant._id), roleName } });
    assert.equal(res.status, 422, `${roleName} must be rejected`);
  }
  assert.equal(await TenantInvitation.countDocuments({ invitedEmail: 'owner-attempt@example.test' }), 0);
  const manager = await api(`/api/v1/access-requests/${requestId}/approve`, { method: 'POST', headers: bearer(token), body: { tenantId: String(tenant._id), roleName: 'Manager' } });
  assert.equal(manager.status, 200);
});

test('a tenant-scoped admin cannot review the platform-wide access-request queue', async () => {
  const tenant = await activeTenant();
  const requestId = await submitRequest('scoped@example.test');
  const { token } = await adminWithRole({ adminType: 'platform', roleName: 'platform_admin', tenantScope: String(tenant._id) });
  const list = await api('/api/v1/access-requests', { headers: bearer(token) });
  assert.equal(list.status, 403);
  assert.equal(list.json.code, 'ADMIN_SCOPE_DENIED');
  const approve = await api(`/api/v1/access-requests/${requestId}/approve`, { method: 'POST', headers: bearer(token), body: { tenantId: String(tenant._id), roleName: 'Viewer' } });
  assert.equal(approve.status, 403);
});
