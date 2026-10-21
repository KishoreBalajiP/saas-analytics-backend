/**
 * Alert metric extraction (roadmap 1.5, finding ana.06).
 *
 *   - `metric` must be an output of the rule's query (metric alias, or
 *     `count` without metrics): 400 ALERT_METRIC_INVALID at save time, and
 *     a recorded, typed failure at evaluation when the query changed later;
 *   - `total` evaluation computes sum / avg / count / min / max over the
 *     WHOLE filtered dataset server-side (an average is never an average of
 *     group averages), whatever the query's groupBy;
 *   - `any` / `all` evaluation reads every group and is tested with every
 *     operator;
 *   - empty results: count/sum are 0, avg/min/max are "no data" (never met).
 */

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { useMongo, resetMongo } from '../helpers/index.js';
import { factories } from '../helpers/factories.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import { AlertRule } from '../../src/models/AlertRule.js';
import { Widget } from '../../src/models/Widget.js';
import connectorRepository from '../../src/repositories/connector.repository.js';
import alertRepository from '../../src/repositories/alert.repository.js';
import * as alertService from '../../src/services/alert.service.js';
import * as dashboardService from '../../src/services/dashboard.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import entitlementOverrideService from '../../src/services/entitlementOverride.service.js';
import { run as auditAlertMetrics, parseArgs as auditArgs } from '../../scripts/ci/audit-alert-metrics.js';

useMongo();

let tenantId;
let datasetId;

// EU 10, 20, 30 | US 5, 'n/a' | APAC 100
const ROWS = [
  ['EU', 10], ['EU', 20], ['EU', 30], ['US', 5], ['US', 'n/a'], ['APAC', 100],
];
const TOTALS = { count: 6, sum: 165, avg: 33, min: 5, max: 100 };
const BY_REGION_SUM = { EU: 60, US: 5, APAC: 100 };

beforeEach(async () => {
  await resetMongo();
  await cacheService.flushAll();
  tenantId = String((await factories.tenant.create({ status: 'active' }))._id);
  // Many rules per test: lift the plan's alert limit for this workspace.
  await entitlementOverrideService.create({
    tenantId, metric: 'alerts', kind: 'limit', value: { max: 1000, hard: true }, reason: 'test', by: 'admin-test',
  });
  const connector = await connectorRepository.create({ tenantId, type: 'csv', name: 'Orders', status: 'active' });
  datasetId = String(connector._id);
  await ConnectorRow.insertMany(ROWS.map(([region, amount], i) => ({
    tenantId, connectorId: connector._id, sourceRowId: `r${i}`, data: { region, amount: String(amount) },
  })));
});

const metricInvalid = (field = 'metric') => (err) => {
  assert.equal(err.statusCode, 400);
  assert.equal(err.code, 'ALERT_METRIC_INVALID');
  assert.ok(err.errors.some((e) => e.field === field), JSON.stringify(err.errors));
  return true;
};

function rule(extra = {}) {
  return alertService.createRule({
    tenantId, name: `Rule ${Math.random().toString(16).slice(2, 8)}`, source: 'query',
    condition: 'gte', threshold: 0, cooldownMinutes: 0, query: { datasetId }, ...extra,
  });
}

async function evaluate(alert) {
  return alertService.evaluate({ tenantId, alertId: String(alert._id) });
}

test('compare() handles every operator and never matches a missing value', () => {
  const cases = [
    ['gt', 10, 5, true], ['gt', 5, 5, false],
    ['gte', 5, 5, true], ['gte', 4, 5, false],
    ['lt', 4, 5, true], ['lt', 5, 5, false],
    ['lte', 5, 5, true], ['lte', 6, 5, false],
    ['eq', 5, 5, true], ['eq', 5.0001, 5, false],
    ['neq', 6, 5, true], ['neq', 5, 5, false],
  ];
  for (const [op, value, threshold, expected] of cases) {
    assert.equal(alertService.compare(op, value, threshold), expected, `${value} ${op} ${threshold}`);
  }
  assert.equal(alertService.compare('between', 5, 1, 5), true);
  assert.equal(alertService.compare('between', 5.5, 1, 5), false);
  for (const op of ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'between']) {
    for (const missing of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, '5']) {
      assert.equal(alertService.compare(op, missing, 0, 10), false, `${op} on ${String(missing)}`);
    }
  }
});

