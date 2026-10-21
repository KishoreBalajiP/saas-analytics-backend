/**
 * vizbuilder (roadmap 3.5): visualization spec validation at save time,
 * schema-checked widget queries, KPI aggregate rule, counting aggregations,
 * excluded values, top N + Other bucket, table paging and provenance.
 */

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useMongo, resetMongo } from '../helpers/index.js';
import * as cacheService from '../../src/services/cache.service.js';
import * as dashboardService from '../../src/services/dashboard.service.js';
import connectorRepository from '../../src/repositories/connector.repository.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import * as engine from '../../src/services/analytics.engine.js';

useMongo();
const TA = 'tenant-a';
const TB = 'tenant-b';

beforeEach(async () => { await resetMongo(); await cacheService.flushAll(); });

const ROWS = [
  { region: 'EU', amount: 100, customer: 'a', day: '2024-01-01' },
  { region: 'EU', amount: 'n/a', customer: 'a', day: '2024-01-02' },
  { region: 'US', amount: 50, customer: 'b', day: '2024-01-02' },
  { region: 'US', amount: 25, customer: null, day: '2024-01-03' },
  { region: 'APAC', amount: 10, customer: 'c', day: '2024-01-03' },
  { region: 'LATAM', amount: 5, customer: 'd', day: '2024-01-04' },
];

async function seed(tenantId = TA) {
  const dashboard = await dashboardService.createDashboard({ tenantId, name: 'Viz' });
  const connector = await connectorRepository.create({ tenantId, type: 'csv', name: 'Orders', status: 'active', createdBy: 'u1' });
  await ConnectorRow.insertMany(ROWS.map((data, i) => ({ tenantId, connectorId: connector._id, sourceRowId: `r${i}`, data, ingestedAt: new Date() })));
  return { dashboardId: String(dashboard._id), datasetId: String(connector._id) };
}

const fieldsOf = (err) => (err.errors ?? []).map((e) => e.field);

test('invalid visualization specs are rejected with field errors', async () => {
  const { dashboardId, datasetId } = await seed();
  const base = { name: 'W', type: 'bar', datasetId, query: { groupBy: [{ field: 'region' }], metrics: [{ op: 'sum', field: 'amount', alias: 'total' }] } };
  await assert.rejects(
    () => dashboardService.createWidget({ tenantId: TA, dashboardId, data: { ...base, visualization: { xField: 'amount', series: ['nope'], limit: 0, pageSize: 10 } } }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, 'INVALID_VISUALIZATION');
      const f = fieldsOf(err);
      for (const k of ['visualization.xField', 'visualization.series[0]', 'visualization.limit', 'visualization.pageSize']) assert.ok(f.includes(k), `${k} in ${f}`);
      return true;
    },
  );
  const ok = await dashboardService.createWidget({ tenantId: TA, dashboardId, data: { ...base, visualization: { xField: 'region', series: ['total'], numberFormat: 'currency', currency: 'EUR' } } });
  assert.deepEqual(ok.visualization, { xField: 'region', series: ['total'], numberFormat: 'currency', currency: 'EUR' });

  // A later update is held to the same rules (type change to pie with two measures).
  await assert.rejects(
    () => dashboardService.updateWidget({ tenantId: TA, dashboardId, widgetId: String(ok._id), patch: { type: 'kpi' } }),
    (err) => err.code === 'INVALID_VISUALIZATION' && fieldsOf(err).includes('query.groupBy'),
  );
});

test('KPI without an aggregate metric is rejected', async () => {
  const { dashboardId, datasetId } = await seed();
  await assert.rejects(
    () => dashboardService.createWidget({ tenantId: TA, dashboardId, data: { name: 'K', type: 'kpi', datasetId, query: {} } }),
    (err) => err.statusCode === 400 && fieldsOf(err).includes('query.metrics'),
  );
  const kpi = await dashboardService.createWidget({ tenantId: TA, dashboardId, data: { name: 'K', type: 'kpi', datasetId, query: { metrics: [{ op: 'count' }] } } });
  assert.equal(kpi.type, 'kpi');
});

test('widget queries are checked against the dataset schema at save time', async () => {
  const { dashboardId, datasetId } = await seed();
  await assert.rejects(
    () => dashboardService.createWidget({
      tenantId: TA, dashboardId,
      data: { name: 'T', type: 'table', datasetId, query: { groupBy: [{ field: 'country' }], metrics: [{ op: 'sum', field: 'day' }] } },
    }),
    (err) => {
      assert.equal(err.code, 'INVALID_QUERY');
      assert.ok(fieldsOf(err).includes('query.groupBy[0].field'));
      assert.ok(fieldsOf(err).includes('query.metrics[0].op'));
      return true;
    },
  );
  // Malformed contract parts keep their engine field errors.
  await assert.rejects(
    () => dashboardService.createWidget({ tenantId: TA, dashboardId, data: { name: 'T', type: 'table', datasetId, query: { metrics: [{ op: 'median', field: 'amount' }] } } }),
    (err) => err.code === 'INVALID_QUERY' && fieldsOf(err).includes('query.metrics[0].op'),
  );
});

