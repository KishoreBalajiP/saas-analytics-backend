/**
 * Stored definitions under the strict query contract (roadmap 1.1).
 *
 * A widget, report or alert query read back from the database is held to the
 * same contract as a new one. In particular a stored key that names an
 * engine execution option (`tenantId`, `connectorIds`, `timezone`, ...) is
 * rejected with 400 INVALID_QUERY: it can neither replace the caller's
 * tenant or dataset nor be silently ignored. Also covers run-level
 * `filtersOp` overrides on reports and the `count` column clash.
 */

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { useMongo, resetMongo } from '../helpers/index.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import { Widget } from '../../src/models/Widget.js';
import { Report } from '../../src/models/Report.js';
import { AlertRule } from '../../src/models/AlertRule.js';
import connectorRepository from '../../src/repositories/connector.repository.js';
import * as dashboardService from '../../src/services/dashboard.service.js';
import * as reportService from '../../src/services/report.service.js';
import * as alertService from '../../src/services/alert.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import { queryRows } from '../../src/services/analytics.engine.js';
// billing: tenants exercising paid features need a plan that includes them.
import { entitleTenant } from '../helpers/billing.js';

useMongo();
const { ObjectId } = mongoose.Types;

let tenantA;
let tenantB;
let datasetA;
let datasetB;

beforeEach(async () => {
  await resetMongo();
  await cacheService.flushAll();
  tenantA = new ObjectId().toString();
  tenantB = new ObjectId().toString();
  await entitleTenant(tenantA);
  await entitleTenant(tenantB);
  const a = await connectorRepository.create({ tenantId: tenantA, type: 'csv', name: 'A', status: 'active' });
  const b = await connectorRepository.create({ tenantId: tenantB, type: 'csv', name: 'B', status: 'active' });
  datasetA = String(a._id);
  datasetB = String(b._id);
  await ConnectorRow.insertMany([
    { tenantId: tenantA, connectorId: a._id, sourceRowId: 'a1', data: { region: 'EU', count: 'x' } },
    { tenantId: tenantA, connectorId: a._id, sourceRowId: 'a2', data: { region: 'US', count: 'y' } },
    // Tenant B's rows: never readable through tenant A's definitions.
    ...Array.from({ length: 5 }, (_, i) => ({ tenantId: tenantB, connectorId: b._id, sourceRowId: `b${i}`, data: { region: 'EU' } })),
  ]);
});

const rejectedOn = (field) => (err) => {
  assert.equal(err.statusCode, 400);
  assert.equal(err.code, 'INVALID_QUERY');
  assert.ok(err.errors?.some((e) => e.field === field), `expected an error on "${field}", got ${JSON.stringify(err.errors)}`);
  return true;
};

async function widgetOfA() {
  const dashboard = await dashboardService.createDashboard({ tenantId: tenantA, name: 'D' });
  const widget = await dashboardService.createWidget({
    tenantId: tenantA,
    dashboardId: String(dashboard._id),
    data: { name: 'W', type: 'kpi', datasetId: datasetA, query: { metrics: [{ op: 'count' }] } },
  });
  return { dashboardId: String(dashboard._id), widgetId: String(widget._id) };
}

async function runAndRead(reportId, overrides) {
  const { runId } = await reportService.run({ tenantId: tenantA, reportId, filters: overrides });
  await reportService.processRun({ tenantId: tenantA, reportId, runId });
  const report = await reportService.getById({ tenantId: tenantA, reportId });
  return report.runs.find((r) => String(r._id) === runId);
}

test('a stored widget query naming engine options is rejected, never obeyed or dropped', async () => {
  const { dashboardId, widgetId } = await widgetOfA();
  const ok = await dashboardService.executeWidget({ tenantId: tenantA, dashboardId, widgetId });
  assert.deepEqual(ok.result.rows, [{ count: 2 }]);

  for (const [key, value] of [['tenantId', tenantB], ['connectorIds', [datasetB]], ['timezone', 'Asia/Kolkata'], ['select', '*']]) {
    await Widget.collection.updateOne({ _id: new ObjectId(widgetId) }, { $set: { query: { metrics: [{ op: 'count' }], [key]: value } } });
    await assert.rejects(() => dashboardService.executeWidget({ tenantId: tenantA, dashboardId, widgetId }), rejectedOn(key), key);
  }
  // The dashboard view reports the rejection per widget.
  const view = await dashboardService.viewDashboard({ tenantId: tenantA, dashboardId });
  assert.equal(view.widgets[0].status, 'error');
  assert.equal(view.widgets[0].error.code, 'INVALID_QUERY');
});

