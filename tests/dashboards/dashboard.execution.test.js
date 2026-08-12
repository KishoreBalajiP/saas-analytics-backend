/**
 * Integration tests for `services/dashboard.service.js` widget execution —
 * analytics-engine integration, cache policy (edit busts the cache),
 * date-range preset resolution and cross-tenant isolation, plus
 * `viewDashboard` partial-failure semantics.
 */

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { useMongo, resetMongo } from '../helpers/index.js';
import * as cacheService from '../../src/services/cache.service.js';
import * as dashboardService from '../../src/services/dashboard.service.js';
import connectorRepository from '../../src/repositories/connector.repository.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';

useMongo();
const { ObjectId } = mongoose.Types;
const TA = 'tenant-a';
const TB = 'tenant-b';

beforeEach(async () => { await resetMongo(); await cacheService.flushAll(); });

const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
};

async function seed({ tenantId = TA, dashboard = {} } = {}) {
  const created = await dashboardService.createDashboard({ tenantId, name: 'Revenue', ...dashboard });
  const connector = await connectorRepository.create({ tenantId, type: 'csv', name: 'Orders', status: 'active', createdBy: 'u1' });
  await ConnectorRow.insertMany([
    { tenantId, connectorId: connector._id, sourceRowId: 'r1', data: { region: 'EU', amount: 100 }, ingestedAt: daysAgo(2) },
    { tenantId, connectorId: connector._id, sourceRowId: 'r2', data: { region: 'US', amount: 200 }, ingestedAt: daysAgo(3) },
  ]);
  return { dashboard: created, connector };
}

async function makeKpi(tenantId, dashboard, connector, extraQuery = {}) {
  return dashboardService.createWidget({
    tenantId,
    dashboardId: String(dashboard._id),
    data: {
      name: 'Total',
      type: 'kpi',
      datasetId: String(connector._id),
      query: { metrics: [{ alias: 'total', op: 'count', field: 'amount' }], ...extraQuery },
    },
  });
}

test('executeWidget runs the dataset query through the engine', async () => {
  const { dashboard, connector } = await seed();
  const widget = await makeKpi(TA, dashboard, connector, { groupBy: [{ field: 'region' }] });

  const result = await dashboardService.executeWidget({ tenantId: TA, dashboardId: String(dashboard._id), widgetId: String(widget._id) });
  assert.equal(result.widgetId, String(widget._id));
  assert.equal(result.cached, false);
  assert.equal(result.result.total, 2, 'one row per region group');
  assert.equal(result.result.rows.length, 2);
  const eu = result.result.rows.find((r) => r.region === 'EU');
  assert.ok(eu, 'grouped row carries the group field');
  assert.equal(eu.total, 1, 'count metric is aggregated per group');
  assert.equal(result.result.columns.includes('region'), true);
  assert.equal(result.result.columns.includes('total'), true);
});

test('first run is a cache miss; second is a cache hit with the same key', async () => {
  const { dashboard, connector } = await seed();
  const widget = await makeKpi(TA, dashboard, connector);

  const first = await dashboardService.executeWidget({ tenantId: TA, dashboardId: String(dashboard._id), widgetId: String(widget._id) });
  assert.equal(first.cached, false);

  const second = await dashboardService.executeWidget({ tenantId: TA, dashboardId: String(dashboard._id), widgetId: String(widget._id) });
  assert.equal(second.cached, true);
  assert.equal(second.cacheKey, first.cacheKey);
  assert.deepEqual(second.result.rows, first.result.rows);
});

test('editing a widget busts its cached result', async () => {
  const { dashboard, connector } = await seed();
  const widget = await makeKpi(TA, dashboard, connector);
  const id = String(widget._id);

  const before = await dashboardService.executeWidget({ tenantId: TA, dashboardId: String(dashboard._id), widgetId: id });
  assert.equal(before.cached, false);

  await dashboardService.updateWidget({ tenantId: TA, dashboardId: String(dashboard._id), widgetId: id, patch: { name: 'Total v2' } });
  const after = await dashboardService.executeWidget({ tenantId: TA, dashboardId: String(dashboard._id), widgetId: id });
  assert.equal(after.cached, false, 'updatedAt revision busts the cache');
  assert.notEqual(after.cacheKey, before.cacheKey);
});

