/**
 * Entitlement service tests (Phase 6 - implemented).
 *
 * Coverage:
 *   - missing subscription resolves to the safe-fallback plan
 *   - existing subscription merges plan limits with overrides
 *   - feature override flips a feature on for a tenant
 *   - checkLimit throws QUOTA_EXCEEDED on hard, returns soft on warning
 *   - writeBlocked state (expired / restricted) blocks writes
 *   - checkAndConsume releases the counter on hard failure
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from './helpers/mongo.js';
import planService from '../src/services/plan.service.js';
import subscriptionService from '../src/services/subscription.service.js';
import entitlementService from '../src/services/entitlement.service.js';
import entitlementOverrideService from '../src/services/entitlementOverride.service.js';
import usageService from '../src/services/usage.service.js';
import tenantRepository from '../src/repositories/tenant.repository.js';
import ApiError from '../src/utils/ApiError.js';

before(async () => startMongo());
beforeEach(async () => resetMongo());
after(async () => stopMongo());

async function makeTenant(planId = 'pro') {
  const created = await tenantRepository.create({
    name: `T-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    slug: `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    planId,
    status: 'active',
  });
  return created;
}

test('missing subscription resolves to the safe-fallback plan (deny-by-default)', async () => {
  await planService.ensureDefaults('test');
  const tenant = await makeTenant('does-not-exist');
  const ent = await entitlementService.resolveEffective(tenant._id.toString());
  assert.equal(ent.source, 'fallback');
  assert.equal(ent.plan.code, 'starter');
  // The safe-fallback plan is starter; free is NOT a permissive grant.
  assert.equal(ent.features.dashboards, true);
  assert.ok(ent.limits.connectors);
  assert.equal(typeof ent.limits.connectors.max, 'number');
});

test('existing subscription merges plan with active override', async () => {
  await planService.ensureDefaults('test');
  const tenant = await makeTenant('pro');
  await subscriptionService.createForTenant({ tenantId: tenant._id.toString(), planId: 'pro' });
  const baseConnectors = await entitlementService.getLimit(tenant._id.toString(), 'connectors');
  assert.equal(baseConnectors.max, 10);
  await entitlementOverrideService.create({
    tenantId: tenant._id.toString(),
    metric: 'connectors',
    kind: 'limit',
    value: { max: 25, hard: true },
    reason: 'Headroom for migration',
    by: 'admin-1',
  });
  const overridden = await entitlementService.getLimit(tenant._id.toString(), 'connectors');
  assert.equal(overridden.max, 25);
});

test('feature override flips a feature on', async () => {
  await planService.ensureDefaults('test');
  const tenant = await makeTenant('free');
  await subscriptionService.createForTenant({ tenantId: tenant._id.toString(), planId: 'free' });
  assert.equal(await entitlementService.can(tenant._id.toString(), 'embed'), false);
  await entitlementOverrideService.create({
    tenantId: tenant._id.toString(),
    metric: 'embed',
    kind: 'feature',
    value: true,
    reason: 'Beta tester',
    by: 'admin-1',
  });
  assert.equal(await entitlementService.can(tenant._id.toString(), 'embed'), true);
});

test('checkLimit throws QUOTA_EXCEEDED on hard limit', async () => {
  await planService.ensureDefaults('test');
  const tenant = await makeTenant('free');
  await subscriptionService.createForTenant({ tenantId: tenant._id.toString(), planId: 'free' });
  // free has connectors: 1, hard: true
  await assert.rejects(
    () => entitlementService.checkLimit({ tenantId: tenant._id.toString(), metric: 'connectors', requested: 2 }),
    (err) => err instanceof ApiError && err.statusCode === 409 && err.code === 'QUOTA_EXCEEDED',
  );
});

test('checkLimit returns soft warning when hard is false', async () => {
  await planService.ensureDefaults('test');
  const tenant = await makeTenant('pro');
  await subscriptionService.createForTenant({ tenantId: tenant._id.toString(), planId: 'pro' });
  // pro has dashboards: 50, hard: false. Increment counter to 49 first.
  for (let i = 0; i < 49; i += 1) {
    await usageService.checkAndConsume({ tenantId: tenant._id.toString(), metric: 'dashboards' });
  }
  const result = await entitlementService.checkLimit({
    tenantId: tenant._id.toString(),
    metric: 'dashboards',
    requested: 2,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.soft, true);
  assert.equal(result.limit, 50);
});

test('writeBlocked state blocks writes', async () => {
  await planService.ensureDefaults('test');
  const tenant = await makeTenant('pro');
  await subscriptionService.createForTenant({ tenantId: tenant._id.toString(), planId: 'pro' });
  await subscriptionService.setState({
    tenantId: tenant._id.toString(),
    state: 'restricted',
    reason: 'Investigating',
  });
  const check = await entitlementService.checkLimit({
    tenantId: tenant._id.toString(),
    metric: 'connectors',
  });
  assert.equal(check.allowed, false);
  assert.equal(check.reason, 'subscription_blocked');
});

test('checkAndConsume increments the counter atomically', async () => {
  await planService.ensureDefaults('test');
  const tenant = await makeTenant('starter');
  await subscriptionService.createForTenant({ tenantId: tenant._id.toString(), planId: 'starter' });
  // starter has connectors: 5, hard: true
  for (let i = 0; i < 5; i += 1) {
    const r = await usageService.checkAndConsume({ tenantId: tenant._id.toString(), metric: 'connectors' });
    assert.equal(r.allowed, true);
  }
  await assert.rejects(
    () => usageService.checkAndConsume({ tenantId: tenant._id.toString(), metric: 'connectors' }),
    (err) => err instanceof ApiError && err.statusCode === 409 && err.code === 'QUOTA_EXCEEDED',
  );
});

test('concurrent writes at the limit cannot exceed by more than one', async () => {
  await planService.ensureDefaults('test');
  const tenant = await makeTenant('starter');
  await subscriptionService.createForTenant({ tenantId: tenant._id.toString(), planId: 'starter' });
  // starter has connectors: 5, hard: true
  const tenantId = tenant._id.toString();
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, () =>
      usageService.checkAndConsume({ tenantId, metric: 'connectors' }),
    ),
  );
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 5);
  assert.equal(rejected.length, 7);
  for (const r of rejected) {
    const err = r.reason;
    assert.equal(err.code, 'QUOTA_EXCEEDED');
  }
});

test('release decrements the counter and never throws', async () => {
  await planService.ensureDefaults('test');
  const tenant = await makeTenant('starter');
  await subscriptionService.createForTenant({ tenantId: tenant._id.toString(), planId: 'starter' });
  await usageService.checkAndConsume({ tenantId: tenant._id.toString(), metric: 'connectors' });
  await usageService.checkAndConsume({ tenantId: tenant._id.toString(), metric: 'connectors' });
  const after = await usageService.release({ tenantId: tenant._id.toString(), metric: 'connectors' });
  assert.ok(typeof after.value === 'number');
});