test('a stored report query naming engine options fails its run instead of reading another tenant', async () => {
  const report = await reportService.create({ tenantId: tenantA, name: 'R', source: 'query', query: { datasetId: datasetA, metrics: [{ op: 'count' }] } });
  const reportId = String(report._id);
  assert.equal((await runAndRead(reportId)).status, 'ready');

  await Report.collection.updateOne({ _id: report._id }, { $set: { 'query.tenantId': tenantB } });
  const run = await runAndRead(reportId);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /tenantId is not a recognised query field/);
  assert.equal(run.rowCount, null);

  // Widget-source reports read the widget's stored query the same way.
  const { dashboardId, widgetId } = await widgetOfA();
  const viaWidget = await reportService.create({ tenantId: tenantA, name: 'W', source: 'widget', dashboardId, widgetId });
  await Widget.collection.updateOne({ _id: new ObjectId(widgetId) }, { $set: { 'query.connectorIds': [datasetB] } });
  const widgetRun = await runAndRead(String(viaWidget._id));
  assert.equal(widgetRun.status, 'failed');
  assert.match(widgetRun.error, /connectorIds is not a recognised query field/);
});

test('a stored alert query naming engine options is rejected at evaluation', async () => {
  const alert = await alertService.createRule({
    tenantId: tenantA, name: 'A', source: 'query', condition: 'gte', threshold: 0, query: { datasetId: datasetA, metrics: [{ op: 'count' }] },
  });
  const alertId = String(alert._id);
  assert.equal((await alertService.evaluate({ tenantId: tenantA, alertId })).value, 2);

  await AlertRule.collection.updateOne({ _id: alert._id }, { $set: { 'query.tenantId': tenantB } });
  await assert.rejects(() => alertService.evaluate({ tenantId: tenantA, alertId }), rejectedOn('tenantId'));
  await AlertRule.collection.updateOne({ _id: alert._id }, { $unset: { 'query.tenantId': '' }, $set: { 'query.now': '2020-01-01' } });
  await assert.rejects(() => alertService.evaluate({ tenantId: tenantA, alertId }), rejectedOn('now'));
});

test('a run-level filtersOp alone re-combines the report-level filters for that run', async () => {
  const report = await reportService.create({
    tenantId: tenantA,
    name: 'Both regions',
    source: 'query',
    query: { datasetId: datasetA },
    filters: { filters: [{ field: 'region', op: 'eq', value: 'EU' }, { field: 'region', op: 'eq', value: 'US' }], filtersOp: 'and' },
  });
  const reportId = String(report._id);
  assert.equal((await runAndRead(reportId)).rowCount, 0, 'EU AND US matches nothing');
  const run = await runAndRead(reportId, { filtersOp: 'or' });
  assert.equal(run.status, 'ready');
  assert.equal(run.rowCount, 2, 'the override is applied, not ignored');
  assert.deepEqual(run.filters, { filtersOp: 'or' }, 'and recorded on the run');
});

test('grouping on a field named "count" keeps its values when a metric names the count', async () => {
  const result = await queryRows({ tenantId: tenantA, groupBy: ['count'], metrics: [{ op: 'count', alias: 'rows' }], orderBy: ['count'] });
  assert.deepEqual(result.rows, [{ count: 'x', rows: 1 }, { count: 'y', rows: 1 }]);
  await assert.rejects(() => queryRows({ tenantId: tenantA, groupBy: ['count'] }), rejectedOn('groupBy[0].field'));
});

test('a grouped alert metric spans every group, not just the first result page', async () => {
  // 260 groups: more than the default page (50) and the maximum page (200).
  await ConnectorRow.insertMany(Array.from({ length: 260 }, (_, i) => ({
    tenantId: tenantA, connectorId: new ObjectId(datasetA), sourceRowId: `sku-${i}`, data: { sku: `S${i}`, qty: '2' },
  })));
  const alert = await alertService.createRule({
    tenantId: tenantA, name: 'Units', source: 'query', metric: 'units', condition: 'gte', threshold: 0,
    query: { datasetId: datasetA, groupBy: ['sku'], metrics: [{ op: 'sum', field: 'qty', alias: 'units' }] },
  });
  const result = await alertService.evaluate({ tenantId: tenantA, alertId: String(alert._id) });
  assert.equal(result.value, 520, '260 groups x 2 units (the two seed rows have no qty)');
});
