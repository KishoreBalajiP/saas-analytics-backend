/**
 * Reports and alerts on business time (roadmap 1.2):
 *   - relative presets are stored as presets and resolved at every run
 *     (ana.04: they used to be frozen at save time);
 *   - report-level filters and run overrides are applied, narrowing the
 *     source query (ana.14: they used to be stored but ignored);
 *   - widget-source alerts honour every preset (ana.13);
 *   - cron next-run is projected in the workspace time zone, or the
 *     schedule's own zone, and re-projected when the workspace zone changes.
 * Uses a fixed clock.
 */

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useMongo, resetMongo } from '../helpers/index.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import { Report } from '../../src/models/Report.js';
import { AlertRule } from '../../src/models/AlertRule.js';
import connectorRepository from '../../src/repositories/connector.repository.js';
import * as reportService from '../../src/services/report.service.js';
import * as alertService from '../../src/services/alert.service.js';
import * as dashboardService from '../../src/services/dashboard.service.js';
import * as analyticsService from '../../src/services/analytics.service.js';
import * as tenantSettings from '../../src/services/tenantSettings.service.js';
import workspaceSettings from '../../src/services/workspaceSettings.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import clock from '../../src/utils/clock.js';
import { factories } from '../helpers/factories.js';
// billing: tenants exercising paid features need a plan that includes them.
import { entitleTenant } from '../helpers/billing.js';

useMongo();
// 12:00 UTC on 2026-03-01 is 17:30 the same day in Kolkata.
const NOW = new Date('2026-03-01T12:00:00Z');
const FIELD = 'order_date';

let tenantId;
let datasetId;

beforeEach(async () => {
  await resetMongo();
  await cacheService.flushAll();
  clock.set(NOW);
  // A real, active workspace: the scheduler claims but does not run the due
  // schedules of tenants that are not active.
  tenantId = String((await factories.tenant.create({ status: 'active' }))._id);
  await entitleTenant(tenantId);
  const connector = await connectorRepository.create({ tenantId, type: 'csv', name: 'Orders', status: 'active' });
  datasetId = String(connector._id);
  // One order per day from 2026-02-01 to 2026-03-10, alternating regions.
  const rows = [];
  for (let day = 0; day < 38; day += 1) {
    const date = new Date(Date.UTC(2026, 1, 1 + day)).toISOString().slice(0, 10);
    rows.push({ tenantId, connectorId: connector._id, sourceRowId: date, data: { [FIELD]: date, region: day % 2 ? 'US' : 'EU', amount: 1 } });
  }
  await ConnectorRow.insertMany(rows);
  await tenantSettings.setTimezone({ tenantId, timezone: 'Asia/Kolkata' });
});

afterEach(() => clock.reset());

/** Run a report through the worker path and return the run's row count. */
async function runReport(reportId, overrides) {
  const { runId } = await reportService.run({ tenantId, reportId, filters: overrides });
  await reportService.processRun({ tenantId, reportId, runId });
  const report = await reportService.getById({ tenantId, reportId });
  const run = report.runs.find((r) => String(r._id) === runId);
  assert.equal(run.status, 'ready', run.error ?? 'run should succeed');
  return run.rowCount;
}

test('a relative preset is stored as a preset and resolved at each run', async () => {
  const report = await reportService.create({
    tenantId, name: 'Last month', source: 'query',
    query: { datasetId, dateRange: { field: FIELD, preset: 'last_month' } },
  });
  const stored = await Report.findById(report._id).lean();
  assert.deepEqual(stored.query.dateRange, { field: FIELD, preset: 'last_month' }, 'not frozen to absolute dates');

  assert.equal(await runReport(String(report._id)), 28, 'February');
  clock.set(new Date('2026-04-02T12:00:00Z'));
  assert.equal(await runReport(String(report._id)), 10, 'the window moved with the clock: March (data ends on the 10th)');
});

