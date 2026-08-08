/**
 * Sprint 2 RBAC surface - end-to-end HTTP integration tests.
 *
 * WHY IT EXISTS
 *   Proves the wired `/roles`, `/permissions`, `/admin`, `/audit-logs` and
 *   `/users` routers work through the real Express app: adminAuth + the
 *   fine-grained `permission` middleware + validators + controllers, against
 *   a real in-memory MongoDB.
 *
 * DESIGN
 *   - One fully-granted platform admin is seeded per test via the services,
 *     then logged in over HTTP so every route is exercised with a real
 *     Bearer token and live permission resolution.
 *   - A negative test proves an admin who lacks the declared permission key
 *     is refused 403 by the permission middleware.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import { factories } from '../helpers/factories.js';
import { shortToken } from '../../src/utils/id.js';

import adminService from '../../src/services/admin.service.js';
import roleService from '../../src/services/role.service.js';
import permissionService from '../../src/services/permission.service.js';
import auditLogService from '../../src/services/auditLog.service.js';
import rbacCache from '../../src/services/rbac.cache.service.js';

import { Role } from '../../src/models/Role.js';
import { UserRole } from '../../src/models/UserRole.js';
import { AdminRole } from '../../src/models/AdminRole.js';
import { Permission } from '../../src/models/Permission.js';
import { Module } from '../../src/models/Module.js';
import { Admin } from '../../src/models/Admin.js';
import { User } from '../../src/models/User.js';

const PASSWORD = 'Password123!';

/** Every permission key the Sprint 2 surface declares on its routes. */
const FULL_KEYS = [
  'iam.roles.view', 'iam.roles.create', 'iam.roles.update', 'iam.roles.delete', 'iam.roles.assign',
  'iam.permissions.view', 'iam.permissions.create', 'iam.permissions.delete',
  'iam.admins.view', 'iam.admins.create', 'iam.admins.update', 'iam.admins.suspend',
  'iam.admins.restore', 'iam.admins.assign',
  'audit_logs.view', 'audit_logs.export',
];

