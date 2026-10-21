/**
 * actorStatus (auth.14) shares the tenant-active rule with background work
 * (`jobs/tenantGuard.isTenantActive`, onLookupError 'throw'): only `active`
 * passes, a missing or malformed tenant is not active, and a failed lookup
 * propagates (the request fails) instead of reading as a suspension.
 *
 * Repositories are stubbed, so no database is needed.
 */

import test, { mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import actorStatus from '../../src/modules/iam/auth/actorStatus.service.js';
import userRepository from '../../src/repositories/user.repository.js';
import tenantRepository from '../../src/repositories/tenant.repository.js';

const USER_ID = '64b000000000000000000001';
const TENANT_ID = '64b0000000000000000000aa';

beforeEach(() => {
  actorStatus.clear();
  mock.method(userRepository, 'findById', async () => ({ _id: USER_ID, status: 'active', tenantId: TENANT_ID }));
});
afterEach(() => {
  mock.restoreAll();
  actorStatus.clear();
});

const assertUser = () => actorStatus.assertActorActive({ actorType: 'user', actorId: USER_ID });

test('an active user in an active tenant passes and gets the tenant from the user record', async () => {
  mock.method(tenantRepository, 'findById', async () => ({ _id: TENANT_ID, status: 'active' }));
  assert.deepEqual(await assertUser(), { tenantId: TENANT_ID });
});

test('a suspended or missing tenant is TENANT_NOT_ACTIVE', async () => {
  mock.method(tenantRepository, 'findById', async () => ({ _id: TENANT_ID, status: 'suspended' }));
  await assert.rejects(assertUser(), (err) => err.statusCode === 401 && err.code === 'TENANT_NOT_ACTIVE');

  actorStatus.clear();
  mock.method(tenantRepository, 'findById', async () => null);
  await assert.rejects(assertUser(), (err) => err.code === 'TENANT_NOT_ACTIVE');
});

test('a malformed tenant id is not active; a failed lookup propagates instead', async () => {
  mock.method(tenantRepository, 'findById', async () => {
    const err = new Error('Cast to ObjectId failed');
    err.name = 'CastError';
    throw err;
  });
  await assert.rejects(assertUser(), (err) => err.code === 'TENANT_NOT_ACTIVE');

  actorStatus.clear();
  mock.method(tenantRepository, 'findById', async () => { throw new Error('db down'); });
  await assert.rejects(assertUser(), (err) => err.message === 'db down' && err.code !== 'TENANT_NOT_ACTIVE');
});

const cacheDisabled = actorStatus._meta.cacheTtlMs === 0 && 'AUTH_STATUS_CACHE_TTL_MS=0 disables the status cache';

test('the tenant answer is cached until invalidated', { skip: cacheDisabled }, async () => {
  const lookup = mock.method(tenantRepository, 'findById', async () => ({ _id: TENANT_ID, status: 'active' }));
  await assertUser();
  await assertUser();
  assert.equal(lookup.mock.callCount(), 1);
  actorStatus.invalidate('tenant', TENANT_ID);
  await assertUser();
  assert.equal(lookup.mock.callCount(), 2);
});