test('report-level filters narrow the source query and run overrides replace them', async () => {
  const report = await reportService.create({
    tenantId, name: 'Feb', source: 'query',
    query: {
      datasetId,
      filters: [{ field: 'region', op: 'eq', value: 'EU' }, { field: 'region', op: 'eq', value: 'US' }],
      filtersOp: 'or',
    },
    filters: { dateRange: { field: FIELD, from: '2026-02-01', to: '2026-02-10' }, filters: [{ field: 'region', op: 'eq', value: 'EU' }] },
  });
  const id = String(report._id);
  // 10 February days, of which the EU ones (odd dates: 1, 3, 5, 7, 9).
  assert.equal(await runReport(id), 5, 'report filters apply and AND with the OR-ed source filters');
  // Run overrides replace the report window and filters for this run only.
  assert.equal(await runReport(id, { dateRange: { field: FIELD, from: '2026-03-01', to: '2026-03-04' } }), 2, 'override window, report filters still EU');
  assert.equal(await runReport(id, { filters: [{ field: 'region', op: 'eq', value: 'US' }] }), 5, 'override filters replace the report filters');
  const report2 = await reportService.getById({ tenantId, reportId: id });
  assert.deepEqual(report2.runs.at(-1).filters, { filters: [{ field: 'region', op: 'eq', value: 'US' }] }, 'the applied override is recorded on the run');
});

test('invalid run overrides are rejected before anything is queued', async () => {
  const report = await reportService.create({ tenantId, name: 'R', source: 'query', query: { datasetId } });
  await assert.rejects(
    () => reportService.run({ tenantId, reportId: String(report._id), filters: { dateRange: { preset: 'today' } } }),
    (e) => e.statusCode === 400 && e.errors.some((x) => x.field === 'filters.dateRange.field'),
  );
  await assert.rejects(
    () => reportService.run({ tenantId, reportId: String(report._id), format: 'pdf' }),
    (e) => e.statusCode === 400 && e.errors.some((x) => x.field === 'format'),
  );
  const after = await reportService.getById({ tenantId, reportId: String(report._id) });
  assert.equal(after.runs.length, 0);
});

test('report schedules run in the workspace time zone unless they name their own', async () => {
  const followsWorkspace = await reportService.create({
    tenantId, name: 'Daily', source: 'query', query: { datasetId }, schedule: { enabled: true, cron: '0 8 * * *' },
  });
  assert.equal(followsWorkspace.schedule.timezone, null);
  // 08:00 in Kolkata after 17:30 on Mar 1 is Mar 2 08:00 IST = 02:30 UTC.
  assert.equal(new Date(followsWorkspace.nextRunAt).toISOString(), '2026-03-02T02:30:00.000Z');

  const ownZone = await reportService.create({
    tenantId, name: 'UTC daily', source: 'query', query: { datasetId }, schedule: { enabled: true, cron: '0 8 * * *', timezone: 'UTC' },
  });
  assert.equal(new Date(ownZone.nextRunAt).toISOString(), '2026-03-02T08:00:00.000Z');

  await assert.rejects(
    () => reportService.create({ tenantId, name: 'bad', source: 'query', query: { datasetId }, schedule: { enabled: true, cron: '0 8 * * *', timezone: 'Mars/Base' } }),
    (e) => e.statusCode === 400 && e.errors.some((x) => x.field === 'schedule.timezone'),
  );

  // The scheduler re-projects in the same zone after a due run.
  const due = new Date('2026-03-02T02:30:00Z');
  const { enqueued } = await reportService.runDue({ now: due });
  assert.equal(enqueued, 1);
  const after = await reportService.getById({ tenantId, reportId: String(followsWorkspace._id) });
  assert.equal(new Date(after.nextRunAt).toISOString(), '2026-03-03T02:30:00.000Z');

  // Changing the workspace zone moves schedules that follow it, not the others.
  await workspaceSettings.update({ tenantId, actorId: 'u1', patch: { timezone: 'America/New_York' } });
  const moved = await reportService.getById({ tenantId, reportId: String(followsWorkspace._id) });
  assert.equal(new Date(moved.nextRunAt).toISOString(), '2026-03-01T13:00:00.000Z', '08:00 New York (EST)');
  const kept = await reportService.getById({ tenantId, reportId: String(ownZone._id) });
  assert.equal(new Date(kept.nextRunAt).toISOString(), '2026-03-02T08:00:00.000Z');
});

