/**
 * Sprint 2 RBAC services - integration tests against a real MongoDB.
 *
 * WHY IT EXISTS
 *   The RBAC service layer (roles, permissions, admin lifecycle, audit)
 *   is where business rules live: scoped role names, system-role
 *   immutability, live-assignment delete guards, RBAC cache invalidation,
 *   admin session revocation on suspend, and audit redaction. These tests
 *   exercise the services end-to-end against mongodb-memory-server.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import permissionService from '../../src/services/permission.service.js';
import roleService from '../../src/services/role.service.js';
import adminService from '../../src/services/admin.service.js';
import auditLogService from '../../src/services/auditLog.service.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import { Role } from '../../src/models/Role.js';
import { UserRole } from '../../src/models/UserRole.js';

before(async () => {
  await startMongo();
  // Build unique indexes up-front so scoped-uniqueness tests are not
  // racing the background index build.
  await Role.init();
  await UserRole.init();
});

beforeEach(async () => {
  await resetMongo();
  await rbacCache.clearAll();
});

after(async () => {
  await stopMongo();
});

/* ----------------------------- permission svc ---------------------------- */

test('createModule registers dotted modules under their parent', async () => {
  const iam = await permissionService.createModule({ key: 'iam', name: 'Identity & Access' });
  assert.ok(iam._id);
  const iamUsers = await permissionService.createModule({ key: 'iam.users', name: 'IAM Users' });
  assert.equal(iamUsers.parentKey, 'iam');
  await assert.rejects(
    permissionService.createModule({ key: 'bad key', name: 'Bad' }),
    (e) => e.statusCode === 400,
  );
});

test('duplicate module key is rejected with 409', async () => {
  await permissionService.createModule({ key: 'iam', name: 'IAM' });
  await assert.rejects(
    permissionService.createModule({ key: 'iam', name: 'dup' }),
    (e) => e.statusCode === 409 && e.code === 'CONFLICT',
  );
});

test('createPermission enforces canonical actions and unique keys', async () => {
  await permissionService.createModule({ key: 'iam', name: 'IAM' });
  await permissionService.createModule({ key: 'iam.users', name: 'IAM Users' });
  const perm = await permissionService.createPermission({ module: 'iam.users', action: 'view' });
  assert.equal(perm.key, 'iam.users.view');
  assert.ok(perm.moduleId, 'moduleId is denormalised onto the permission');
  await assert.rejects(
    permissionService.createPermission({ module: 'iam.users', action: 'view' }),
    (e) => e.statusCode === 409,
  );
  await assert.rejects(
    permissionService.createPermission({ module: 'iam.users', action: 'shred' }),
    (e) => e.statusCode === 400,
  );
});

test('bulkCreatePermissions skips duplicates and missing modules fail', async () => {
  await permissionService.createModule({ key: 'iam', name: 'IAM' });
  await permissionService.createModule({ key: 'iam.users', name: 'IAM Users' });
  const { created, skipped } = await permissionService.bulkCreatePermissions({
    items: [
      { module: 'iam.users', action: 'create' },
      { module: 'iam.users', action: 'update' },
      { module: 'iam.users', action: 'create' }, // duplicate within batch
    ],
  });
  assert.equal(created, 2);
  assert.equal(skipped, 0);
  await assert.rejects(
    permissionService.bulkCreatePermissions({ items: [{ module: 'missing', action: 'view' }] }),
    (e) => e.statusCode === 404,
  );
});

test('deletePermission refuses system permissions and soft-deletes otherwise', async () => {
  await permissionService.createModule({ key: 'iam', name: 'IAM' });
  await permissionService.createModule({ key: 'iam.users', name: 'IAM Users' });
  const perm = await permissionService.createPermission({ module: 'iam.users', action: 'view' });
  const { Permission } = await import('../../src/models/Permission.js');
  await Permission.findByIdAndUpdate(perm._id, { $set: { isSystem: true } });
  await assert.rejects(
    permissionService.deletePermission({ key: 'iam.users.view' }),
    (e) => e.statusCode === 409,
  );
  await Permission.findByIdAndUpdate(perm._id, { $set: { isSystem: false } });
  await permissionService.deletePermission({ key: 'iam.users.view' });
  assert.equal(await permissionService.listPermissions({ module: 'iam.users' }).then((r) => r.total), 0);
});

/* ------------------------------- role svc -------------------------------- */

