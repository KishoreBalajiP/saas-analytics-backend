/**
 * Members package (roadmap 2.10; db.07): unique indexes ignore soft-deleted
 * rows, and the `db:member-indexes` migration rebuilds old definitions.
 *
 * Covers: re-creating a deleted user's email (and inviting it), a deleted
 * role's name, a deleted setting key, a deleted seeded feature flag (then
 * initialising a tenant), a deleted catalogue permission; live duplicates
 * are still refused; the migration plans and applies the rebuild of old
 * non-partial unique indexes and drops the old invitation TTL index.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import * as emailService from '../../src/services/email.service.js';
import tenantService from '../../src/services/tenant.service.js';
import invitationService from '../../src/services/tenantInvitation.service.js';
import * as featureFlagService from '../../src/services/featureFlag.service.js';
import userRepository from '../../src/repositories/user.repository.js';
import roleRepository from '../../src/repositories/role.repository.js';
import * as settingRepository from '../../src/repositories/setting.repository.js';
import * as featureFlagRepository from '../../src/repositories/featureFlag.repository.js';
import permissionRepository from '../../src/repositories/permission.repository.js';
import { migrateMemberIndexes } from '../../src/services/memberIndexMigration.service.js';
import { User } from '../../src/models/User.js';
import { Role } from '../../src/models/Role.js';
import { FeatureFlag } from '../../src/models/FeatureFlag.js';
import { Permission } from '../../src/models/Permission.js';
import { TenantInvitation } from '../../src/models/TenantInvitation.js';
import { createWorkspace } from './helpers.js';

before(async () => { await startMongo(); });
beforeEach(async () => { await resetMongo(); });
after(async () => { await emailService.close(); await stopMongo(); });

test('a removed user\'s email can be used again; a live duplicate is still refused', async () => {
  const ws = await createWorkspace();
  const first = await userRepository.create({ tenantId: ws.tenantId, email: 'again@example.com', status: 'active' });
  await assert.rejects(
    () => userRepository.create({ tenantId: ws.tenantId, email: 'again@example.com', status: 'active' }),
    (err) => err.code === 11000,
  );
  await userRepository.softDelete(String(first._id), 'test');
  const second = await userRepository.create({ tenantId: ws.tenantId, email: 'again@example.com', status: 'invited' });
  assert.notEqual(String(second._id), String(first._id));
  await User.collection.deleteOne({ _id: second._id });

  // The invitation flow works for the address of a removed member.
  const sink = [];
  emailService.captureInto(sink);
  const result = await invitationService.create({
    tenantId: ws.tenantId, email: 'again@example.com', roleName: 'Viewer', invitedBy: 'platform-admin',
  });
  emailService.stopCapture();
  assert.equal(result.invitation.status, 'pending');
  assert.equal(await User.collection.countDocuments({ tenantId: ws.tenantId, email: 'again@example.com' }), 2);
});

test('a deleted role\'s name, setting key and catalogue permission can be re-created', async () => {
  const ws = await createWorkspace();
  const role = await roleRepository.create({ tenantId: ws.tenantId, name: 'Analyst', level: 'tenant' });
  await assert.rejects(() => roleRepository.create({ tenantId: ws.tenantId, name: 'Analyst', level: 'tenant' }), (err) => err.code === 11000);
  await roleRepository.softDelete(String(role._id), 'test');
  const again = await roleRepository.create({ tenantId: ws.tenantId, name: 'Analyst', level: 'tenant' });
  assert.ok(again._id);
  assert.equal(await Role.collection.countDocuments({ tenantId: ws.tenantId, name: 'Analyst' }), 2);

  const { setting } = await settingRepository.upsertByKey({ key: 'members.test', scope: 'tenant', tenantId: ws.tenantId, type: 'string', value: 'a' });
  await settingRepository.softDelete(String(setting._id), 'test');
  const { created } = await settingRepository.upsertByKey({ key: 'members.test', scope: 'tenant', tenantId: ws.tenantId, type: 'string', value: 'b' });
  assert.equal(created, true);

  const permission = await permissionRepository.findPermissionByKey('dashboards.view');
  await Permission.softDeleteById(permission._id, 'test');
  const module = await permissionRepository.findModuleByKey('dashboards');
  await permissionRepository.registerAction({ moduleId: module._id, module: 'dashboards', action: 'view' });
  assert.ok(await permissionRepository.findPermissionByKey('dashboards.view'), 'the key is registered again');
});

test('a soft-deleted seeded feature flag does not break initialising another tenant', async () => {
  await createWorkspace('First');
  const [flag] = await FeatureFlag.find({}).limit(1).lean();
  assert.ok(flag, 'tenant initialisation seeds feature flags');
  await FeatureFlag.softDeleteById(flag._id, 'test');
  const second = await tenantService.create({
    tenant: { name: 'Second Workspace' }, owner: { email: 'second-owner@example.com', password: 'Password123!' }, initialize: true, by: 'platform-admin',
  });
  assert.equal(second.tenant.status, 'active');
  // config: a default flag a platform admin deleted stays deleted; seeding
  // must neither resurrect it nor fail on the soft-deleted row.
  assert.equal(await featureFlagRepository.findByKey(flag.key), null, 'a deleted default flag is not resurrected');
  await featureFlagService.ensureDefaults({ by: 'test' });
  assert.equal(await featureFlagRepository.findByKey(flag.key), null);
});

test('db:member-indexes rebuilds old unique indexes and drops the invitation TTL index', async () => {
  // Recreate the pre-2.10 definitions on fresh collections.
  await User.collection.dropIndex('tenantId_1_email_1');
  await User.collection.createIndex({ tenantId: 1, email: 1 }, { unique: true });
  await Role.collection.dropIndex('tenantId_1_name_1');
  await Role.collection.createIndex({ tenantId: 1, name: 1 }, { unique: true, sparse: true });
  await TenantInvitation.collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  const plan = await migrateMemberIndexes({ dryRun: true });
  const actionOf = (model, key) => plan.find((r) => r.model === model && JSON.stringify(r.key) === JSON.stringify(key))?.action;
  assert.equal(actionOf('User', { tenantId: 1, email: 1 }), 'rebuild');
  assert.equal(actionOf('Role', { tenantId: 1, name: 1 }), 'rebuild');
  assert.equal(actionOf('TenantInvitation', { expiresAt: 1 }), 'drop');
  assert.equal(actionOf('FeatureFlag', { key: 1 }), 'ok');
  assert.ok(plan.every((r) => r.applied === false), 'a dry run changes nothing');
  assert.ok((await TenantInvitation.collection.indexes()).some((i) => i.expireAfterSeconds !== undefined));

  const applied = await migrateMemberIndexes({ dryRun: false });
  assert.ok(applied.every((r) => r.error === null), JSON.stringify(applied.filter((r) => r.error)));
  const userIndex = (await User.collection.indexes()).find((i) => i.name === 'tenantId_1_email_1');
  assert.deepEqual(userIndex.partialFilterExpression, { deletedAt: null });
  assert.equal(userIndex.unique, true);
  assert.ok((await TenantInvitation.collection.indexes()).every((i) => i.expireAfterSeconds === undefined));

  const rerun = await migrateMemberIndexes({ dryRun: true });
  assert.ok(rerun.every((r) => r.action === 'ok'), JSON.stringify(rerun.filter((r) => r.action !== 'ok')));
  // The rebuilt index still enforces uniqueness among live rows.
  const tenantId = new mongoose.Types.ObjectId().toString();
  await User.create({ tenantId, email: 'u@example.com' });
  await assert.rejects(() => User.create({ tenantId, email: 'u@example.com' }), (err) => err.code === 11000);
});