test('total evaluation computes sum, avg, count, min and max over the whole dataset', async () => {
  for (const op of ['sum', 'avg', 'count', 'min', 'max']) {
    const metric = op === 'count' ? { op } : { op, field: 'amount' };
    const alert = await rule({ query: { datasetId, metrics: [metric] } });
    assert.equal(alert.metric, op === 'count' ? 'count' : `${op}_amount`, 'defaults to the query output');
    const result = await evaluate(alert);
    assert.equal(result.value, TOTALS[op], op);
    assert.equal(result.outcome, 'triggered');
  }
  // A grouped query evaluated in total: the true average (33), not the
  // average of group averages ((20 + 5 + 100) / 3).
  const grouped = await rule({
    metric: 'avg_amount',
    query: { datasetId, groupBy: ['region'], metrics: [{ op: 'sum', field: 'amount' }, { op: 'avg', field: 'amount' }], orderBy: [{ field: 'sum_amount', direction: 'desc' }] },
  });
  assert.equal(grouped.groupEvaluation, 'total');
  const result = await evaluate(grouped);
  assert.equal(result.value, 33);
  assert.equal(result.groupsEvaluated, undefined, 'total evaluation reports no group counts');
});

test('the configured metric alias is the one evaluated, raw queries evaluate their row count', async () => {
  const aliased = await rule({
    metric: 'revenue',
    query: { datasetId, metrics: [{ op: 'count', alias: 'orders' }, { op: 'sum', field: 'amount', alias: 'revenue' }] },
  });
  assert.equal((await evaluate(aliased)).value, 165, 'revenue, not the first metric or the count');
  const raw = await rule();
  assert.equal(raw.metric, 'count');
  assert.equal((await evaluate(raw)).value, 6);
});

test('every operator decides a total evaluation', async () => {
  // sum(amount) = 165
  const cases = [
    ['gt', 164, true], ['gt', 165, false],
    ['gte', 165, true], ['gte', 166, false],
    ['lt', 166, true], ['lt', 165, false],
    ['lte', 165, true], ['lte', 164, false],
    ['eq', 165, true], ['eq', 164, false],
    ['neq', 164, true], ['neq', 165, false],
  ];
  for (const [condition, threshold, met] of cases) {
    const alert = await rule({ condition, threshold, query: { datasetId, metrics: [{ op: 'sum', field: 'amount' }] } });
    const result = await evaluate(alert);
    assert.equal(result.conditionMet, met, `165 ${condition} ${threshold}`);
    assert.equal(result.triggered, met);
    assert.equal(result.outcome, met ? 'triggered' : 'not_met');
  }
  for (const [low, high, met] of [[160, 170, true], [165, 165, true], [166, 200, false]]) {
    const alert = await rule({ condition: 'between', threshold: low, thresholdHigh: high, query: { datasetId, metrics: [{ op: 'sum', field: 'amount' }] } });
    assert.equal((await evaluate(alert)).conditionMet, met, `165 between ${low}..${high}`);
  }
});

