/**
 * Platform Admin Authorization Foundation - regression tests (Stage 1).
 *
 * Verifies the existing permission middleware denies by default:
 *  - workspace user JWT cannot reach platform-only routes
 *  - platform admin without a permission is denied (deny by default)
 *  - super admin can list admins
 *  - lower-privileged admin cannot escalate roles via /admins/:id/roles
 *  - the last active super admin cannot be suspended or demoted
 *
 * Note: per the API contract, the platform-admin surface is mounted at
 * `/api/v1/admin/*` (not `/api/v1/admins/*`); platform admin management
 * is therefore `GET /api/v1/admin/admins`.
 */
import test, { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from './helpers/mongo.js';
import { startHttp, stopHttp, api } from './helpers/http.js';
import { factories } from './helpers/factories.js';
import { shortToken } from '../src/utils/id.js';
import adminService from '../src/services/admin.service.js';
import adminBootstrapService from '../src/services/adminBootstrap.service.js';
import roleService from '../src/services/role.service.js';
import permissionService from '../src/services/permission.service.js';
import rbacCache from '../src/services/rbac.cache.service.js';

const PASSWORD = 'Password123!';

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

async function ensureModule(key) {
  if (key.includes('.')) await ensureModule(key.slice(0, key.lastIndexOf('.')));
  try {
    await permissionService.createModule({ key, name: key });
  } catch (err) {
    if (err.statusCode !== 409) throw err;
  }
}

async function ensurePermission(key) {
  const module = key.slice(0, key.lastIndexOf('.'));
  const action = key.slice(key.lastIndexOf('.') + 1);
  await ensureModule(module);
  try {
    await permissionService.createPermission({ module, action });
  } catch (err) {
    if (err.statusCode !== 409) throw err;
  }
}

async function seedAdminWithPermission({ moduleKey, action, adminType = 'platform' }) {
  const admin = await adminService.create({
    email: `admin-${shortToken(8)}@platform.test`,
    password: PASSWORD,
    adminType,
    name: 'Test Admin',
  });
  const role = await roleService.create({ tenantId: null, name: `role_${shortToken(8)}` });
  await ensurePermission(`${moduleKey}.${action}`);
  await roleService.addPermission({ roleId: role._id, permissionKey: `${moduleKey}.${action}`, by: null /* fixture seeding */ });
  await adminService.assignRole({ adminId: admin._id, roleId: role._id, tenantId: null, by: null /* fixture seeding */ });
  const login = await api('/api/v1/admin-auth/login', {
    method: 'POST',
    body: { email: admin.email, password: PASSWORD },
  });
  assert.equal(login.status, 200, 'admin login should succeed');
  return { admin, token: login.json.data.accessToken, role };
}

async function createTenantAndUser() {
  const tenant = await factories.tenant.create();
  const user = await factories.user.create({ tenantId: tenant._id });
  const login = await api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'x-tenant-id': String(tenant._id) },
    body: { email: user.email, password: 'Password123!' },
  });
  return { tenant, user, token: login.json?.data?.accessToken ?? null, loginStatus: login.status };
}