test('dashboard-level date range preset is applied to widget queries', async () => {
  const { dashboard, connector } = await seed();
  await dashboardService.updateDashboard({
    tenantId: TA,
    dashboardId: String(dashboard._id),
    patch: { filters: { dateRange: { preset: 'last_30_days' } } },
  });

  // 20 days ago is inside last_30_days; 60 days ago is outside it.
  await ConnectorRow.insertMany([
    { tenantId: TA, connectorId: connector._id, sourceRowId: 'r-in', data: { region: 'EU', amount: 999 }, ingestedAt: daysAgo(20) },
    { tenantId: TA, connectorId: connector._id, sourceRowId: 'r-out', data: { region: 'APAC', amount: 1 }, ingestedAt: daysAgo(60) },
  ]);

  const widget = await makeKpi(TA, dashboard, connector);
  const result = await dashboardService.executeWidget({ tenantId: TA, dashboardId: String(dashboard._id), widgetId: String(widget._id) });
  // 2 seed rows (2 and 3 days ago) + the 20-day-old row. The 60-day-old row
  // must be filtered out; without the preset the count would be 4.
  assert.equal(result.result.total, 3);
});

test('execution is isolated per tenant (rows and datasets)', async () => {
  const { dashboard: da, connector: ca } = await seed();
  const { dashboard: db, connector: cb } = await seed({ tenantId: TB });
  await ConnectorRow.insertMany([
    { tenantId: TB, connectorId: cb._id, sourceRowId: 'r-b1', data: { region: 'ASIA', amount: 500 }, ingestedAt: new Date('2024-01-04') },
  ]);

  const widgetA = await makeKpi(TA, da, ca);
  const resultA = await dashboardService.executeWidget({ tenantId: TA, dashboardId: String(da._id), widgetId: String(widgetA._id) });
  assert.equal(resultA.result.total, 2, 'tenant B rows never leak into tenant A');

  // Tenant A cannot execute a widget whose dataset is owned by tenant B.
  const widgetB = await makeKpi(TB, db, cb);
  await assert.rejects(
    () => dashboardService.executeWidget({ tenantId: TA, dashboardId: String(db._id), widgetId: String(widgetB._id) }),
    (e) => e.statusCode === 404,
  );
});

test('executeWidget fails closed on unknown dashboard/widget/dataset', async () => {
  const { dashboard, connector } = await seed();
  const widget = await makeKpi(TA, dashboard, connector);

  await assert.rejects(
    () => dashboardService.executeWidget({ tenantId: TA, dashboardId: new ObjectId().toString(), widgetId: String(widget._id) }),
    (e) => e.statusCode === 404,
  );
  await assert.rejects(
    () => dashboardService.executeWidget({ tenantId: TA, dashboardId: String(dashboard._id), widgetId: new ObjectId().toString() }),
    (e) => e.statusCode === 404,
  );

  // Delete the dataset connector: execution must now fail closed rather than run.
  await connectorRepository.remove(String(connector._id), 'u1');
  await assert.rejects(
    () => dashboardService.executeWidget({ tenantId: TA, dashboardId: String(dashboard._id), widgetId: String(widget._id) }),
    (e) => e.statusCode === 400,
  );
});

test('viewDashboard reports per-widget partial failures', async () => {
  const { dashboard, connector: goodConnector } = await seed();
  const brokenConnector = await connectorRepository.create({ tenantId: TA, type: 'csv', name: 'Broken', status: 'active', createdBy: 'u1' });
  await ConnectorRow.insertMany([
    { tenantId: TA, connectorId: brokenConnector._id, sourceRowId: 'r-x', data: { region: 'US', amount: 5 }, ingestedAt: daysAgo(1) },
  ]);

  const good = await makeKpi(TA, dashboard, goodConnector);
  const broken = await makeKpi(TA, dashboard, brokenConnector);
  await connectorRepository.remove(String(brokenConnector._id), 'u1');

  const view = await dashboardService.viewDashboard({ tenantId: TA, dashboardId: String(dashboard._id) });
  assert.equal(view.widgets.length, 2);

  const byId = (id) => view.widgets.find((w) => w.widgetId === String(id));
  assert.equal(byId(good._id).status, 'ok');
  assert.equal(byId(broken._id).status, 'error');
  assert.ok(byId(broken._id).error);
});