before(async () => {
  await startMongo();
  // Build unique indexes up-front so scoped uniqueness is not racing the
  // background index build.
  await Promise.all([Role.init(), UserRole.init(), AdminRole.init(), Permission.init(), Module.init(), Admin.init(), User.init()]);
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

/* ------------------------------- helpers -------------------------------- */

/** Create a module tree idempotently (parents first). */
async function ensureModule(key) {
  if (key.includes('.')) await ensureModule(key.slice(0, key.lastIndexOf('.')));
  try {
    await permissionService.createModule({ key, name: key });
  } catch (err) {
    if (err.statusCode !== 409) throw err;
  }
}

/** Ensure a `<module>.<action>` permission row exists. */
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

/**
 * Create a platform admin and grant it `keys` through a dedicated platform
 * role (services layer, like a bootstrapped super-admin).
 */
async function seedAdmin(keys, { email = `root-${shortToken(8)}@example.com` } = {}) {
  const admin = await adminService.create({
    email,
    password: PASSWORD,
    adminType: 'platform',
    name: 'Root',
  });
  const role = await roleService.create({ tenantId: null, name: `root_${shortToken(8)}` });
  for (const key of keys) {
    await ensurePermission(key);
    await roleService.addPermission({ roleId: role._id, permissionKey: key, by: admin._id });
  }
  await adminService.assignRole({ adminId: admin._id, roleId: role._id, by: admin._id });
  return admin;
}

/** Login as the admin and return a Bearer auth header object. */
async function adminAuth(admin) {
  const login = await api('/api/v1/admin-auth/login', {
    method: 'POST',
    body: { email: admin.email, password: PASSWORD },
  });
  assert.equal(login.status, 200);
  return { authorization: `Bearer ${login.json.data.accessToken}` };
}

/** Seed a fully-granted admin + token in one step. */
async function root() {
  const admin = await seedAdmin(FULL_KEYS);
  return { admin, auth: await adminAuth(admin) };
}

/* ------------------------------- /roles --------------------------------- */

test('roles routes refuse 401 without an admin token', async () => {
  const res = await api('/api/v1/roles');
  assert.equal(res.status, 401);
});

test('GET /roles lists seeded roles', async () => {
  const { auth } = await root();
  const role = await roleService.create({ tenantId: null, name: 'analyst', by: 'root' });

  const res = await api('/api/v1/roles', { headers: auth });
  assert.equal(res.status, 200);
  assert.ok(res.json.success);
  assert.ok(res.json.data.some((r) => String(r._id) === String(role._id)));
});

test('POST /roles creates then rejects a duplicate name', async () => {
  const { auth } = await root();

  const created = await api('/api/v1/roles', {
    method: 'POST',
    headers: auth,
    body: { name: 'support_admin', description: 'Support' },
  });
  assert.equal(created.status, 201);

  const dup = await api('/api/v1/roles', {
    method: 'POST',
    headers: auth,
    body: { name: 'support_admin' },
  });
  assert.equal(dup.status, 409);
});

test('role permission grant/revoke round-trips and shows in the detail', async () => {
  const { auth } = await root();
  const role = await roleService.create({ tenantId: null, name: 'analyst' });
  const permissionKey = 'iam.roles.view';

  const grant = await api(`/api/v1/roles/${role._id}/permissions`, {
    method: 'POST',
    headers: auth,
    body: { permissionKey },
  });
  assert.equal(grant.status, 201);

  const detail = await api(`/api/v1/roles/${role._id}`, { headers: auth });
  assert.equal(detail.status, 200);
  assert.ok(detail.json.data.permissions.some((p) => p.key === permissionKey));

  const revoke = await api(`/api/v1/roles/${role._id}/permissions`, {
    method: 'DELETE',
    headers: auth,
    body: { permissionKey },
  });
  assert.equal(revoke.status, 200);
});

test('PATCH /roles/:id updates and DELETE /roles/:id removes a role', async () => {
  const { auth } = await root();
  const role = await roleService.create({ tenantId: null, name: 'analyst' });

  const patched = await api(`/api/v1/roles/${role._id}`, {
    method: 'PATCH',
    headers: auth,
    body: { description: 'Renamed role' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.data.description, 'Renamed role');

  const deleted = await api(`/api/v1/roles/${role._id}`, { method: 'DELETE', headers: auth });
  assert.equal(deleted.status, 200);

  const gone = await api(`/api/v1/roles/${role._id}`, { headers: auth });
  assert.equal(gone.status, 404);
});

test('permission middleware refuses 403 when the admin lacks the key', async () => {
  // This admin can manage admins but NOT roles.
  const viewer = await seedAdmin(['iam.admins.view']);
  const auth = await adminAuth(viewer);

  const res = await api('/api/v1/roles', { headers: auth });
  assert.equal(res.status, 403);
});

/* ---------------------------- /permissions ------------------------------- */

test('modules list/create + duplicate rejection', async () => {
  const { auth } = await root();

  const list = await api('/api/v1/permissions/modules', { headers: auth });
  assert.equal(list.status, 200);

  const created = await api('/api/v1/permissions/modules', {
    method: 'POST',
    headers: auth,
    body: { key: 'analytics', name: 'Analytics' },
  });
  assert.equal(created.status, 201);

  const dup = await api('/api/v1/permissions/modules', {
    method: 'POST',
    headers: auth,
    body: { key: 'analytics', name: 'Analytics' },
  });
  assert.equal(dup.status, 409);
});

test('permission create/list + module actions + delete-by-key', async () => {
  const { auth } = await root();
  await ensureModule('analytics');

  const created = await api('/api/v1/permissions', {
    method: 'POST',
    headers: auth,
    body: { module: 'analytics', action: 'view' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.data.key, 'analytics.view');

  const list = await api('/api/v1/permissions?module=analytics', { headers: auth });
  assert.equal(list.status, 200);
  assert.ok(list.json.data.some((p) => p.key === 'analytics.view'));

  const actions = await api('/api/v1/permissions/modules/analytics/actions', { headers: auth });
  assert.equal(actions.status, 200);
  assert.ok(actions.json.data.includes('view'));

  const deleted = await api('/api/v1/permissions', {
    method: 'DELETE',
    headers: auth,
    body: { permissionKey: 'analytics.view' },
  });
  assert.equal(deleted.status, 200);
});

test('permission create rejects a non-canonical action with 422', async () => {
  const { auth } = await root();
  await ensureModule('analytics');

  const res = await api('/api/v1/permissions', {
    method: 'POST',
    headers: auth,
    body: { module: 'analytics', action: 'manage' },
  });
  assert.equal(res.status, 422);
});

test('bulk permission create is idempotent-ish', async () => {
  const { auth } = await root();
  await ensureModule('analytics');

  const res = await api('/api/v1/permissions/bulk', {
    method: 'POST',
    headers: auth,
    body: {
      items: [
        { module: 'analytics', action: 'export' },
        { module: 'analytics', action: 'create' },
      ],
    },
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.data.created, 2);
});

/* -------------------------------- /admin --------------------------------- */

test('GET /admin/admins lists platform admins', async () => {
  const { auth } = await root();
  const res = await api('/api/v1/admin/admins', { headers: auth });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.data));
});

test('POST /admin/admins creates a new platform admin', async () => {
  const { auth } = await root();
  const res = await api('/api/v1/admin/admins', {
    method: 'POST',
    headers: auth,
    body: { email: 'new-ops@example.com', password: 'Password123!', adminType: 'support' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.data.email, 'new-ops@example.com');
  assert.equal(res.json.data.passwordHash, undefined);
});

test('admin detail/update round-trips', async () => {
  const { auth } = await root();
  const admin = await adminService.create({ email: 'ops@example.com', password: PASSWORD, name: 'Ops' });

  const detail = await api(`/api/v1/admin/admins/${admin._id}`, { headers: auth });
  assert.equal(detail.status, 200);

  const updated = await api(`/api/v1/admin/admins/${admin._id}`, {
    method: 'PATCH',
    headers: auth,
    body: { name: 'Ops Lead' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.data.profile.name, 'Ops Lead');
});

test('admin suspend/restore flips status', async () => {
  const { auth } = await root();
  const admin = await adminService.create({ email: 'ops@example.com', password: PASSWORD });

  const suspended = await api(`/api/v1/admin/admins/${admin._id}/suspend`, {
    method: 'POST',
    headers: auth,
    body: { reason: 'security review' },
  });
  assert.equal(suspended.status, 200);
  assert.equal(suspended.json.data.status, 'suspended');

  const restored = await api(`/api/v1/admin/admins/${admin._id}/restore`, {
    method: 'POST',
    headers: auth,
    body: { reason: 'cleared' },
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.json.data.status, 'active');
});

test('admin role assign/revoke + per-admin audit trail', async () => {
  const { auth } = await root();
  const admin = await adminService.create({ email: 'ops@example.com', password: PASSWORD });
  const role = await roleService.create({ tenantId: null, name: 'support_admin' });

  const assigned = await api(`/api/v1/admin/admins/${admin._id}/roles`, {
    method: 'POST',
    headers: auth,
    body: { roleId: String(role._id) },
  });
  assert.equal(assigned.status, 200);

  const revoked = await api(`/api/v1/admin/admins/${admin._id}/roles/${role._id}`, {
    method: 'DELETE',
    headers: auth,
  });
  assert.equal(revoked.status, 200);

  const audit = await api(`/api/v1/admin/admins/${admin._id}/audit`, { headers: auth });
  assert.equal(audit.status, 200);
  assert.ok(Array.isArray(audit.json.data));
});

/* ----------------------------- /audit-logs -------------------------------- */

test('audit-logs list + detail are admin-gated reads', async () => {
  const { auth } = await root();
  const entry = await auditLogService.emit({
    actor: { type: 'admin', id: 'root', display: 'root' },
    action: 'create',
    module: 'iam.tenants',
    tenantId: 't1',
  });

  const list = await api('/api/v1/audit-logs', { headers: auth });
  assert.equal(list.status, 200);
  assert.ok(list.json.data.some((e) => String(e._id) === String(entry._id)));

  const detail = await api(`/api/v1/audit-logs/${entry._id}`, { headers: auth });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.data.module, 'iam.tenants');
});

/* ------------------------------- /users ---------------------------------- */

/** Create + login a tenant user under a real active tenant; returns Bearer auth header. */
async function userAuth() {
  const tenant = await factories.tenant.create();
  const tenantId = tenant._id.toString();
  const user = await factories.user.create({ tenantId });
  const login = await api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'x-tenant-id': tenantId },
    body: { email: user.email, password: PASSWORD },
  });
  assert.equal(login.status, 200);
  return { tenant, tenantId, user, auth: { authorization: `Bearer ${login.json.data.accessToken}` } };
}

test('GET /users/me returns the caller profile without secrets', async () => {
  const { user, auth } = await userAuth();
  const res = await api('/api/v1/users/me', { headers: auth });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.email, user.email);
  assert.equal(res.json.data.passwordHash, undefined);
});

test('PATCH /users/me updates own profile fields', async () => {
  const { auth } = await userAuth();
  const res = await api('/api/v1/users/me', {
    method: 'PATCH',
    headers: auth,
    body: { name: 'Ada', locale: 'fr' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.profile.name, 'Ada');
  assert.equal(res.json.data.profile.locale, 'fr');
});

test('GET /users lists + detail is tenant-scoped', async () => {
  const { tenantId, auth } = await userAuth();
  await factories.user.create({ tenantId });
  await factories.user.create({ tenantId });

  const list = await api('/api/v1/users', { headers: auth });
  assert.equal(list.status, 200);
  assert.ok(list.json.data.length >= 2);

  const first = await factories.user.create({ tenantId });
  const detail = await api(`/api/v1/users/${first._id}`, { headers: auth });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.data.email, first.email);
});
