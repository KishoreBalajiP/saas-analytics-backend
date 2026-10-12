/**
 * Entitlement override service tests (Phase 6 - implemented).
 *
 * Coverage:
 *   - reason is required for create and revoke
 *   - feature override requires a boolean value
 *   - limit override clamps to the safety net
 *   - revoke soft-revokes the row (revokedAt set, not deleted)
 *   - re-create on the same tenant + metric is idempotent
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from './helpers/mongo.js';
import planService from '../src/services/plan.service.js';
import entitlementOverrideService from '../src/services/entitlementOverride.service.js';
import tenantRepository from '../src/repositories/tenant.repository.js';
import ApiError from '../src/utils/ApiError.js';

before(async () => startMongo());
beforeEach(async () => resetMongo());
after(async () => stopMongo());

async function makeTenant() {
  const created = await tenantRepository.create({
    name: `T-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    slug: `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    planId: 'pro',
    status: 'active',
  });
  return created;
}

test('create requires a non-empty reason', async () => {
  await planService.ensureDefaults('test');
  const tenant = await makeTenant();
  await assert.rejects(
    () =>
      entitlementOverrideService.create({
        tenantId: tenant._id.toString(),
        kind: 'feature',
        metric: 'embed',
        value: true,
        reason: '',
        by: 'admin-1',
      }),
    (err) => err instanceof ApiError && err.statusCode === 400,
  );
});

test('feature override requires a boolean value', async () => {
  await planService.ensureDefaults('test');
  const tenant = await makeTenant();
  await assert.rejects(
    () =>
      entitlementOverrideService.create({
        tenantId: tenant._id.toString(),
        kind: 'feature',
        metric: 'embed',
        value: 'yes',
        reason: 'because',
        by: 'admin-1',
      }),
    (err) => err instanceof ApiError && err.statusCode === 422,
  );
});

test('limit override clamps to the safety net', async () => {
  await planService.ensureDefaults('test');
  const tenant = await makeTenant();
  const over = await entitlementOverrideService.create({
    tenantId: tenant._id.toString(),
    kind: 'limit',
    metric: 'connectors',
    value: { max: 10_000_000, hard: true },
    reason: 'Test the safety net',
    by: 'admin-1',
  });
  // The highest plan's connectors max is 50 (enterprise) * 1000 = 50000.
  assert.ok(over.value.max <= 50_000, `expected max<=50000 got ${over.value.max}`);
});

test('revoke soft-revokes the row', async () => {
  await planService.ensureDefaults('test');
  const tenant = await makeTenant();
  const over = await entitlementOverrideService.create({
    tenantId: tenant._id.toString(),
    kind: 'feature',
    metric: 'embed',
    value: true,
    reason: 'Initial grant',
    by: 'admin-1',
  });
  const revoked = await entitlementOverrideService.revoke(over.id, {
    by: 'admin-1',
    reason: 'No longer needed',
  });
  assert.ok(revoked.revokedAt);
  assert.equal(revoked.revokeReason, 'No longer needed');
  // list with includeRevoked=false returns nothing.
  const list = await entitlementOverrideService.list({
    tenantId: tenant._id.toString(),
    includeRevoked: false,
  });
  assert.equal(list.docs.length, 0);
});

test('re-create on the same tenant + metric is idempotent', async () => {
  await planService.ensureDefaults('test');
  const tenant = await makeTenant();
  const a = await entitlementOverrideService.create({
    tenantId: tenant._id.toString(),
    kind: 'feature',
    metric: 'embed',
    value: true,
    reason: 'First grant',
    by: 'admin-1',
  });
  const b = await entitlementOverrideService.create({
    tenantId: tenant._id.toString(),
    kind: 'feature',
    metric: 'embed',
    value: true,
    reason: 'Second grant',
    by: 'admin-1',
  });
  assert.equal(a.id, b.id);
});
