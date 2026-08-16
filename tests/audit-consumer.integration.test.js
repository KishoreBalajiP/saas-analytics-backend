/**
 * Audit plugin consumer - model-change trail (Sprint 8).
 *
 * WHY IT EXISTS
 *   The `audit` Mongoose plugin emits `create` / `update` / `softDelete` /
 *   `restore` events; `services/auditConsumer.service.js` persists them to
 *   `AuditLog`. These tests prove:
 *     - model mutations inside an actor context are attributed to the real
 *       requester (type + id) and carry the request id;
 *     - writes outside a request are attributed to `system`;
 *     - updates persist a before/after diff;
 *     - soft-delete saves produce a semantic `softDelete` row and do NOT
 *       double-log a redundant `update` row;
 *     - end to end, an authenticated admin's HTTP mutations land in the
 *       trail attributed to that admin.
 *
 * DESIGN
 *   - The consumer is wired by `app.js` (imported via `helpers/http.js`),
 *     exactly as in production.
 *   - Service-level cases drive the `Role` model directly inside
 *     `runWithContext`; the HTTP case goes through the `/roles` surface.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from './helpers/mongo.js';
import { startHttp, stopHttp, api } from './helpers/http.js';
import { shortToken } from '../src/utils/id.js';
import { runWithContext } from '../src/utils/actorContext.js';
import adminService from '../src/services/admin.service.js';
import roleService from '../src/services/role.service.js';
import permissionService from '../src/services/permission.service.js';
import rbacCache from '../src/services/rbac.cache.service.js';

import { AuditLog } from '../src/models/AuditLog.js';
import { Role } from '../src/models/Role.js';
import { AdminRole } from '../src/models/AdminRole.js';
import { Permission } from '../src/models/Permission.js';
import { Module } from '../src/models/Module.js';
import { Admin } from '../src/models/Admin.js';

const PASSWORD = 'Password123!';
const ROLE_KEYS = ['iam.roles.view', 'iam.roles.create', 'iam.roles.update'];

before(async () => {
  await startMongo();
  await Promise.all([
    Role.init(), AdminRole.init(), Permission.init(), Module.init(), Admin.init(), AuditLog.init(),
  ]);
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

/** Poll until an audit row matches `predicate` (consumer writes are async). */
async function waitForAudit(predicate, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await AuditLog.findOne(predicate).lean();
    if (row) return row;
    assert.ok(Date.now() < deadline, `no audit row matched ${JSON.stringify(predicate)} within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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

async function seedAdmin(keys) {
  const admin = await adminService.create({
    email: `root-${shortToken(8)}@example.com`,
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

async function adminAuth(admin) {
  const login = await api('/api/v1/admin-auth/login', {
    method: 'POST',
    body: { email: admin.email, password: PASSWORD },
  });
  assert.equal(login.status, 200);
  return { authorization: `Bearer ${login.json.data.accessToken}` };
}

/** Platform-level role document (no tenant scope needed). */
function platformRole(overrides = {}) {
  return { tenantId: null, level: 'platform', isSystem: false, ...overrides };
}

/* ------------------ service-level: actor context + events ---------------- */

test('create inside an actor context records the real actor and request id', async () => {
  await runWithContext(
    { actor: { type: 'admin', id: 'adm-1', email: 'ops@example.com' }, requestId: 'req-123' },
    async () => {
      await Role.create(platformRole({ name: `r_${shortToken(8)}` }));
    },
  );

  const row = await waitForAudit({
    module: 'iam.roles', action: 'create', actorType: 'admin', actorId: 'adm-1',
  });
  assert.equal(row.resourceType, 'role');
  assert.ok(row.after.name.startsWith('r_'));
  assert.equal(row.requestId, 'req-123');
  assert.equal(row.tenantId, null);
});

test('update inside an actor context persists a before/after diff', async () => {
  let roleId;
  await runWithContext({ actor: { type: 'admin', id: 'adm-2' } }, async () => {
    const role = await Role.create(platformRole({ name: `r_${shortToken(8)}` }));
    roleId = String(role._id);
  });

  await runWithContext({ actor: { type: 'admin', id: 'adm-2' } }, async () => {
    const role = await Role.findOne({ _id: roleId });
    role.description = 'renamed via consumer test';
    await role.save();
  });

  const row = await waitForAudit({
    module: 'iam.roles', action: 'update', actorId: 'adm-2', resourceId: roleId,
  });
  assert.equal(row.after.description, 'renamed via consumer test');
  assert.equal(row.before.description, '');
  assert.equal(row.resourceType, 'role');
});

test('writes outside an actor context are attributed to system', async () => {
  await Role.create(platformRole({ name: `r_${shortToken(8)}` }));

  const row = await waitForAudit({ module: 'iam.roles', action: 'create', actorType: 'system' });
  assert.equal(row.actorId, null);
});

test('soft delete emits a semantic row and not a redundant update', async () => {
  let role;
  await runWithContext({ actor: { type: 'user', id: 'u-1' } }, async () => {
    role = await Role.create(platformRole({ name: `r_${shortToken(8)}` }));
  });
  const roleId = String(role._id);

  await runWithContext({ actor: { type: 'user', id: 'u-1' } }, async () => {
    await role.softDelete('u-1');
  });

  const row = await waitForAudit({ module: 'iam.roles', action: 'softDelete', resourceId: roleId });
  assert.equal(row.actorType, 'user');
  assert.equal(row.actorId, 'u-1');
  assert.ok(row.before.name.startsWith('r_'), 'soft-delete row carries the prior state');

  const redundant = await AuditLog.findOne({ module: 'iam.roles', action: 'update', resourceId: roleId }).lean();
  assert.equal(redundant, null, 'a soft-delete save must not double-log an update row');
});

/* ------------------- HTTP end-to-end: attribution via auth -------------- */

test('an authenticated admin creates and updates a role; both land in the trail', async () => {
  const admin = await seedAdmin(ROLE_KEYS);
  const auth = await adminAuth(admin);

  const created = await api('/api/v1/roles', {
    method: 'POST',
    headers: auth,
    body: { name: `ops_${shortToken(8)}`, description: 'ops role' },
  });
  assert.equal(created.status, 201);
  const roleId = created.json.data._id;

  const createRow = await waitForAudit({
    module: 'iam.roles', action: 'create', actorType: 'admin', actorId: admin._id.toString(), resourceId: roleId,
  });
  assert.equal(createRow.after.description, 'ops role');

  const updated = await api(`/api/v1/roles/${roleId}`, {
    method: 'PATCH',
    headers: auth,
    body: { description: 'ops role v2' },
  });
  assert.equal(updated.status, 200);

  const updateRow = await waitForAudit({
    module: 'iam.roles', action: 'update', actorId: admin._id.toString(), resourceId: roleId,
  });
  assert.equal(updateRow.after.description, 'ops role v2');
  assert.ok(updateRow.requestId, 'trail row carries the request id');
});
