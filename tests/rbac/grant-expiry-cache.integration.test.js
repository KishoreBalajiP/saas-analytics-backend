/**
 * Expiry-aware RBAC caching (roadmap 1.9, sec.07 / db.04).
 *
 * The resolvers already ignore expired grants (Phase 0). These tests prove
 * the 60-second RBAC cache cannot serve a grant past its `expiresAt`: the
 * cache entry is bounded by the earliest expiry of the grants it was built
 * from, and the expired grant row is still in the database (the Mongo TTL
 * monitor has not removed it), so nothing relies on the TTL index.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import permissionService from '../../src/services/permission.service.js';
import roleService from '../../src/services/role.service.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import { UserRole } from '../../src/models/UserRole.js';
import { AdminRole } from '../../src/models/AdminRole.js';

before(async () => { await startMongo(); });
beforeEach(async () => { await resetMongo(); await rbacCache.clearAll(); });
after(async () => { await stopMongo(); });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function seedRoles(tenantId) {
  await permissionService.createModule({ key: 'iam', name: 'IAM' });
  await permissionService.createModule({ key: 'iam.users', name: 'IAM Users' });
  await permissionService.bulkCreatePermissions({
    items: [
      { module: 'iam.users', action: 'view' },
      { module: 'iam.users', action: 'update' },
    ],
  });
  const permanent = await roleService.create({ tenantId, name: 'viewer_role' });
  await roleService.addPermission({ roleId: permanent._id, permissionKey: 'iam.users.view' });
  const temporary = await roleService.create({ tenantId, name: 'elevated_role' });
  await roleService.addPermission({ roleId: temporary._id, permissionKey: 'iam.users.update' });
  return { permanent, temporary };
}

test('a temporary user grant stops working at its expiry even while the permission set is cached', async () => {
  const { permanent, temporary } = await seedRoles('t1');
  await new UserRole({ tenantId: 't1', userId: 'u1', roleId: permanent._id, grantedBy: 'a1' }).save();
  const expiresAt = new Date(Date.now() + 1500);
  await new UserRole({ tenantId: 't1', userId: 'u1', roleId: temporary._id, grantedBy: 'a1', expiresAt }).save();

  const resolve = () => permissionService.resolveActorPermissions({ actorType: 'user', actorId: 'u1', tenantId: 't1' });
  const roles = () => roleService.resolveActorRoles({ actorType: 'user', actorId: 'u1', tenantId: 't1' });

  assert.deepEqual(await resolve(), ['iam.users.update', 'iam.users.view']);
  assert.deepEqual(await roles(), ['elevated_role', 'viewer_role']);
  // Served from cache (the version counters are unchanged) right up to expiry.
  assert.deepEqual(await resolve(), ['iam.users.update', 'iam.users.view']);

  await sleep(Math.max(0, expiresAt.getTime() - Date.now()) + 50);

  assert.deepEqual(await resolve(), ['iam.users.view'], 'the expired grant no longer counts');
  assert.deepEqual(await roles(), ['viewer_role']);
  const stillThere = await UserRole.findOne({ userId: 'u1', roleId: String(temporary._id) }).lean();
  assert.ok(stillThere, 'the TTL monitor has not removed the row; expiry is enforced by resolution');
});

test('a temporary admin grant stops working at its expiry even while cached', async () => {
  const { temporary } = await seedRoles(null);
  const expiresAt = new Date(Date.now() + 1500);
  await new AdminRole({ adminId: 'adm1', tenantId: null, roleId: temporary._id, grantedBy: 'root', expiresAt }).save();

  const resolve = () => permissionService.resolveActorPermissions({ actorType: 'admin', actorId: 'adm1', tenantId: null });
  assert.deepEqual(await resolve(), ['iam.users.update']);
  assert.deepEqual(await resolve(), ['iam.users.update']);

  await sleep(Math.max(0, expiresAt.getTime() - Date.now()) + 50);
  assert.deepEqual(await resolve(), []);
});

test('grants without an expiry are still cached for the normal TTL', async () => {
  const { permanent } = await seedRoles('t1');
  await new UserRole({ tenantId: 't1', userId: 'u2', roleId: permanent._id, grantedBy: 'a1' }).save();
  const resolve = () => permissionService.resolveActorPermissions({ actorType: 'user', actorId: 'u2', tenantId: 't1' });
  assert.deepEqual(await resolve(), ['iam.users.view']);

  // Remove the grant behind the cache's back (no invalidation): the cached
  // set is still served, proving the cache is in use.
  await UserRole.deleteMany({ userId: 'u2' });
  assert.deepEqual(await resolve(), ['iam.users.view']);
});
