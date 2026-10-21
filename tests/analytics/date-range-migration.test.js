/**
 * Legacy date-range migration (`npm run db:date-ranges`, roadmap 1.2).
 * Run against the in-memory MongoDB only: dry run by default, apply on
 * request, and definitions keep their (ingestion-time) behaviour.
 */

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { useMongo, resetMongo } from '../helpers/index.js';
import { Dashboard } from '../../src/models/Dashboard.js';
import { Widget } from '../../src/models/Widget.js';
import { Report } from '../../src/models/Report.js';
import { AlertRule } from '../../src/models/AlertRule.js';
import { migrateLegacyDateRanges, migrateLegacyScheduleTimezones, upgradeDateRange } from '../../src/services/dateRangeMigration.service.js';
import * as tenantSettings from '../../src/services/tenantSettings.service.js';
import * as cacheService from '../../src/services/cache.service.js';

useMongo();
const { ObjectId } = mongoose.Types;
const tenantId = new ObjectId().toString();

beforeEach(async () => { await resetMongo(); await cacheService.flushAll(); });

test('upgradeDateRange makes the implicit ingestion-time field explicit and drops ignored parts', () => {
  assert.deepEqual(upgradeDateRange({ preset: 'last_30_days' }), { value: { field: 'ingestedAt', preset: 'last_30_days' }, changed: true });
  assert.deepEqual(upgradeDateRange({ preset: 'today', from: '2024-01-01', to: '2024-02-01' }).value, { field: 'ingestedAt', preset: 'today' });
  assert.deepEqual(upgradeDateRange({ from: new Date('2024-01-01T00:00:00Z'), to: 'Feb 1 2024 00:00 UTC' }).value, {
    field: 'ingestedAt', from: '2024-01-01T00:00:00.000Z', to: '2024-02-01T00:00:00.000Z',
  });
  assert.deepEqual(upgradeDateRange({ preset: 'custom' }), { value: undefined, changed: true }, 'a range with no bounds filtered nothing');
  assert.deepEqual(upgradeDateRange({ field: 'order_date', preset: 'this_year' }), { value: { field: 'order_date', preset: 'this_year' }, changed: false });
  assert.deepEqual(upgradeDateRange(null), { value: null, changed: false });
});

test('dry run reports changes without writing; apply rewrites only dateRange paths', async () => {
  const dash = new ObjectId();
  const widget = new ObjectId();
  const report = new ObjectId();
  const alert = new ObjectId();
  const badWidget = new ObjectId();
  await Dashboard.collection.insertOne({ _id: dash, tenantId, name: 'D', deletedAt: null, filters: { dateRange: { preset: 'last_30_days' } } });
  await Widget.collection.insertMany([
    { _id: widget, tenantId, dashboardId: dash, name: 'W', type: 'kpi', deletedAt: null, query: { metrics: [{ op: 'count' }], dateRange: { preset: 'today', from: 'x' } } },
    { _id: badWidget, tenantId, dashboardId: dash, name: 'B', type: 'kpi', deletedAt: null, query: { filters: [{ field: 'a', op: 'like', value: 1 }] } },
  ]);
  await Report.collection.insertOne({
    _id: report, tenantId, name: 'R', deletedAt: null,
    query: { datasetId: String(new ObjectId()), dateRange: { from: '2024-01-01T00:00:00.000Z', to: '2024-01-31T23:59:59.999Z' } },
    filters: { dateRange: { from: null, to: null } },
  });
  await AlertRule.collection.insertOne({ _id: alert, tenantId, name: 'A', deletedAt: null, query: { datasetId: String(new ObjectId()), dateRange: { preset: 'last_7_days' } } });

  const dry = await migrateLegacyDateRanges();
  assert.deepEqual(dry.dashboards, { scanned: 1, changed: 1, stillInvalid: [] });
  assert.equal(dry.widgets.changed, 1);
  assert.deepEqual(dry.widgets.stillInvalid, [String(badWidget)], 'definitions broken for other reasons are listed for their owners');
  assert.equal(dry.reports.changed, 1);
  assert.equal(dry.alerts.changed, 1);
  const untouched = await Dashboard.collection.findOne({ _id: dash });
  assert.deepEqual(untouched.filters.dateRange, { preset: 'last_30_days' }, 'dry run writes nothing');

  const applied = await migrateLegacyDateRanges({ dryRun: false });
  assert.equal(applied.dashboards.changed, 1);
  assert.deepEqual((await Dashboard.collection.findOne({ _id: dash })).filters.dateRange, { field: 'ingestedAt', preset: 'last_30_days' });
  const w = await Widget.collection.findOne({ _id: widget });
  assert.deepEqual(w.query.dateRange, { field: 'ingestedAt', preset: 'today' });
  assert.deepEqual(w.query.metrics, [{ op: 'count' }], 'other query parts are untouched');
  const r = await Report.collection.findOne({ _id: report });
  assert.deepEqual(r.query.dateRange, { field: 'ingestedAt', from: '2024-01-01T00:00:00.000Z', to: '2024-01-31T23:59:59.999Z' });
  assert.equal(r.filters.dateRange, undefined, 'an empty range is removed');
  assert.deepEqual((await AlertRule.collection.findOne({ _id: alert })).query.dateRange, { field: 'ingestedAt', preset: 'last_7_days' });

  const again = await migrateLegacyDateRanges({ dryRun: false });
  assert.equal(again.dashboards.changed + again.widgets.changed + again.reports.changed + again.alerts.changed, 0, 'idempotent');
});