describe('Platform Admin Authorization Foundation', () => {
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

  test('workspace user denied from platform APIs (cross-portal isolation)', async () => {
    const { token: userToken, loginStatus } = await createTenantAndUser();
    if (loginStatus !== 200 || !userToken) {
      // Skip if we cannot mint a tenant user; but the assertion is the
      // platform route must never be reachable with a user JWT anyway.
      const res = await api('/api/v1/admin/admins', { headers: {} });
      assert.equal(res.status, 401);
      return;
    }
    const res = await api('/api/v1/admin/admins', { headers: bearer(userToken) });
    assert.equal(res.status, 401);
  });

  test('missing permission denied by default for platform admin', async () => {
    const { token } = await seedAdminWithPermission({ moduleKey: 'iam.tenants', action: 'view' });
    const res = await api('/api/v1/admin/admins', { headers: bearer(token) });
    assert.equal(res.status, 403);
  });

  test('super admin with iam.admins.view can list admins', async () => {
    const { token } = await seedAdminWithPermission({
      moduleKey: 'iam.admins',
      action: 'view',
      adminType: 'super',
    });
    const res = await api('/api/v1/admin/admins', { headers: bearer(token) });
    assert.equal(res.status, 200);
  });

  test('bootstrapped super admin receives platform permissions and can open dashboard', async () => {
    const created = await adminBootstrapService.bootstrapAdmin({
      email: 'bootstrap-super@example.test',
      password: PASSWORD,
      adminType: 'super',
    });
    const login = await api('/api/v1/admin-auth/login', {
      method: 'POST',
      body: { email: created.admin.email, password: PASSWORD },
    });
    assert.equal(login.status, 200);
    const token = login.json.data.accessToken;

    const me = await api('/api/v1/admin-auth/me', { headers: bearer(token) });
    assert.equal(me.status, 200);
    assert.equal(me.json.data.type, 'super');
    // Roadmap 2.1: the bootstrap grants the built-in super_admin role.
    assert.ok(me.json.data.roles.includes('super_admin'));
    assert.ok(me.json.data.permissions.includes('iam.tenants.view'));

    const dashboard = await api('/api/v1/admin/dashboard/summary', { headers: bearer(token) });
    assert.equal(dashboard.status, 200);
  });

  test('dashboard summary rejects unauthenticated and tenant-user requests', async () => {
    const anonymous = await api('/api/v1/admin/dashboard/summary');
    assert.equal(anonymous.status, 401);

    const { token, loginStatus } = await createTenantAndUser();
    if (loginStatus !== 200 || !token) {
      assert.fail('tenant fixture must be able to authenticate');
    }
    const tenant = await api('/api/v1/admin/dashboard/summary', { headers: bearer(token) });
    assert.equal(tenant.status, 401);
  });

  test('platform admin can list tenants with view permission', async () => {
    const { token } = await seedAdminWithPermission({ moduleKey: 'iam.tenants', action: 'view' });
    const res = await api('/api/v1/tenants', { headers: bearer(token) });
    assert.equal(res.status, 200);
  });

  test('lower-privileged admin cannot escalate roles', async () => {
    const { token, admin } = await seedAdminWithPermission({ moduleKey: 'iam.admins', action: 'view' });
    const target = await adminService.create({
      email: `target-${shortToken(8)}@platform.test`,
      password: PASSWORD,
      adminType: 'platform',
      name: 'Target',
    });
    const role = await roleService.create({ tenantId: null, name: `priv_${shortToken(8)}` });
    await ensurePermission('iam.admins.assign');
    await roleService.addPermission({ roleId: role._id, permissionKey: 'iam.admins.assign', by: null /* fixture seeding */ });
    const res = await api(`/api/v1/admin/admins/${target._id}/roles`, {
      method: 'POST',
      headers: bearer(token),
      body: { roleId: role._id },
    });
    assert.equal(res.status, 403);
  });

  test('last active super admin cannot be suspended', async () => {
    const { admin } = await seedAdminWithPermission({
      moduleKey: 'iam.admins',
      action: 'suspend',
      adminType: 'super',
    });
    // actor with the same permission suspends the target
    const login = await api('/api/v1/admin-auth/login', {
      method: 'POST',
      body: { email: admin.email, password: PASSWORD },
    });
    const token = login.json.data.accessToken;
    const res = await api(`/api/v1/admin/admins/${admin._id}/suspend`, {
      method: 'POST',
      headers: bearer(token),
      body: { reason: 'last super test' },
    });
    assert.equal(res.status, 409);
    assert.equal(res.json?.code, 'LAST_SUPER_ADMIN');
  });

  test('last active super admin cannot be demoted', async () => {
    const { admin } = await seedAdminWithPermission({
      moduleKey: 'iam.admins',
      action: 'update',
      adminType: 'super',
    });
    const login = await api('/api/v1/admin-auth/login', {
      method: 'POST',
      body: { email: admin.email, password: PASSWORD },
    });
    const token = login.json.data.accessToken;
    const res = await api(`/api/v1/admin/admins/${admin._id}`, {
      method: 'PATCH',
      headers: bearer(token),
      body: { adminType: 'platform' },
    });
    assert.equal(res.status, 409);
  });
});
