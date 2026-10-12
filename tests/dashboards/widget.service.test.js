/**
 * Integration tests for `services/dashboard.service.js` widget authoring —
 * tenant + dashboard scoping, dataset ownership, safe query-contract
 * whitelisting, position clamping and the per-dashboard widget limit.
 */

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { useMongo, resetMongo } from '../helpers/index.js';
import * as cacheService from '../../src/services/cache.service.js';
import * as dashboardService from '../../src/services/dashboard.service.js';
import planService from '../../src/services/plan.service.js';
import connectorRepository from '../../src/repositories/connector.repository.js';
import widgetRepository from '../../src/repositories/widget.repository.js';

useMongo();
const { ObjectId } = mongoose.Types;
const TA = 'tenant-a';
const TB = 'tenant-b';

beforeEach(async () => { await resetMongo(); await cacheService.flushAll(); });

async function seed(tenantId = TA) {
  const dashboard = await dashboardService.createDashboard({ tenantId, name: 'Revenue' });
  const connector = await connectorRepository.create({ tenantId, type: 'csv', name: 'Orders', status: 'active', createdBy: 'u1' });
  return { dashboard, connector };
}

const widgetData = (connector, extra = {}) => ({
  name: 'Total',
  type: 'kpi',
  datasetId: String(connector._id),
  ...extra,
});

test('create + get + update + remove a widget round-trips', async () => {
  const { dashboard, connector } = await seed();
  const created = await dashboardService.createWidget({
    tenantId: TA, dashboardId: String(dashboard._id), actorId: 'u1', data: widgetData(connector),
  });
  assert.equal(created.type, 'kpi');
  assert.equal(created.tenantId, TA);

  const got = await dashboardService.getWidget({ tenantId: TA, dashboardId: String(dashboard._id), widgetId: String(created._id) });
  assert.equal(got.name, 'Total');

  const updated = await dashboardService.updateWidget({
    tenantId: TA, dashboardId: String(dashboard._id), widgetId: String(created._id), actorId: 'u2',
    patch: { name: 'Total v2', position: { x: 2, y: 3, w: 6, h: 8 } },
  });
  assert.equal(updated.name, 'Total v2');
  assert.deepEqual(updated.position, { x: 2, y: 3, w: 6, h: 8 });

  await dashboardService.removeWidget({ tenantId: TA, dashboardId: String(dashboard._id), widgetId: String(created._id), actorId: 'u1' });
  await assert.rejects(
    () => dashboardService.getWidget({ tenantId: TA, dashboardId: String(dashboard._id), widgetId: String(created._id) }),
    (e) => e.statusCode === 404,
  );
});

test('widgets are scoped to their dashboard', async () => {
  const { dashboard: d1, connector } = await seed();
  const d2 = await dashboardService.createDashboard({ tenantId: TA, name: 'Other' });
  const w = await dashboardService.createWidget({ tenantId: TA, dashboardId: String(d1._id), data: widgetData(connector) });

  await assert.rejects(
    () => dashboardService.getWidget({ tenantId: TA, dashboardId: String(d2._id), widgetId: String(w._id) }),
    (e) => e.statusCode === 404,
  );
  await assert.rejects(
    () => dashboardService.updateWidget({ tenantId: TA, dashboardId: String(d2._id), widgetId: String(w._id), patch: { name: 'x' } }),
    (e) => e.statusCode === 404,
  );
});

test('create requires a tenant-owned dataset connector', async () => {
  const { dashboard } = await seed();
  await assert.rejects(
    () => dashboardService.createWidget({ tenantId: TA, dashboardId: String(dashboard._id), data: { name: 'x', type: 'kpi', datasetId: new ObjectId().toString() } }),
    (e) => e.statusCode === 400,
  );

  // A connector owned by another tenant is not a valid dataset.
  const { connector: otherConnector } = await seed(TB);
  await assert.rejects(
    () => dashboardService.createWidget({ tenantId: TA, dashboardId: String(dashboard._id), data: widgetData(otherConnector) }),
    (e) => e.statusCode === 400,
  );
});

