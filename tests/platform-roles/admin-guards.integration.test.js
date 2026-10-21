/**
 * Platform admin guardrails (roadmap 2.1; audit doc 05 section 4; tst.11).
 *
 *   - concurrent suspensions / demotions can never remove the last active
 *     super admin (compare-and-set + re-count + compensation);
 *   - the last live super-admin role grant cannot be revoked;
 *   - platform admins cannot manage super admins;
 *   - adminType is a ceiling for built-in roles, and demotion strips roles
 *     above the new type; legacy bootstrap roles can no longer be granted;
 *   - built-in roles are code-managed (not editable over HTTP, names
 *     reserved) and `db:permissions` converges them.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import adminService from '../../src/services/admin.service.js';
import roleService from '../../src/services/role.service.js';
import adminBootstrapService from '../../src/services/adminBootstrap.service.js';
import adminRepository from '../../src/repositories/admin.repository.js';
import roleRepository from '../../src/repositories/role.repository.js';
import permissionRepository from '../../src/repositories/permission.repository.js';
import { Admin } from '../../src/models/Admin.js';
import { Role } from '../../src/models/Role.js';
import { AdminRole } from '../../src/models/AdminRole.js';
import { PLATFORM_ROLES } from '../../src/constants/platformRoles.js';
import { seedPlatformRoles, builtInRole, createAdmin, loginAdmin, adminSession, stepUpSession } from './helpers.js';

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => { await resetMongo(); await rbacCache.clearAll(); await seedPlatformRoles(); });
after(async () => { await stopHttp(); await stopMongo(); });

const activeSupers = () => Admin.countDocuments({ adminType: 'super', status: 'active' });

function isLastSuper(result) {
  return result.status === 'rejected' && result.reason?.statusCode === 409;
}

test('concurrent mutual suspensions never remove the last active super admin (service level)', async () => {
  for (let round = 0; round < 5; round += 1) {
    await Admin.updateMany({}, { $set: { status: 'suspended' } });
    const a = await createAdmin({ adminType: 'super', roleName: 'super_admin' });
    const b = await createAdmin({ adminType: 'super', roleName: 'super_admin' });
    const results = await Promise.allSettled([
      adminService.suspend({ id: String(a._id), by: String(b._id) }),
      adminService.suspend({ id: String(b._id), by: String(a._id) }),
    ]);
    assert.ok(await activeSupers() >= 1, `round ${round}: an active super admin must remain`);
    assert.ok(results.some(isLastSuper), `round ${round}: at least one suspension is refused`);
    for (const r of results) {
      if (r.status === 'rejected') assert.equal(r.reason.code === 'LAST_SUPER_ADMIN' || r.reason.code === 'CONFLICT', true);
    }
  }
});

test('the post-write re-count catches a stale pre-check (forced race window)', async (t) => {
  const a = await createAdmin({ adminType: 'super', roleName: 'super_admin' });
  const b = await createAdmin({ adminType: 'super', roleName: 'super_admin' });
  // Simulate two requests whose pre-checks both ran before either wrote:
  // every pre-check count reads a stale "2".
  const real = adminRepository.countActiveSupers;
  let call = 0;
  t.mock.method(adminRepository, 'countActiveSupers', async () => {
    call += 1;
    // Calls 1 (pre-check A) and 3 (pre-check B) are stale; 2 and 4 are the
    // post-write re-counts and read the database.
    return call % 2 === 1 ? 2 : real();
  });
  await adminService.suspend({ id: String(a._id), by: String(b._id) });
  // System caller (no actor checks), so only the guard can refuse it.
  await assert.rejects(
    () => adminService.suspend({ id: String(b._id), by: null }),
    (err) => err.statusCode === 409 && err.code === 'LAST_SUPER_ADMIN',
  );
  t.mock.restoreAll();
  const bAfter = await adminRepository.findById(String(b._id));
  assert.equal(bAfter.status, 'active', 'the compensating write restored the last super admin');
  assert.equal(bAfter.adminType, 'super');
  assert.equal(await activeSupers(), 1);
});

test('concurrent HTTP suspensions and demotions keep one active super admin', async () => {
  for (const mode of ['suspend', 'demote']) {
    await Admin.updateMany({}, { $set: { status: 'suspended' } });
    const a = await adminSession({ adminType: 'super', roleName: 'super_admin' });
    const b = await adminSession({ adminType: 'super', roleName: 'super_admin' });
    const request = (actor, target) => (mode === 'suspend'
      ? api(`/api/v1/admin/admins/${target._id}/suspend`, { method: 'POST', headers: actor.auth, body: { reason: 'race' } })
      : api(`/api/v1/admin/admins/${target._id}`, { method: 'PATCH', headers: actor.auth, body: { adminType: 'platform' } }));
    const responses = await Promise.all([request(a, b.admin), request(b, a.admin)]);
    assert.ok(await activeSupers() >= 1, `${mode}: an active super admin must remain`);
    // Depending on interleaving the loser gets 409 (guard), or 401/403
    // because the winner already suspended / demoted it; never two 200s.
    assert.ok(responses.filter((r) => r.status === 200).length <= 1, `${mode}: at most one request succeeds`);
    for (const r of responses) assert.ok([200, 401, 403, 409].includes(r.status), `${mode}: unexpected ${r.status}`);
  }
});

test('the last live super_admin role grant cannot be revoked', async () => {
  const a = await adminSession({ adminType: 'super', roleName: 'super_admin' });
  const b = await createAdmin({ adminType: 'super', roleName: 'super_admin' });
  const superRole = await builtInRole('super_admin');

  // Two holders: revoking one is fine.
  const ok = await api(`/api/v1/admin/admins/${b._id}/roles/${superRole._id}`, { method: 'DELETE', headers: a.auth });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.data.removed, 1);

  // Only `a` holds it now: even a system caller cannot strip it.
  const viaService = adminService.revokeRole({ adminId: String(a.admin._id), roleId: String(superRole._id), by: null });
  await assert.rejects(() => viaService, (err) => err.statusCode === 409 && err.code === 'LAST_SUPER_ADMIN');
  assert.equal(await AdminRole.countDocuments({ adminId: String(a.admin._id), roleId: String(superRole._id) }), 1);
});

test('a refused super-role revoke restores the grant exactly (a temporary grant stays temporary)', async (t) => {
  const a = await createAdmin({ adminType: 'super' });
  const superRole = await builtInRole('super_admin');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await adminService.assignRole({ adminId: String(a._id), roleId: String(superRole._id), expiresAt, by: null });
  const before = await AdminRole.findOne({ adminId: String(a._id), roleId: String(superRole._id) }).lean();

  // Force the race window: the pre-check reads a stale "2 holders", so only
  // the post-write re-count and its compensation can refuse the revoke.
  const real = adminRepository.countActiveSupersHoldingRoles;
  let call = 0;
  t.mock.method(adminRepository, 'countActiveSupersHoldingRoles', async (ids) => {
    call += 1;
    return call === 1 ? 2 : real(ids);
  });
  await assert.rejects(
    () => adminService.revokeRole({ adminId: String(a._id), roleId: String(superRole._id), by: null }),
    (err) => err.statusCode === 409 && err.code === 'LAST_SUPER_ADMIN',
  );
  t.mock.restoreAll();

  const restored = await AdminRole.findOne({ adminId: String(a._id), roleId: String(superRole._id) }).lean();
  assert.ok(restored, 'the grant was put back');
  assert.equal(restored.tenantId, null);
  assert.equal(restored.expiresAt?.getTime(), expiresAt.getTime(), 'the expiry is preserved, not made permanent');
  assert.equal(restored.grantedBy, before.grantedBy);
});

test('platform admins cannot manage super admins, even with the admin-management keys', async () => {
  const sup = await createAdmin({ adminType: 'super', roleName: 'super_admin' });
  const custom = await roleService.create({ tenantId: null, name: 'admin_manager' });
  for (const key of ['iam.admins.view', 'iam.admins.update', 'iam.admins.suspend', 'iam.admins.restore']) {
    await roleService.addPermission({ roleId: String(custom._id), permissionKey: key, by: null });
  }
  const manager = await createAdmin({ adminType: 'platform' });
  await adminService.assignRole({ adminId: String(manager._id), roleId: String(custom._id), by: null });
  const auth = await loginAdmin(manager);
  const peer = await createAdmin({ adminType: 'platform' });

  const suspendSuper = await api(`/api/v1/admin/admins/${sup._id}/suspend`, { method: 'POST', headers: auth, body: { reason: 'x' } });
  assert.equal(suspendSuper.status, 403);
  const renameSuper = await api(`/api/v1/admin/admins/${sup._id}`, { method: 'PATCH', headers: auth, body: { name: 'Renamed' } });
  assert.equal(renameSuper.status, 403);
  assert.equal((await adminRepository.findById(String(sup._id))).status, 'active');

  const suspendPeer = await api(`/api/v1/admin/admins/${peer._id}/suspend`, { method: 'POST', headers: auth, body: { reason: 'x' } });
  assert.equal(suspendPeer.status, 200, 'managing a non-super admin still works');
});

test('adminType is a ceiling for built-in roles; demotion strips roles above the new type', async () => {
  const root = await adminSession({ adminType: 'super', roleName: 'super_admin' });
  // adminauth: granting the super role needs a fresh step-up first.
  await stepUpSession(root.auth);
  const platform = await createAdmin({ adminType: 'platform' });
  const auditorType = await createAdmin({ adminType: 'auditor' });
  const grant = (target, roleName) => builtInRole(roleName).then((role) => api(`/api/v1/admin/admins/${target._id}/roles`, {
    method: 'POST', headers: root.auth, body: { roleId: String(role._id) },
  }));

  const tooHigh = await grant(platform, 'super_admin');
  assert.equal(tooHigh.status, 409);
  assert.equal(tooHigh.json.code, 'ROLE_ABOVE_ADMIN_TYPE');
  assert.equal((await grant(auditorType, 'platform_admin')).status, 409);
  assert.equal((await grant(auditorType, 'support_operator')).status, 409);
  assert.equal((await grant(auditorType, 'auditor')).status, 200);
  assert.equal((await grant(platform, 'platform_admin')).status, 200);
  assert.equal((await grant(platform, 'auditor')).status, 200, 'roles below the type are allowed');

  // Demoting a super to platform revokes super_admin (and keeps lower roles).
  const other = await createAdmin({ adminType: 'super', roleName: 'super_admin' });
  await adminService.assignRole({ adminId: String(other._id), roleId: String((await builtInRole('auditor'))._id), by: null });
  const demote = await api(`/api/v1/admin/admins/${other._id}`, { method: 'PATCH', headers: root.auth, body: { adminType: 'platform' } });
  assert.equal(demote.status, 200, JSON.stringify(demote.json));
  const me = await api('/api/v1/admin-auth/me', { headers: await loginAdmin(other) });
  assert.deepEqual(me.json.data.roles, ['auditor']);
  assert.ok(!me.json.data.permissions.includes('iam.admins.assign'));
});

test('legacy all-permission bootstrap roles can no longer be granted', async () => {
  const legacy = await Role.create({ tenantId: null, name: 'super', level: 'platform', isSystem: true, description: 'legacy' });
  const admin = await createAdmin({ adminType: 'super' });
  await assert.rejects(
    () => adminService.assignRole({ adminId: String(admin._id), roleId: String(legacy._id), by: null }),
    (err) => err.statusCode === 409,
  );
});

test('built-in roles are code-managed: not editable over HTTP and their names are reserved', async () => {
  const root = await adminSession({ adminType: 'super', roleName: 'super_admin' });
  const auditor = await builtInRole('auditor');
  const add = await api(`/api/v1/roles/${auditor._id}/permissions`, {
    method: 'POST', headers: root.auth, body: { permissionKey: 'iam.tenants.update' },
  });
  assert.equal(add.status, 409);
  const remove = await api(`/api/v1/roles/${auditor._id}/permissions`, {
    method: 'DELETE', headers: root.auth, body: { permissionKey: 'audit_logs.view' },
  });
  assert.equal(remove.status, 409);
  assert.equal((await api(`/api/v1/roles/${auditor._id}`, { method: 'DELETE', headers: root.auth })).status, 409);
  for (const name of ['auditor', 'super_admin', 'platform']) {
    const created = await api('/api/v1/roles', { method: 'POST', headers: root.auth, body: { name } });
    assert.equal(created.status, 409, `${name} is reserved`);
  }

  const list = await api('/api/v1/roles?limit=50', { headers: root.auth });
  assert.equal(list.status, 200);
  const builtIns = list.json.data.filter((r) => r.builtIn);
  assert.deepEqual(builtIns.map((r) => r.name).sort(), ['auditor', 'platform_admin', 'super_admin', 'support_operator']);
  const auditorRow = builtIns.find((r) => r.name === 'auditor');
  assert.equal(auditorRow.label, 'Auditor');
  assert.equal(auditorRow.adminType, 'auditor');
  assert.equal(auditorRow.permissionCount, PLATFORM_ROLES.find((r) => r.name === 'auditor').permissions.length);
});

test('db:permissions converges built-in roles to their definitions (dry run reports, apply fixes)', async () => {
  const auditor = await builtInRole('auditor');
  const extra = await permissionRepository.findPermissionByKey('iam.tenants.update');
  await roleRepository.attachPermission(auditor._id, extra._id, 'tamper');
  const keys = async () => (await roleRepository.listPermissionsForRole(String(auditor._id))).map((p) => p.key).sort();
  assert.ok((await keys()).includes('iam.tenants.update'));

  const dry = await adminBootstrapService.syncPlatformCatalogue({ dryRun: true });
  assert.equal(dry.builtIn.find((r) => r.name === 'auditor').detached, 1);
  assert.ok((await keys()).includes('iam.tenants.update'), 'dry run writes nothing');

  const applied = await adminBootstrapService.syncPlatformCatalogue({ by: 'test' });
  assert.equal(applied.builtIn.find((r) => r.name === 'auditor').detached, 1);
  assert.deepEqual(await keys(), [...PLATFORM_ROLES.find((r) => r.name === 'auditor').permissions].sort());
  const again = await adminBootstrapService.syncPlatformCatalogue({ by: 'test' });
  assert.ok(again.builtIn.every((r) => r.attached === 0 && r.detached === 0 && !r.created), 'idempotent');
});

test('bootstrap grants the built-in role matching each admin type', async () => {
  for (const [adminType, roleName] of [['super', 'super_admin'], ['platform', 'platform_admin'], ['support', 'support_operator'], ['auditor', 'auditor']]) {
    const result = await adminBootstrapService.bootstrapAdmin({ email: `${adminType}@boot.test`, password: 'BootstrapPassword1!', adminType });
    assert.equal(result.created, true);
    assert.equal(result.role.name, roleName);
    const roles = await adminRepository.listRolesForAdmin(String(result.admin._id));
    assert.deepEqual(roles.map((r) => r.role.name), [roleName]);
  }
});