test('grouped results: any / all with every operator over every group', async () => {
  // sum(amount) by region, in group order: APAC 100, EU 60, US 5. The
  // decisive value: the extreme matching group (any) or the weakest group
  // (all) for gt/gte/lt/lte; the first matching (any) or first failing
  // (all) group otherwise.
  const query = { datasetId, groupBy: ['region'], metrics: [{ op: 'sum', field: 'amount', alias: 'revenue' }] };
  const cases = [
    // [mode, condition, threshold, thresholdHigh, met, value, matched]
    ['any', 'gt', 50, null, true, 100, 2],
    ['all', 'gt', 50, null, false, 5, 2],
    ['all', 'gt', 1, null, true, 5, 3],
    ['any', 'gte', 100, null, true, 100, 1],
    ['all', 'gte', 5, null, true, 5, 3],
    ['any', 'lt', 10, null, true, 5, 1],
    ['all', 'lt', 100, null, false, 100, 2],
    ['any', 'lte', 4, null, false, 5, 0],
    ['all', 'lte', 100, null, true, 100, 3],
    ['any', 'eq', 60, null, true, 60, 1],
    ['all', 'eq', 60, null, false, 100, 1],
    ['any', 'neq', 60, null, true, 100, 2],
    ['all', 'neq', 7, null, true, 100, 3],
    ['any', 'between', 50, 70, true, 60, 1],
    ['all', 'between', 1, 100, true, 100, 3],
    ['all', 'between', 50, 200, false, 5, 2],
  ];
  for (const [mode, condition, threshold, thresholdHigh, met, value, matched] of cases) {
    const label = `${mode} ${condition} ${threshold}${thresholdHigh ? `..${thresholdHigh}` : ''}`;
    const alert = await rule({ metric: 'revenue', groupEvaluation: mode, condition, threshold, thresholdHigh, query });
    const result = await evaluate(alert);
    assert.equal(result.conditionMet, met, label);
    assert.equal(result.value, value, `${label}: decisive value`);
    assert.equal(result.groupsEvaluated, 3, label);
    assert.equal(result.groupsMatched, matched, label);
    if (met) {
      assert.equal(result.event.status, 'triggered');
      assert.equal(result.event.details.mode, mode);
      assert.equal(result.event.details.groupsMatched, matched);
      assert.match(result.event.message, new RegExp(`${matched} of 3 groups, ${mode}`));
    }
    const stored = await alertService.getById({ tenantId, alertId: String(alert._id) });
    assert.equal(stored.lastEvaluation.outcome, met ? 'triggered' : 'not_met', label);
    assert.equal(stored.lastEvaluation.groupsEvaluated, 3);
  }
  // Total over the same grouped query: every group summed.
  const total = await rule({ metric: 'revenue', query });
  assert.equal((await evaluate(total)).value, Object.values(BY_REGION_SUM).reduce((a, b) => a + b, 0));
});

test('per-group evaluation reads every page of groups and refuses more than the maximum', async () => {
  const connectorId = new mongoose.Types.ObjectId(datasetId);
  await ConnectorRow.collection.insertMany(Array.from({ length: 260 }, (_, i) => ({
    tenantId, connectorId, sourceRowId: `sku-${i}`, data: { sku: `S${i}`, qty: String(i === 259 ? 50 : 1) },
  })));
  const alert = await rule({
    metric: 'units', groupEvaluation: 'any', condition: 'gt', threshold: 10,
    query: { datasetId, filters: [{ field: 'sku', op: 'exists', value: true }], groupBy: ['sku'], metrics: [{ op: 'sum', field: 'qty', alias: 'units' }] },
  });
  const result = await evaluate(alert);
  assert.equal(result.groupsEvaluated, 260, 'more than one engine page (200)');
  assert.equal(result.groupsMatched, 1, 'the breaching group is on the second page');
  assert.equal(result.value, 50);

  await ConnectorRow.collection.insertMany(Array.from({ length: alertService.ALERT_MAX_GROUPS }, (_, i) => ({
    tenantId, connectorId, sourceRowId: `extra-${i}`, data: { sku: `X${i}`, qty: '1' },
  })));
  await assert.rejects(() => evaluate(alert), (err) => err.statusCode === 422 && err.code === 'ALERT_TOO_MANY_GROUPS');
  const stored = await alertService.getById({ tenantId, alertId: String(alert._id) });
  assert.equal(stored.lastEvaluation.outcome, 'failed');
  assert.match(stored.lastEvaluation.error, /groups/);
});