test('one scheduler scan projects every due report of a workspace in the workspace zone (memoised per scan)', async () => {
  const reports = [];
  for (const name of ['A', 'B', 'C']) {
    reports.push(await reportService.create({
      tenantId, name, source: 'query', query: { datasetId }, schedule: { enabled: true, cron: '0 8 * * *' },
    }));
  }
  const { claimed, enqueued } = await reportService.runDue({ now: new Date('2026-03-02T02:30:00Z') });
  assert.equal(claimed, 3);
  assert.equal(enqueued, 3);
  for (const r of reports) {
    const after = await reportService.getById({ tenantId, reportId: String(r._id) });
    assert.equal(new Date(after.nextRunAt).toISOString(), '2026-03-03T02:30:00.000Z', '08:00 Kolkata, next day');
  }
});

test('query alerts evaluate presets in the workspace time zone at evaluation time', async () => {
  const alert = await alertService.createRule({
    tenantId, name: 'Weekly orders', source: 'query', metric: 'orders', condition: 'gte', threshold: 7,
    query: { datasetId, dateRange: { field: FIELD, preset: 'last_7_days' }, metrics: [{ op: 'count', alias: 'orders' }] },
    schedule: { cron: '0 9 * * *' },
  });
  const stored = await AlertRule.findById(alert._id).lean();
  assert.deepEqual(stored.query.dateRange, { field: FIELD, preset: 'last_7_days' });

  // Feb 23 - Mar 1 in Kolkata: 7 orders.
  const first = await alertService.evaluate({ tenantId, alertId: String(alert._id) });
  assert.equal(first.value, 7);
  assert.equal(first.triggered, true);
  const projected = await alertService.getById({ tenantId, alertId: String(alert._id) });
  assert.equal(new Date(projected.nextEvaluationAt).toISOString(), '2026-03-02T03:30:00.000Z', '09:00 Kolkata');

  // Mar 6 - Mar 12: the data ends on the 10th, so 5 orders. A frozen
  // window would still say 7.
  clock.set(new Date('2026-03-12T12:00:00Z'));
  const later = await alertService.evaluate({ tenantId, alertId: String(alert._id) });
  assert.equal(later.value, 5);
  assert.equal(later.conditionMet, false);
});

test('widget-source alerts read the widget window (every preset, incl. this_month)', async () => {
  const dashboard = await dashboardService.createDashboard({ tenantId, name: 'D' });
  const widget = await dashboardService.createWidget({
    tenantId, dashboardId: String(dashboard._id),
    data: { name: 'W', type: 'kpi', datasetId, query: { dateRange: { field: FIELD, preset: 'last_month' }, metrics: [{ op: 'count', alias: 'orders' }] } },
  });
  const alert = await alertService.createRule({
    tenantId, name: 'Feb orders', source: 'widget', dashboardId: String(dashboard._id), widgetId: String(widget._id),
    metric: 'orders', condition: 'eq', threshold: 28,
  });
  const result = await alertService.evaluate({ tenantId, alertId: String(alert._id) });
  assert.equal(result.value, 28, 'February in Kolkata, not every row');
  assert.equal(result.conditionMet, true);
});

test('every preset gives the same answer on every consumer path (analytics, widget, report, alert)', async () => {
  // Kolkata, 17:30 on Sunday 2026-03-01; one order per day from Feb 1 to Mar 10.
  const expected = {
    today: 1,
    yesterday: 1,
    last_7_days: 7,
    last_30_days: 29,
    this_month: 10,
    last_month: 28,
    previous_month: 28,
    this_quarter: 38,
    last_quarter: 0,
    this_year: 38,
    last_year: 0,
  };
  const dashboard = await dashboardService.createDashboard({ tenantId, name: 'Parity' });
  const dashboardId = String(dashboard._id);
  const widget = await dashboardService.createWidget({
    tenantId, dashboardId, data: { name: 'Orders', type: 'kpi', datasetId, query: { metrics: [{ op: 'count' }] } },
  });
  const report = await reportService.create({ tenantId, name: 'Parity', source: 'query', query: { datasetId } });
  const alert = await alertService.createRule({
    tenantId, name: 'Parity', source: 'query', condition: 'gte', threshold: 0, cooldownMinutes: 0, query: { datasetId },
  });

  for (const [preset, count] of Object.entries(expected)) {
    const dateRange = { field: FIELD, preset };
    const live = await analyticsService.query({ tenantId, connectorIds: [datasetId], dateRange, metrics: [{ op: 'count' }] });
    await dashboardService.updateDashboard({ tenantId, dashboardId, patch: { filters: { dateRange } } });
    const viaWidget = await dashboardService.executeWidget({ tenantId, dashboardId, widgetId: String(widget._id) });
    await reportService.update({ tenantId, reportId: String(report._id), patch: { query: { datasetId, dateRange } } });
    const viaReport = await runReport(String(report._id));
    await alertService.updateRule({ tenantId, alertId: String(alert._id), patch: { query: { datasetId, dateRange, metrics: [{ op: 'count' }] } } });
    const viaAlert = await alertService.evaluate({ tenantId, alertId: String(alert._id) });

    const answers = {
      analytics: live.rows[0]?.count ?? 0,
      widget: viaWidget.result.rows[0]?.count ?? 0,
      report: viaReport,
      alert: viaAlert.value,
    };
    assert.deepEqual(answers, { analytics: count, widget: count, report: count, alert: count }, preset);
    assert.deepEqual(live.window, viaWidget.result.window, `${preset}: same window`);
    assert.equal(live.window.preset, preset);
  }
});