test('legacy UTC schedule zones are cleared to follow the workspace zone, with next runs re-projected', async () => {
  await tenantSettings.setTimezone({ tenantId, timezone: 'Asia/Kolkata' });
  const legacy = new ObjectId();
  const own = new ObjectId();
  const legacyAlert = new ObjectId();
  const datasetId = String(new ObjectId());
  const stale = new Date('2000-01-01T00:00:00Z');
  await Report.collection.insertMany([
    { _id: legacy, tenantId, name: 'L', deletedAt: null, source: 'query', query: { datasetId }, schedule: { enabled: true, cron: '0 8 * * *', timezone: 'UTC' }, nextRunAt: stale },
    { _id: own, tenantId, name: 'O', deletedAt: null, source: 'query', query: { datasetId }, schedule: { enabled: true, cron: '0 8 * * *', timezone: 'Europe/Berlin' }, nextRunAt: stale },
  ]);
  await AlertRule.collection.insertOne({ _id: legacyAlert, tenantId, name: 'A', deletedAt: null, enabled: true, source: 'query', query: { datasetId }, schedule: { cron: '0 9 * * *', timezone: 'UTC' }, nextEvaluationAt: stale });

  const dry = await migrateLegacyScheduleTimezones();
  assert.deepEqual(dry.reportSchedules, { scanned: 1, changed: 1, stillInvalid: [] });
  assert.deepEqual(dry.alertSchedules, { scanned: 1, changed: 1, stillInvalid: [] });
  assert.equal((await Report.collection.findOne({ _id: legacy })).schedule.timezone, 'UTC', 'dry run writes nothing');

  await migrateLegacyScheduleTimezones({ dryRun: false });
  const migrated = await Report.collection.findOne({ _id: legacy });
  assert.equal(migrated.schedule.timezone, null);
  assert.notEqual(migrated.nextRunAt.getTime(), stale.getTime(), 'next run re-projected');
  // 08:00 in Kolkata is 02:30 UTC.
  assert.equal(migrated.nextRunAt.toISOString().slice(11), '02:30:00.000Z');
  const kept = await Report.collection.findOne({ _id: own });
  assert.equal(kept.schedule.timezone, 'Europe/Berlin', 'an explicit non-default zone is kept');
  assert.equal(kept.nextRunAt.getTime(), stale.getTime());
  const alert = await AlertRule.collection.findOne({ _id: legacyAlert });
  assert.equal(alert.schedule.timezone, null);
  assert.equal(alert.nextEvaluationAt.toISOString().slice(11), '03:30:00.000Z', '09:00 in Kolkata');

  const again = await migrateLegacyScheduleTimezones({ dryRun: false });
  assert.equal(again.reportSchedules.changed + again.alertSchedules.changed, 0, 'idempotent');
});