test('empty results: count and sum are 0, avg/min/max and groups are no data', async () => {
  const none = [{ field: 'region', op: 'eq', value: 'NOWHERE' }];
  const count = await rule({ condition: 'lt', threshold: 1, query: { datasetId, filters: none } });
  const countResult = await evaluate(count);
  assert.equal(countResult.value, 0);
  assert.equal(countResult.triggered, true, '"fewer than 1 order" fires on an empty window');

  const sum = await rule({ condition: 'eq', threshold: 0, query: { datasetId, filters: none, metrics: [{ op: 'sum', field: 'amount' }] } });
  assert.equal((await evaluate(sum)).value, 0);

  for (const op of ['avg', 'min', 'max']) {
    const alert = await rule({ condition: 'lt', threshold: 1000, query: { datasetId, filters: none, metrics: [{ op, field: 'amount' }] } });
    const result = await evaluate(alert);
    assert.equal(result.value, null, op);
    assert.equal(result.noData, true);
    assert.equal(result.conditionMet, false, `${op}: no data never meets a condition`);
    assert.equal(result.outcome, 'no_data');
    const stored = await alertService.getById({ tenantId, alertId: String(alert._id) });
    assert.equal(stored.lastEvaluation.outcome, 'no_data');
  }

  // Non-numeric values only: no data for avg.
  const textOnly = await rule({ condition: 'gte', threshold: 0, query: { datasetId, filters: [{ field: 'amount', op: 'eq', value: 'n/a' }], metrics: [{ op: 'avg', field: 'amount' }] } });
  assert.equal((await evaluate(textOnly)).outcome, 'no_data');

  const groups = await rule({ groupEvaluation: 'all', query: { datasetId, filters: none, groupBy: ['region'] } });
  const groupResult = await evaluate(groups);
  assert.equal(groupResult.outcome, 'no_data');
  assert.equal(groupResult.groupsEvaluated, 0);
  assert.equal(groupResult.conditionMet, false, '"every group" over no groups is not met');
});

test('a metric the query does not output is rejected at save time (create and update)', async () => {
  const query = { datasetId, metrics: [{ op: 'sum', field: 'amount', alias: 'revenue' }] };
  await assert.rejects(() => rule({ metric: 'sum_amount', query }), metricInvalid());
  await assert.rejects(() => rule({ metric: 'count', query }), metricInvalid(), 'count is not an output when metrics are defined');
  await assert.rejects(() => rule({ metric: 'sum_amount' }), metricInvalid(), 'a raw query only outputs count');
  assert.equal(await AlertRule.countDocuments({ tenantId }), 0, 'nothing saved');

  const ok = await rule({ query });
  assert.equal(ok.metric, 'revenue', 'defaults to the first output');
  const alertId = String(ok._id);
  await assert.rejects(() => alertService.updateRule({ tenantId, alertId, patch: { metric: 'nope' } }), metricInvalid());
  await assert.rejects(
    () => alertService.updateRule({ tenantId, alertId, patch: { query: { datasetId, metrics: [{ op: 'count' }] } } }),
    metricInvalid(),
    'changing the query must keep the metric an output',
  );
  const both = await alertService.updateRule({ tenantId, alertId, patch: { metric: 'count', query: { datasetId, metrics: [{ op: 'count' }] } } });
  assert.equal(both.metric, 'count');

  await assert.rejects(() => rule({ groupEvaluation: 'some' }), (e) => e.statusCode === 400 && e.errors.some((x) => x.field === 'groupEvaluation'));
  await assert.rejects(() => alertService.updateRule({ tenantId, alertId, patch: { groupEvaluation: 'most' } }), (e) => e.statusCode === 400);
  await assert.rejects(() => rule({ condition: 'between', threshold: 5 }), (e) => e.statusCode === 400 && e.errors.some((x) => x.field === 'thresholdHigh'));
  await assert.rejects(() => rule({ condition: 'between', threshold: 5, thresholdHigh: 4 }), (e) => e.errors.some((x) => x.field === 'thresholdHigh'));
});