async function seedPermissions() {
  await permissionService.createModule({ key: 'iam', name: 'IAM' });
  await permissionService.createModule({ key: 'iam.users', name: 'IAM Users' });
  await permissionService.bulkCreatePermissions({
    items: [
      { module: 'iam.users', action: 'view' },
      { module: 'iam.users', action: 'create' },
      { module: 'iam.users', action: 'update' },
    ],
  });
}

test('role names are unique per scope but repeatable across tenants', async () => {
  const r1 = await roleService.create({ tenantId: 't1', name: 'analyst', by: 'a1' });
  assert.equal(r1.level, 'tenant');
  await assert.rejects(roleService.create({ tenantId: 't1', name: 'analyst' }), (e) => e.statusCode === 409);
  const r2 = await roleService.create({ tenantId: 't2', name: 'analyst' });
  assert.ok(r2._id);
  const platform = await roleService.create({ tenantId: null, name: 'support_admin' });
  assert.equal(platform.level, 'platform');
  assert.equal(platform.tenantId, null);
});

test('system roles are immutable and in-use roles cannot be deleted', async () => {
  await seedPermissions();
  const role = await roleService.create({ tenantId: 't1', name: 'analyst' });
  await roleService.addPermission({ roleId: role._id, permissionKey: 'iam.users.view' });
  await Role.findByIdAndUpdate(role._id, { $set: { isSystem: true } });
  await assert.rejects(roleService.update({ id: role._id, patch: { name: 'x' } }), (e) => e.statusCode === 409);
  await assert.rejects(roleService.remove({ id: role._id }), (e) => e.statusCode === 409);
  await Role.findByIdAndUpdate(role._id, { $set: { isSystem: false } });

  const used = await roleService.create({ tenantId: 't1', name: 'used_role' });
  await new UserRole({ tenantId: 't1', userId: 'u1', roleId: used._id, grantedBy: 'a1' }).save();
  await assert.rejects(roleService.remove({ id: used._id }), (e) => e.statusCode === 409);

  const unused = await roleService.create({ tenantId: 't1', name: 'unused_role' });
  await roleService.remove({ id: unused._id });
  await assert.rejects(roleService.getById({ id: unused._id }), (e) => e.statusCode === 404);
});

test('addPermission/removePermission are idempotent and drive resolution', async () => {
  await seedPermissions();
  const role = await roleService.create({ tenantId: 't1', name: 'analyst' });
  await roleService.addPermission({ roleId: role._id, permissionKey: 'iam.users.view' });
  await roleService.addPermission({ roleId: role._id, permissionKey: 'iam.users.view' });

  await new UserRole({ tenantId: 't1', userId: 'u1', roleId: role._id, grantedBy: 'a1' }).save();
  await rbacCache.clearAll();

  assert.deepEqual(
    await permissionService.resolveActorPermissions({ actorType: 'user', actorId: 'u1', tenantId: 't1' }),
    ['iam.users.view'],
  );
  // No cross-tenant leakage.
  assert.deepEqual(
    await permissionService.resolveActorPermissions({ actorType: 'user', actorId: 'u1', tenantId: 't2' }),
    [],
  );

  await roleService.removePermission({ roleId: role._id, permissionKey: 'iam.users.view' });
  assert.deepEqual(
    await permissionService.resolveActorPermissions({ actorType: 'user', actorId: 'u1', tenantId: 't1' }),
    [],
  );
  // Re-add: cache must refresh after the mutation (version bump), not go stale.
  await roleService.addPermission({ roleId: role._id, permissionKey: 'iam.users.create' });
  assert.deepEqual(
    await permissionService.resolveActorPermissions({ actorType: 'user', actorId: 'u1', tenantId: 't1' }),
    ['iam.users.create'],
  );
});

test('user actor resolution requires a tenant', async () => {
  await assert.rejects(
    permissionService.resolveActorPermissions({ actorType: 'user', actorId: 'u1', tenantId: null }),
    (e) => e.statusCode === 400,
  );
});

/* ------------------------------ admin svc -------------------------------- */

test('admin create hashes the password, strips secrets, rejects dupes', async () => {
  const admin = await adminService.create({
    email: 'ops@example.com',
    password: 'password123',
    adminType: 'support',
    tenantScope: 't1',
    name: 'Ops',
    by: 'root',
  });
  assert.equal(admin.status, 'active');
  assert.equal(admin.passwordHash, undefined);
  assert.equal(admin.mfaSecret, undefined);
  await assert.rejects(
    adminService.create({ email: 'ops@example.com', password: 'password123' }),
    (e) => e.statusCode === 409,
  );
  await assert.rejects(adminService.create({ email: 'a@example.com', password: 'short' }), (e) => e.statusCode === 400);
});

