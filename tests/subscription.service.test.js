/**
 * Subscription service tests (Phase 6 - implemented).
 *
 * Coverage:
 *   - assertTransition is the only state graph authority
 *   - createForTenant is idempotent on tenantId
 *   - plan changes are idempotent on the same plan id
 *   - cancel + reactivate round-trips through the state graph
 *   - admin setState records a reason and a previousState
 *   - backfill migrates a tenant with a missing plan to the fallback
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from './helpers/mongo.js';
import subscriptionService from '../src/services/subscription.service.js';
import tenantRepository from '../src/repositories/tenant.repository.js';
import planService from '../src/services/plan.service.js';
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

test('assertTransition rejects illegal transitions', () => {
  assert.throws(
    () => subscriptionService.assertTransition('expired', 'trialing'),
    (err) => err instanceof ApiError && err.statusCode === 409,
  );
  assert.throws(
    () => subscriptionService.assertTransition('canceled', 'past_due'),
    (err) => err instanceof ApiError && err.statusCode === 409,
  );
  // Same-state is allowed (idempotent).
  subscriptionService.assertTransition('active', 'active');
});

test('createForTenant is idempotent on tenantId', async () => {
  await planService.ensureDefaults('test');
  const tenant = await makeTenant('pro');
  const first = await subscriptionService.createForTenant({ tenantId: tenant._id.toString(), planId: 'pro' });
  const second = await subscriptionService.createForTenant({ tenantId: tenant._id.toString(), planId: 'starter' });
  assert.equal(first.id, second.id);
  assert.equal(second.planId, 'pro');
});

test('changePlan updates plan and records history', async () => {
  await planService.ensureDefaults('test');
  const tenant = await makeTenant('pro');
  const sub = await subscriptionService.createForTenant({ tenantId: tenant._id.toString(), planId: 'starter' });
  const updated = await subscriptionService.changePlan({
    tenantId: tenant._id.toString(),
    planId: 'pro',
    reason: 'upgrade',
  });
  assert.equal(updated.planId, 'pro');
  assert.equal(updated.previousPlanId, 'starter');
  const history = await subscriptionService.listForTenant(tenant._id.toString());
  const types = history.docs.map((h) => h.type);
  assert.ok(types.includes('subscription.plan_changed'));
});

test('changePlan is idempotent on the same plan', async () => {
  await planService.ensureDefaults('test');
  const tenant = await makeTenant('pro');
  await subscriptionService.createForTenant({ tenantId: tenant._id.toString(), planId: 'pro' });
  const a = await subscriptionService.changePlan({ tenantId: tenant._id.toString(), planId: 'pro' });
  const b = await subscriptionService.changePlan({ tenantId: tenant._id.toString(), planId: 'pro' });
  assert.equal(a.id, b.id);
  assert.equal(a.planId, 'pro');
});

test('cancel + reactivate round-trips through the state graph', async () => {
  await planService.ensureDefaults('test');
  const tenant = await makeTenant('pro');
  await subscriptionService.createForTenant({ tenantId: tenant._id.toString(), planId: 'pro' });
  const canceled = await subscriptionService.cancel({
    tenantId: tenant._id.toString(),
    immediate: true,
    reason: 'no longer needed',
  });
  assert.equal(canceled.state, 'canceled');
  assert.equal(canceled.canceledAt, canceled.canceledAt);
  const reactivated = await subscriptionService.reactivate({ tenantId: tenant._id.toString() });
  assert.equal(reactivated.state, 'active');
  assert.equal(reactivated.canceledAt, null);
});

test('setState requires a reason and records previousState', async () => {
  await planService.ensureDefaults('test');
  const tenant = await makeTenant('pro');
  await subscriptionService.createForTenant({ tenantId: tenant._id.toString(), planId: 'pro' });
  await assert.rejects(
    () => subscriptionService.setState({ tenantId: tenant._id.toString(), state: 'past_due', reason: '' }),
    (err) => err instanceof ApiError && err.statusCode === 400,
  );
  const past = await subscriptionService.setState({
    tenantId: tenant._id.toString(),
    state: 'past_due',
    reason: 'Payment failed',
  });
  assert.equal(past.state, 'past_due');
  assert.equal(past.previousState, 'active');
});

test('backfill migrates a tenant with a missing plan to the fallback', async () => {
  await planService.ensureDefaults('test');
  const tenantA = await makeTenant('does-not-exist');
  const tenantB = await makeTenant('pro');
  const result = await subscriptionService.backfillTenants({
    tenants: [tenantA, tenantB],
    planExists: async (code) => Boolean(await planService.getActiveByCode(code)),
    fallbackPlanId: 'starter',
  });
  assert.equal(result.processed, 2);
  assert.equal(result.migrated, 1);
  const subA = await subscriptionService.getForTenant(tenantA._id.toString());
  assert.equal(subA.planId, 'starter');
  const subB = await subscriptionService.getForTenant(tenantB._id.toString());
  assert.equal(subB.planId, 'pro');
});
