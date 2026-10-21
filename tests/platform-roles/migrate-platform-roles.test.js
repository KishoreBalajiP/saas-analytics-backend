/**
 * `npm run db:platform-roles` (scripts/ci/migrate-platform-roles.js) logic,
 * run against the in-memory database only (roadmap 2.1, doc 05 step M5).
 *
 * Simulates a pre-2.1 deployment (legacy all-permission bootstrap roles
 * named after the admin type) and checks that the dry run reports without
 * writing, and that apply maps each admin to its built-in role WITHOUT ANY
 * PRIVILEGE GAIN, leaving custom and scoped grants alone.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import roleRepository from '../../src/repositories/role.repository.js';
import adminRepository from '../../src/repositories/admin.repository.js';
import permissionRepository from '../../src/repositories/permission.repository.js';
import { Role } from '../../src/models/Role.js';
import { AdminRole } from '../../src/models/AdminRole.js';
import { PLATFORM_CATALOGUE_KEYS } from '../../src/services/adminBootstrap.service.js';
import { migratePlatformRoles, effectivePermissionsFor } from '../../src/services/platformRoleMigration.service.js';
import { PLATFORM_ROLES } from '../../src/constants/platformRoles.js';
import { seedPlatformRoles, builtInRole, createAdmin } from './helpers.js';

before(async () => { await startMongo(); });
beforeEach(async () => { await resetMongo(); await rbacCache.clearAll(); });
after(async () => { await stopMongo(); });

/** A pre-2.1 bootstrap role: system, platform-level, holding `keys`. */
async function legacyRole(name, keys) {
  const role = (await Role.create({ tenantId: null, name, level: 'platform', isSystem: true, description: `Bootstrap ${name}` })).toObject();
  for (const key of keys) {
    const permission = await permissionRepository.findPermissionByKey(key);
    await roleRepository.attachPermission(role._id, permission._id, 'legacy');
  }
  return role;
}

async function customRole(name, keys) {
  const role = (await Role.create({ tenantId: null, name, level: 'platform', isSystem: false })).toObject();
  for (const key of keys) {
    const permission = await permissionRepository.findPermissionByKey(key);
    await roleRepository.attachPermission(role._id, permission._id, 'custom');
  }
  return role;
}

async function grant(admin, role, tenantId = null) {
  await adminRepository.assignRole(String(admin._id), role._id, { tenantId, by: 'legacy' });
}

/** Seed a realistic pre-2.1 platform: legacy roles + one admin per case. */
async function seedLegacyPlatform() {
  await seedPlatformRoles();
  const full = [...PLATFORM_CATALOGUE_KEYS];
  const legacySuper = await legacyRole('super', full);
  const legacyPlatform = await legacyRole('platform', full);
  // The legacy support role predates the access-request keys.
  const legacySupport = await legacyRole('support', full.filter((k) => !k.startsWith('iam.access_requests.')));
  const reader = await customRole('custom_reader', ['monitoring.view']);
  const narrow = await customRole('custom_support_view', ['support.view']);

  const admins = {
    superLegacy: await createAdmin({ adminType: 'super' }),
    platformLegacy: await createAdmin({ adminType: 'platform' }),
    supportLegacy: await createAdmin({ adminType: 'support', tenantScope: 'tenant-x' }),
    platformNoRole: await createAdmin({ adminType: 'platform' }),
    supportNarrow: await createAdmin({ adminType: 'support' }),
    alreadyMigrated: await createAdmin({ adminType: 'platform', roleName: 'platform_admin' }),
  };
  await grant(admins.superLegacy, legacySuper);
  await grant(admins.platformLegacy, legacyPlatform);
  await grant(admins.supportLegacy, legacySupport);
  await grant(admins.supportLegacy, reader);
  await grant(admins.supportLegacy, reader, 'tenant-x');
  await grant(admins.supportNarrow, narrow);
  return { admins, legacy: { legacySuper, legacyPlatform, legacySupport }, reader };
}

const byEmail = (report, admin) => report.admins.find((a) => a.adminId === String(admin._id));
const roleKeys = (name) => {
  const def = PLATFORM_ROLES.find((r) => r.name === name);
  return def.allCatalogue ? [...PLATFORM_CATALOGUE_KEYS] : [...def.permissions];
};