test('count_non_null, count_distinct and excluded values are correct', async () => {
  const { datasetId } = await seed();
  const result = await engine.queryRows({
    tenantId: TA,
    connectorIds: [datasetId],
    metrics: [
      { op: 'count', alias: 'rows' },
      { op: 'count_non_null', field: 'customer', alias: 'withCustomer' },
      { op: 'count_distinct', field: 'customer', alias: 'customers' },
      { op: 'sum', field: 'amount', alias: 'total' },
    ],
  });
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.rows[0], { rows: 6, withCustomer: 5, customers: 4, total: 190 });
  assert.deepEqual(result.excluded, { total: 1 }, 'the "n/a" amount is reported as excluded');
});

test('top N with an Other bucket, and the provenance panel data', async () => {
  const { dashboardId, datasetId } = await seed();
  const w = await dashboardService.createWidget({
    tenantId: TA, dashboardId,
    data: {
      name: 'By region', type: 'bar', datasetId,
      query: { groupBy: [{ field: 'region' }], metrics: [{ op: 'sum', field: 'amount', alias: 'total' }] },
      visualization: { limit: 2, showOther: true },
    },
  });
  const out = await dashboardService.executeWidget({ tenantId: TA, dashboardId, widgetId: String(w._id) });
  const rows = out.result.rows;
  assert.deepEqual(rows.slice(0, 2).map((r) => r.region), ['EU', 'US']);
  assert.deepEqual(out.result.topN, { limit: 2, of: 4, other: { region: 'Other', total: 15 } });
  assert.equal(rows[2].__other, true);
  assert.equal(out.result.visualization.xField, 'region');
  assert.deepEqual(out.result.visualization.measures, ['total']);
  const p = out.result.provenance;
  assert.equal(p.dataset.id, datasetId);
  assert.equal(p.dataset.name, 'Orders');
  assert.equal(typeof p.timezone, 'string');
  assert.deepEqual(p.excluded, { total: 1 });
  assert.deepEqual(p.metrics, [{ op: 'sum', field: 'amount', alias: 'total' }]);
});

test('table widgets page through results', async () => {
  const { dashboardId, datasetId } = await seed();
  const w = await dashboardService.createWidget({
    tenantId: TA, dashboardId,
    data: { name: 'Rows', type: 'table', datasetId, query: { groupBy: [{ field: 'region' }] }, visualization: { pageSize: 3 } },
  });
  const p1 = await dashboardService.executeWidget({ tenantId: TA, dashboardId, widgetId: String(w._id) });
  assert.equal(p1.result.limit, 3);
  assert.equal(p1.result.rows.length, 3);
  assert.equal(p1.result.pages, 2);
  const p2 = await dashboardService.executeWidget({ tenantId: TA, dashboardId, widgetId: String(w._id), page: 2 });
  assert.equal(p2.result.page, 2);
  assert.equal(p2.result.rows.length, 1);
});

test('another tenant cannot execute or read the widget', async () => {
  const { dashboardId, datasetId } = await seed();
  const w = await dashboardService.createWidget({ tenantId: TA, dashboardId, data: { name: 'K', type: 'kpi', datasetId, query: { metrics: [{ op: 'count' }] } } });
  await assert.rejects(() => dashboardService.executeWidget({ tenantId: TB, dashboardId, widgetId: String(w._id) }), (e) => e.statusCode === 404);
  const { dashboardId: dB } = await seed(TB);
  await assert.rejects(
    () => dashboardService.createWidget({ tenantId: TB, dashboardId: dB, data: { name: 'K', type: 'kpi', datasetId, query: { metrics: [{ op: 'count' }] } } }),
    (e) => e.statusCode === 400,
    'a dataset of another tenant is refused',
  );
});

test('public embeds get the visualization but not the provenance', async () => {
  const { executeEmbed } = await import('../../src/services/embed.service.js');
  const { dashboardId, datasetId } = await seed();
  const w = await dashboardService.createWidget({ tenantId: TA, dashboardId, data: { name: 'K', type: 'kpi', datasetId, query: { metrics: [{ op: 'count' }] } } });
  const one = await executeEmbed({ tenantId: TA, dashboardId, widgetId: String(w._id) });
  assert.equal(one.result.provenance, undefined);
  assert.equal(one.result.visualization.type, 'kpi');
  const all = await executeEmbed({ tenantId: TA, dashboardId });
  assert.equal(all.widgets[0].result.provenance, undefined);
});
