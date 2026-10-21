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
  type: 'table', // vizbuilder: a KPI needs an aggregate metric
  datasetId: String(connector._id),
  ...extra,
});

test('create + get + update + remove a widget round-trips', async () => {
  const { dashboard, connector } = await seed();
  const created = await dashboardService.createWidget({
    tenantId: TA, dashboardId: String(dashboard._id), actorId: 'u1', data: widgetData(connector),
  });
  assert.equal(created.type, 'table');
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
    () => dashboardService.createWidget({ tenantId: TA, dashboardId: String(dashboard._id), data: { type: 'table', datasetId: String(connector._id) } }),
    (e) => e.statusCode === 400,
  );
});

test('query keeps only contract fields and rejects unknown ones instead of dropping them', async () => {
  // Roadmap 1.1 (strict contract): unknown query keys used to be silently
  // dropped; they are now a 400 with one field error per key.
  const { dashboard, connector } = await seed();
  await assert.rejects(
    () => dashboardService.createWidget({
      tenantId: TA, dashboardId: String(dashboard._id),
      data: widgetData(connector, {
        query: {
          metrics: [{ alias: 'total', op: 'count', field: 'amount' }],
          inject: { $where: 'danger' },
          dangerously: true,
        },
      }),
    }),
    (e) => e.statusCode === 400
      && e.code === 'INVALID_QUERY'
      && e.errors.some((x) => x.field === 'query.inject')
      && e.errors.some((x) => x.field === 'query.dangerously'),
  );
  const created = await dashboardService.createWidget({
    tenantId: TA, dashboardId: String(dashboard._id),
    data: widgetData(connector, {
      query: {
        metrics: [{ alias: 'total', op: 'count', field: 'amount' }],
        filters: [{ field: 'region', op: 'eq', value: 'EU' }],
        filtersOp: 'and',
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
  // Runs on the default plan: adding widgets consumes no `dashboards` quota,
  // only the per-dashboard widget cap applies (roadmap 1.3, finding tst.02).
  await planService.ensureDefaults();

  const { dashboard, connector } = await seed();
  // MAX_WIDGETS_PER_DASHBOARD is 30 (hardcoded) — create exactly the
  // allowed number and verify the next widget is rejected.
  for (let i = 0; i < 30; i += 1) {
    await dashboardService.createWidget({
      tenantId: TA, dashboardId: String(dashboard._id),
      data: { name: `w${i}`, type: 'table', datasetId: String(connector._id) },
    });
  }
  await assert.rejects(
    () => dashboardService.createWidget({ tenantId: TA, dashboardId: String(dashboard._id), data: { name: 'one-too-many', type: 'table', datasetId: String(connector._id) } }),
    (e) => e.statusCode === 409,
  );
});

test('list widgets paginates for a dashboard', async () => {
  const { dashboard, connector } = await seed();
  for (let i = 0; i < 3; i += 1) {
    await dashboardService.createWidget({ tenantId: TA, dashboardId: String(dashboard._id), data: { name: `w${i}`, type: 'table', datasetId: String(connector._id) } });
  }
  const result = await widgetRepository.list({ tenantId: TA, dashboardId: String(dashboard._id), page: 1, limit: 2 });
  assert.equal(result.total, 3);
  assert.equal(result.docs.length, 2);
});
