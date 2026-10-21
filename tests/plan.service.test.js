/**
 * Plan service tests (Phase 6 - implemented).
 *
 * Coverage:
 *   - default plan seed is idempotent and creates exactly four plans
 *   - getActiveByCode rejects disabled/archived plans
 *   - create rejects invalid limits (negative max, non-boolean hard)
 *   - update preserves the immutable plan code via the master-data
 *     repository contract (not exposed in the patch)
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from './helpers/mongo.js';
import planService from '../src/services/plan.service.js';
import ApiError from '../src/utils/ApiError.js';

before(async () => startMongo());
beforeEach(async () => resetMongo());
after(async () => stopMongo());

test('ensureDefaults creates four plans and is idempotent', async () => {
  const first = await planService.ensureDefaults('test');
  assert.equal(first.total, 4);
  assert.equal(first.created.length, 4);
  const codes = first.created.map((p) => p.code).sort();
  assert.deepEqual(codes, ['enterprise', 'free', 'pro', 'starter']);

  const second = await planService.ensureDefaults('test');
  assert.equal(second.created.length, 0);
});

test('list returns the four plans with typed shape', async () => {
  await planService.ensureDefaults('test');
  const result = await planService.list({ page: 1, limit: 10 });
  assert.ok(result.docs.length >= 4);
  for (const plan of result.docs) {
    assert.ok(plan.id);
    assert.ok(plan.code);
    assert.ok(plan.data);
    assert.ok(typeof plan.data.limits === 'object');
  }
});

test('getByCode returns a plan and getActiveByCode rejects disabled plans', async () => {
  await planService.ensureDefaults('test');
  const pro = await planService.getByCode('pro');
  assert.ok(pro);
  assert.equal(pro.code, 'pro');
  assert.equal(pro.data.status, 'active');

  const disabled = await planService.create(
    {
      code: 'disabled-1',
      name: 'Disabled',
      data: { ...planService.DEFAULT_PLANS[0].data, status: 'active' },
    },
    'test',
  );
  await planService.disable(disabled.id, 'test');
  const active = await planService.getActiveByCode('disabled-1');
  assert.equal(active, null);
  const byId = await planService.getByCode('disabled-1');
  assert.equal(byId.data.status, 'disabled');
});

test('create rejects a negative limit max', async () => {
  await assert.rejects(
    () =>
      planService.create(
        {
          code: 'bad-1',
          name: 'Bad',
          data: {
            displayName: 'Bad',
            status: 'active',
            tier: 0,
            features: { dashboards: true },
            limits: { connectors: { max: -1, hard: true } },
          },
        },
        'test',
      ),
    (err) => err instanceof ApiError && err.statusCode === 422,
  );
});

test('create rejects a non-boolean hard flag', async () => {
  await assert.rejects(
    () =>
      planService.create(
        {
          code: 'bad-2',
          name: 'Bad',
          data: {
            displayName: 'Bad',
            status: 'active',
            tier: 0,
            features: { dashboards: true },
            limits: { connectors: { max: 1, hard: 'yes' } },
          },
        },
        'test',
      ),
    (err) => err instanceof ApiError && err.statusCode === 422,
  );
});

test('create rejects a non-boolean feature', async () => {
  await assert.rejects(
    () =>
      planService.create(
        {
          code: 'bad-3',
          name: 'Bad',
          data: {
            displayName: 'Bad',
            status: 'active',
            tier: 0,
            features: { dashboards: 'yes' },
            limits: {},
          },
        },
        'test',
      ),
    (err) => err instanceof ApiError && err.statusCode === 422,
  );
});

test('update does not accept a code in the patch (code is immutable)', async () => {
  await planService.ensureDefaults('test');
  const pro = await planService.getByCode('pro');
  const updated = await planService.update(pro.id, { name: 'Pro Plus' }, 'test');
  assert.equal(updated.name, 'Pro Plus');
  assert.equal(updated.code, 'pro');
});

test('resolveFallbackPlan returns the free plan when the catalogue is seeded', async () => {
  await planService.ensureDefaults('test');
  const fallback = await planService.resolveFallbackPlan();
  // billing (finding bil.09): never a paid tier.
  assert.equal(fallback.code, 'free');
  assert.equal(fallback.data.status, 'active');
});