test('assignRole/revokeRole reflect in admin permission resolution', async () => {
  await seedPermissions();
  const admin = await adminService.create({ email: 'ops@example.com', password: 'password123' });
  const platformRole = await roleService.create({ tenantId: null, name: 'support_admin' });
  await roleService.addPermission({ roleId: platformRole._id, permissionKey: 'iam.users.update' });

  await adminService.assignRole({ adminId: admin._id, roleId: platformRole._id, by: 'root' });
  assert.deepEqual(
    await permissionService.resolveActorPermissions({ actorType: 'admin', actorId: admin._id, tenantId: null }),
    ['iam.users.update'],
  );
  // Platform grants must not leak into a tenant scope.
  assert.deepEqual(
    await permissionService.resolveActorPermissions({ actorType: 'admin', actorId: admin._id, tenantId: 't1' }),
    [],
  );

  await adminService.revokeRole({ adminId: admin._id, roleId: platformRole._id });
  assert.deepEqual(
    await permissionService.resolveActorPermissions({ actorType: 'admin', actorId: admin._id, tenantId: null }),
    [],
  );
});

test('suspend/restore flips status and future-dated grants are validated', async () => {
  const admin = await adminService.create({ email: 'ops@example.com', password: 'password123' });
  const platformRole = await roleService.create({ tenantId: null, name: 'support_admin' });

  await assert.rejects(
    adminService.assignRole({ adminId: admin._id, roleId: platformRole._id, expiresAt: 'yesterday' }),
    (e) => e.statusCode === 400,
  );

  await adminService.suspend({ id: admin._id, by: 'root' });
  assert.equal((await adminService.getById({ id: admin._id })).status, 'suspended');
  await adminService.restore({ id: admin._id, by: 'root' });
  assert.equal((await adminService.getById({ id: admin._id })).status, 'active');
  await assert.rejects(
    adminService.suspend({ id: '000000000000000000000000' }),
    (e) => e.statusCode === 404,
  );
});

/* ----------------------------- audit svc -------------------------------- */

test('emit redacts sensitive payloads before persisting', async () => {
  const event = await auditLogService.emit({
    actor: { type: 'admin', id: 'root', display: 'root' },
    action: 'create',
    module: 'iam.roles',
    resource: { type: 'role', id: 'r1' },
    before: null,
    after: {
      name: 'analyst',
      password: 'hunter2',
      refreshToken: 'abc123',
      nested: { mfaSecret: 'TOTP' },
    },
    tenantId: 't1',
    ip: '127.0.0.1',
  });
  assert.equal(event.after.password, '[REDACTED]');
  assert.equal(event.after.refreshToken, '[REDACTED]');
  assert.equal(event.after.nested.mfaSecret, '[REDACTED]');
  assert.equal(event.after.name, 'analyst');
});

test('audit list/getById/listByModule and export stubs behave', async () => {
  await auditLogService.emit({ actor: { type: 'service', id: 'svc' }, action: 'create', module: 'iam.tenants', tenantId: 't1' });
  await auditLogService.emit({ actor: { type: 'service', id: 'svc' }, action: 'suspend', module: 'iam.tenants', tenantId: 't2' });

  const all = await auditLogService.list({ tenantId: 't1' });
  assert.equal(all.total, 1);
  const byModule = await auditLogService.listByModule({ module: 'iam.tenants' });
  assert.equal(byModule.total, 2);
  const one = await auditLogService.getById({ id: all.docs[0]._id });
  assert.equal(one.action, 'create');
  await assert.rejects(auditLogService.getById({ id: '000000000000000000000000' }), (e) => e.statusCode === 404);

  const exp = await auditLogService.requestExport({ filters: { tenantId: 't1' }, requestedBy: 'root' });
  assert.ok(exp.exportId.startsWith('exp_'));
  assert.equal(exp.status, 'queued');
  const status = await auditLogService.getExportStatus({ exportId: exp.exportId });
  assert.equal(status.status, 'queued');
});

test('emit validates actor type and module/action shape', async () => {
  await assert.rejects(
    auditLogService.emit({ actor: { type: 'alien' }, action: 'x', module: 'm' }),
    (e) => e.statusCode === 400,
  );
  await assert.rejects(
    auditLogService.emit({ actor: { type: 'admin' }, action: '', module: 'm' }),
    (e) => e.statusCode === 400,
  );
});