test('a report whose stored query the contract rejects fails its run and says which part', async () => {
  const report = await reportService.create({ tenantId, name: 'legacy', source: 'query', query: { datasetId } });
  // A definition saved before the strict contract: implicit ingestion time, unknown operator.
  await Report.collection.updateOne({ _id: report._id }, {
    $set: { 'query.dateRange': { preset: 'last_7_days' }, 'query.filters': [{ field: 'region', op: 'like', value: 'E' }] },
  });
  const { runId } = await reportService.run({ tenantId, reportId: String(report._id) });
  await reportService.processRun({ tenantId, reportId: String(report._id), runId });
  const run = (await reportService.getById({ tenantId, reportId: String(report._id) })).runs.find((r) => String(r._id) === runId);
  assert.equal(run.status, 'failed', 'never generated with the invalid parts dropped');
  assert.match(run.error, /Invalid analytics query/);
  assert.match(run.error, /dateRange\.field/);
  assert.match(run.error, /filters\[0\]\.op/);
  assert.equal(run.rowCount, null);
});

test('an alert whose stored query is rejected still moves to its next slot', async () => {
  const alert = await alertService.createRule({
    tenantId, name: 'legacy', source: 'query', condition: 'gt', threshold: 0, query: { datasetId }, schedule: { cron: '*/5 * * * *' },
  });
  await AlertRule.collection.updateOne({ _id: alert._id }, { $set: { 'query.filters': [{ field: 'region', op: 'like', value: 'E' }] } });
  await assert.rejects(
    () => alertService.evaluate({ tenantId, alertId: String(alert._id) }),
    (e) => e.statusCode === 400 && e.code === 'INVALID_QUERY',
  );
  const after = await alertService.getById({ tenantId, alertId: String(alert._id) });
  assert.equal(new Date(after.nextEvaluationAt).toISOString(), '2026-03-01T12:05:00.000Z', 'not left due on every tick');
});

test('alert schedules follow the workspace zone and are re-projected when it changes', async () => {
  const alert = await alertService.createRule({
    tenantId, name: 'A', source: 'query', condition: 'gt', threshold: 0, query: { datasetId }, schedule: { cron: '0 9 * * *' },
  });
  await assert.rejects(
    () => alertService.updateRule({ tenantId, alertId: String(alert._id), patch: { schedule: { timezone: 'Nope/Nope' } } }),
    (e) => e.statusCode === 400 && e.errors.some((x) => x.field === 'schedule.timezone'),
  );
  const updated = await alertService.updateRule({ tenantId, alertId: String(alert._id), patch: { schedule: { cron: '0 9 * * *' } } });
  assert.equal(new Date(updated.nextEvaluationAt).toISOString(), '2026-03-02T03:30:00.000Z');
  await workspaceSettings.update({ tenantId, patch: { timezone: 'UTC' } });
  const moved = await alertService.getById({ tenantId, alertId: String(alert._id) });
  assert.equal(new Date(moved.nextEvaluationAt).toISOString(), '2026-03-02T09:00:00.000Z');
});