test('dry run reports every admin before/after and writes nothing', async () => {
  const { admins } = await seedLegacyPlatform();
  const grantsBefore = await AdminRole.find({}).lean();

  const report = await migratePlatformRoles();
  assert.equal(report.dryRun, true);
  assert.equal(report.rolesReady, true);
  assert.deepEqual(report.summary, { total: 6, migrate: 3, unchanged: 1, needsReview: 2, applied: 0 });

  const sup = byEmail(report, admins.superLegacy);
  assert.equal(sup.action, 'migrate');
  assert.equal(sup.targetRole, 'super_admin');
  assert.deepEqual(sup.gained, []);
  assert.deepEqual(sup.removed, [], 'a super admin keeps every permission');

  const plat = byEmail(report, admins.platformLegacy);
  assert.equal(plat.action, 'migrate');
  assert.deepEqual(plat.after, roleKeys('platform_admin').sort());
  assert.ok(plat.removed.includes('iam.admins.assign'));
  assert.ok(plat.removed.includes('iam.tenants.delete'));

  const supp = byEmail(report, admins.supportLegacy);
  assert.equal(supp.action, 'migrate');
  assert.deepEqual(supp.after, [...new Set([...roleKeys('support_operator'), 'monitoring.view'])].sort(), 'custom grants are kept');

  const none = byEmail(report, admins.platformNoRole);
  assert.equal(none.action, 'needs_review');
  assert.deepEqual(none.gained, roleKeys('platform_admin').sort());
  const narrow = byEmail(report, admins.supportNarrow);
  assert.equal(narrow.action, 'needs_review');
  assert.ok(!narrow.gained.includes('support.view'));
  assert.equal(byEmail(report, admins.alreadyMigrated).action, 'unchanged');

  const grantsAfter = await AdminRole.find({}).lean();
  assert.deepEqual(grantsAfter.map((g) => String(g._id)).sort(), grantsBefore.map((g) => String(g._id)).sort());
});

test('apply maps admins to their built-in role without any privilege gain', async () => {
  const { admins, legacy, reader } = await seedLegacyPlatform();
  const before = {};
  for (const [key, admin] of Object.entries(admins)) before[key] = new Set(await effectivePermissionsFor(String(admin._id)));

  const report = await migratePlatformRoles({ dryRun: false });
  assert.equal(report.summary.applied, 3);

  for (const [key, admin] of Object.entries(admins)) {
    const after = await effectivePermissionsFor(String(admin._id));
    const gained = after.filter((k) => !before[key].has(k));
    assert.deepEqual(gained, [], `${key} must not gain privileges`);
  }

  const legacyIds = Object.values(legacy).map((r) => String(r._id));
  assert.equal(await AdminRole.countDocuments({ roleId: { $in: legacyIds }, adminId: { $in: [admins.superLegacy, admins.platformLegacy, admins.supportLegacy].map((a) => String(a._id)) } }), 0);

  const roleNames = async (admin) => (await adminRepository.listRolesForAdmin(String(admin._id)))
    .filter((g) => g.tenantId === null).map((g) => g.role.name).sort();
  assert.deepEqual(await roleNames(admins.superLegacy), ['super_admin']);
  assert.deepEqual(await roleNames(admins.platformLegacy), ['platform_admin']);
  assert.deepEqual(await roleNames(admins.supportLegacy), ['custom_reader', 'support_operator']);
  assert.equal(await AdminRole.countDocuments({ adminId: String(admins.supportLegacy._id), roleId: String(reader._id), tenantId: 'tenant-x' }), 1, 'scoped grants are untouched');
  assert.deepEqual(await roleNames(admins.platformNoRole), [], 'needs_review admins are unchanged');
  assert.deepEqual(await roleNames(admins.supportNarrow), ['custom_support_view']);

  assert.deepEqual(await effectivePermissionsFor(String(admins.superLegacy._id)), [...PLATFORM_CATALOGUE_KEYS].sort());
  assert.deepEqual(await effectivePermissionsFor(String(admins.platformLegacy._id)), roleKeys('platform_admin').sort());

  // Re-running is a no-op.
  const again = await migratePlatformRoles({ dryRun: false });
  assert.equal(again.summary.applied, 0);
  assert.equal(again.summary.migrate, 0);
  assert.equal(again.summary.unchanged, 4);
  assert.equal(again.summary.needsReview, 2);
});

test('apply refuses to run before the built-in roles exist; the dry run warns instead', async () => {
  await seedLegacyPlatform();
  const auditor = await builtInRole('auditor');
  await Role.deleteOne({ _id: auditor._id });

  const dry = await migratePlatformRoles();
  assert.equal(dry.rolesReady, false);
  assert.match(dry.warnings[0], /db:permissions/);
  await assert.rejects(() => migratePlatformRoles({ dryRun: false }), /db:permissions/);
});
