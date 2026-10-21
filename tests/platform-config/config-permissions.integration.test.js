/**
 * Permission catalogue for platform configuration (roadmap 2.4): the
 * `settings.secrets.*` keys are registered by the platform catalogue (what
 * `npm run db:permissions` provisions), granted to the `super` bootstrap
 * role only, and workspace roles can evaluate feature flags.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import adminBootstrapService from '../../src/services/adminBootstrap.service.js';
import permissionService from '../../src/services/permission.service.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import tenantInitialization from '../../src/services/tenantInitialization.service.js';
import roleRepository from '../../src/repositories/role.repository.js';
import { Permission } from '../../src/models/Permission.js';
import { RolePermission } from '../../src/models/RolePermission.js';
import { CONFIG_MODULES } from '../../src/models/Module.js';

before(async () => startMongo());
beforeEach(async () => { await resetMongo(); await rbacCache.clearAll(); });
after(async () => stopMongo());

const SECRET_KEYS = ['settings.secrets.view', 'settings.secrets.update'];
const CONFIG_KEYS = [
  'settings.view', 'settings.update',
  'feature_flags.view', 'feature_flags.create', 'feature_flags.update', 'feature_flags.delete',
  'email_templates.view', 'email_templates.update',
];

test('the platform catalogue registers the secret settings permissions (and only view/update)', async () => {
  assert.deepEqual([...CONFIG_MODULES], ['settings.secrets']);
  const { admin } = await adminBootstrapService.bootstrapAdmin({
    email: 'root@example.com', password: 'BootstrapPassword123!', adminType: 'super',
  });
  const registered = await Permission.find({ module: 'settings.secrets' }).lean();
  assert.deepEqual(registered.map((p) => p.key).sort(), [...SECRET_KEYS].sort());

  const keys = await permissionService.resolveActorPermissions({ actorType: 'admin', actorId: String(admin._id) });
  for (const key of [...CONFIG_KEYS, ...SECRET_KEYS]) assert.ok(keys.includes(key), `super holds ${key}`);
});

test('db:permissions sync grants secrets to super but not to the platform role', async () => {
  await adminBootstrapService.bootstrapAdmin({ email: 'root@example.com', password: 'BootstrapPassword123!', adminType: 'super' });
  const platformRole = await roleRepository.create({ tenantId: null, name: 'platform', level: 'platform', isSystem: true });
  const dry = await adminBootstrapService.syncPlatformCatalogue({ dryRun: true });
  // bootstrapAdmin now provisions the built-in super_admin role, so the only
  // legacy role present is the one created here.
  assert.deepEqual(dry.roles.sort(), ['platform']);
  await adminBootstrapService.syncPlatformCatalogue({ dryRun: false });

  const granted = async (roleId) => {
    const joins = await RolePermission.find({ roleId: String(roleId) }).lean();
    const rows = await Permission.find({ _id: { $in: joins.map((j) => j.permissionId) } }).lean();
    return rows.map((row) => row.key);
  };
  const platformKeys = await granted(platformRole._id);
  for (const key of CONFIG_KEYS) assert.ok(platformKeys.includes(key), `platform holds ${key}`);
  for (const key of SECRET_KEYS) assert.ok(!platformKeys.includes(key), `platform does not hold ${key}`);
});

test('every default workspace role can evaluate feature flags', () => {
  for (const name of ['Owner', 'Admin', 'Manager', 'Viewer']) {
    assert.ok(
      tenantInitialization.DEFAULT_ROLES[name].permissions.includes('feature_flags.view'),
      `${name} holds feature_flags.view`,
    );
  }
});