test('widget alerts validate the metric against the widget query', async () => {
  const dashboard = await dashboardService.createDashboard({ tenantId, name: 'D' });
  const widget = await dashboardService.createWidget({
    tenantId, dashboardId: String(dashboard._id),
    data: { name: 'KPI', type: 'kpi', datasetId, query: { metrics: [{ op: 'sum', field: 'amount', alias: 'n' }] } },
  });
  const base = { tenantId, name: 'W', source: 'widget', dashboardId: String(dashboard._id), widgetId: String(widget._id), condition: 'gt', threshold: 1, cooldownMinutes: 0 };
  await assert.rejects(() => alertService.createRule({ ...base, metric: 'count' }), metricInvalid());
  const alert = await alertService.createRule(base);
  assert.equal(alert.metric, 'n');
  assert.equal((await evaluate(alert)).value, 165);

  // The widget's query changed after the alert was saved: a clear, recorded
  // failure, never a silent fallback to another column.
  await Widget.collection.updateOne({ _id: widget._id }, { $set: { query: { metrics: [{ op: 'sum', field: 'amount', alias: 'total' }] } } });
  await assert.rejects(() => evaluate(alert), metricInvalid());
  const stored = await alertService.getById({ tenantId, alertId: String(alert._id) });
  assert.equal(stored.lastEvaluation.outcome, 'failed');
  assert.match(stored.lastEvaluation.error, /"n" is no longer an output/);
  assert.ok(new Date(stored.nextEvaluationAt) > new Date(), 'still moves to its next slot');
});

test('a stored query alert whose metric is no longer an output fails evaluation with the metric error', async () => {
  const alert = await rule({ metric: 'revenue', query: { datasetId, metrics: [{ op: 'sum', field: 'amount', alias: 'revenue' }] } });
  await AlertRule.collection.updateOne({ _id: alert._id }, { $set: { metric: 'gone' } });
  await assert.rejects(() => evaluate(alert), (err) => {
    assert.equal(err.code, 'ALERT_METRIC_INVALID');
    assert.match(err.errors[0].message, /revenue/);
    return true;
  });
  const events = await alertRepository.listEvents({ tenantId, alertId: alert._id });
  assert.equal(events.docs.length, 0, 'no event, no notification');
});

test('the read-only metric audit lists rules whose metric is not an output, or whose query cannot run', async () => {
  const good = await rule({ query: { datasetId, metrics: [{ op: 'sum', field: 'amount', alias: 'revenue' }] } });
  const stale = await rule({ query: { datasetId, metrics: [{ op: 'sum', field: 'amount', alias: 'revenue' }] } });
  await AlertRule.collection.updateOne({ _id: stale._id }, { $set: { metric: 'sum_amount' } });
  const orphan = await rule();
  await AlertRule.collection.updateOne({ _id: orphan._id }, { $set: { 'query.datasetId': '0123456789abcdef01234567' } });
  const before = await AlertRule.find({ tenantId }).lean();

  const lines = [];
  const summary = await auditAlertMetrics({ tenantIds: [tenantId], log: (l) => lines.push(l) });
  assert.deepEqual(summary, { checked: 3, invalidMetric: 1, unresolvable: 1 });
  assert.ok(lines.some((l) => l.includes(String(stale._id)) && l.includes('"sum_amount" is not one of revenue')), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('broken') && l.includes(String(orphan._id))));
  assert.ok(!lines.some((l) => l.includes(String(good._id))));
  assert.deepEqual(await AlertRule.find({ tenantId }).lean(), before, 'nothing was written');
  assert.deepEqual(auditArgs(['--tenant', 'a', '--tenant', 'b']), { tenantIds: ['a', 'b'] });
});