test('rejects unknown widget types and missing names', async () => {
  const { dashboard, connector } = await seed();
  await assert.rejects(
    () => dashboardService.createWidget({ tenantId: TA, dashboardId: String(dashboard._id), data: { name: 'x', type: 'donut', datasetId: String(connector._id) } }),
    (e) => e.statusCode === 400,
  );
  await assert.rejects(
    () => dashboardService.createWidget({ tenantId: TA, dashboardId: String(dashboard._id), data: { type: 'kpi', datasetId: String(connector._id) } }),
    (e) => e.statusCode === 400,
  );
});

test('query is whitelisted to the safe contract fields', async () => {
  const { dashboard, connector } = await seed();
  const created = await dashboardService.createWidget({
    tenantId: TA, dashboardId: String(dashboard._id),
    data: widgetData(connector, {
      query: {
        metrics: [{ alias: 'total', op: 'count', field: 'amount' }],
        filters: [{ field: 'region', op: 'eq', value: 'EU' }],
        filtersOp: 'and',
        inject: { $where: 'danger' },
        dangerously: true,
      },
    }),
  });
  assert.deepEqual(Object.keys(created.query).sort(), ['filters', 'filtersOp', 'metrics']);
});

test('position is clamped into the supported grid bounds', async () => {
  const { dashboard, connector } = await seed();
  const created = await dashboardService.createWidget({
    tenantId: TA, dashboardId: String(dashboard._id),
    data: widgetData(connector, { position: { x: -4, y: -2, w: 99, h: 0 } }),
  });
  assert.deepEqual(created.position, { x: 0, y: 0, w: 24, h: 1 });
});

test('per-dashboard widget limit is enforced', async () => {
  // Ensure the plan catalogue is seeded so planService.getByCode() can resolve `pro`.
  await planService.ensureDefaults();

  // Ensure tenant `tenant-a` uses the `pro` plan (dashboards: max 50 soft)
  // so that the widget limit test works correctly with the enforced limit.
  // The starter plan has dashboards: { max: 25, hard: true } and hardcoded
  // MAX_WIDGETS_PER_DASHBOARD is 30, so we create 30 widgets and expect
  // the 31st to be rejected by the per-dashboard count guard.
  const { model } = mongoose;
  const tenantRepo = model('Tenant');
  let tenant = await tenantRepo.findOne({ slug: 'test-tenants' });
  if (!tenant) {
    tenant = new tenantRepo({
      name: 'Test Tenant',
      slug: 'test-tenants',
      planId: 'pro',
      status: 'active',
    });
    await tenant.save();
  } else {
    tenant.planId = 'pro';
    await tenant.save();
  }

  // Also ensure the subscription has planId `pro` so the entitlement service
  // resolves the correct plan limits instead of falling back to `starter`.
  const Subscription = mongoose.model('Subscription');
  let sub = await Subscription.findOne({ tenantId: TA });
  if (!sub) {
    sub = new Subscription({
      tenantId: TA,
      planId: 'pro',
      state: 'active',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    await sub.save();
  } else {
    sub.planId = 'pro';
    await sub.save();
  }

  const { dashboard, connector } = await seed();
  // MAX_WIDGETS_PER_DASHBOARD is 30 (hardcoded) — create exactly the
  // allowed number and verify the next widget is rejected.
  for (let i = 0; i < 30; i += 1) {
    await dashboardService.createWidget({
      tenantId: TA, dashboardId: String(dashboard._id),
      data: { name: `w${i}`, type: 'kpi', datasetId: String(connector._id) },
    });
  }
  await assert.rejects(
    () => dashboardService.createWidget({ tenantId: TA, dashboardId: String(dashboard._id), data: { name: 'one-too-many', type: 'kpi', datasetId: String(connector._id) } }),
    (e) => e.statusCode === 409,
  );
});

test('list widgets paginates for a dashboard', async () => {
  const { dashboard, connector } = await seed();
  for (let i = 0; i < 3; i += 1) {
    await dashboardService.createWidget({ tenantId: TA, dashboardId: String(dashboard._id), data: { name: `w${i}`, type: 'kpi', datasetId: String(connector._id) } });
  }
  const result = await widgetRepository.list({ tenantId: TA, dashboardId: String(dashboard._id), page: 1, limit: 2 });
  assert.equal(result.total, 3);
  assert.equal(result.docs.length, 2);
});
