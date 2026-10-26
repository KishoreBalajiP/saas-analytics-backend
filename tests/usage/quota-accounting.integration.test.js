/**
 * Quota accounting regression tests (roadmap 1.3; findings bil.02, con.01,
 * ana.05, fe2.07, db.02, tst.02, bil.07, con.05).
 *
 * Resource quotas count resources that exist: after any mix of create,
 * update, sync and delete, each `current` counter equals the real number of
 * resources. Covered per resource type, plus:
 *   - N concurrent creates against a hard limit K succeed exactly K times
 *   - deletes and releases never drive a counter below zero
 *   - a failed create gives its quota back
 *   - soft limits warn instead of refusing
 *   - stored rows follow the rows syncs really add (CSV, XLSX, MongoDB)
 *   - webhook reservations live in the usage ledger: retries after a failed
 *     write stay exact, reconciliation counts open reservations as in use
 *     and voids stale ones
 *   - seats follow invitations (invite, revoke, re-invite, resend, accept)
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import ExcelJS from 'exceljs';
import { startMongo, stopMongo, resetMongo, getMongoUri } from '../helpers/mongo.js';
import planService from '../../src/services/plan.service.js';
import subscriptionService from '../../src/services/subscription.service.js';
import entitlementOverrideService from '../../src/services/entitlementOverride.service.js';
import usageService from '../../src/services/usage.service.js';
import connectorService from '../../src/services/connector.service.js';
import * as dashboardService from '../../src/services/dashboard.service.js';
import * as reportService from '../../src/services/report.service.js';
import * as alertService from '../../src/services/alert.service.js';
import tenantService from '../../src/services/tenant.service.js';
import invitationService from '../../src/services/tenantInvitation.service.js';
import * as emailService from '../../src/services/email.service.js';
import tenantRepository from '../../src/repositories/tenant.repository.js';
import usageCounterRepository from '../../src/repositories/usageCounter.repository.js';
import usageSourceRepository from '../../src/repositories/usageSource.repository.js';
import usageReservationRepository from '../../src/repositories/usageReservation.repository.js';
import connectorRowRepository from '../../src/repositories/connectorRow.repository.js';
import dashboardRepository from '../../src/repositories/dashboard.repository.js';
import reportRepository from '../../src/repositories/report.repository.js';
import alertRepository from '../../src/repositories/alert.repository.js';
import { Connector } from '../../src/models/Connector.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import { SyncRun } from '../../src/models/SyncRun.js';
import { UsageCounter } from '../../src/models/UsageCounter.js';
import { UsageReservation } from '../../src/models/UsageReservation.js';
import env from '../../src/config/env.js';
import { Dashboard } from '../../src/models/Dashboard.js';
import { Report } from '../../src/models/Report.js';
import { AlertRule } from '../../src/models/AlertRule.js';
import { MongoDBConnector } from '../../src/modules/connectors/mongodb/mongodb.connector.js';

before(async () => { await startMongo(); });
beforeEach(async () => { await resetMongo(); await planService.ensureDefaults('test'); });
after(async () => { await emailService.close?.(); await stopMongo(); });

const PASSWORD = 'QuotaPassword123!';

async function makeTenant(planId = 'starter') {
  const suffix = randomBytes(4).toString('hex');
  const tenant = await tenantRepository.create({ name: `Q ${suffix}`, slug: `q-${suffix}`, planId, status: 'active' });
  const tenantId = String(tenant._id);
  await subscriptionService.createForTenant({ tenantId, planId });
  return tenantId;
}

async function limitOverride(tenantId, metric, max, hard = true) {
  await entitlementOverrideService.create({
    tenantId, metric, kind: 'limit', value: { max, hard }, reason: 'test limit', by: 'admin-test',
  });
}

async function counter(tenantId, metric, period = 'current') {
  return (await usageCounterRepository.findOne(tenantId, metric, period))?.value ?? 0;
}

/** Assert every reconciled counter equals the real resource count. */
async function assertCountersMatch(tenantId, label = '') {
  const actual = await usageSourceRepository.countResources(tenantId);
  for (const metric of usageService.RECONCILED_METRICS) {
    assert.equal(await counter(tenantId, metric), actual[metric], `${label} ${metric} counter equals real count`);
  }
}

function csvConnector(tenantId, name = 'Orders') {
  return connectorService.createConnectorRecord({
    // `id` is the key column, so a re-sent id refreshes its row.
    tenantId, actorId: 'u1', type: 'csv', name, config: { delimiter: ',' }, fieldMapping: { id: 'id', amount: 'amount' },
  });
}

function csvJob(tenantId, connectorId, csv) {
  return { data: { connectorId: String(connectorId), tenantId, jobType: 'ingest', payload: { buffer: Buffer.from(csv).toString('base64') } } };
}

function reportInput(tenantId, extra = {}) {
  return {
    tenantId,
    actorId: 'u1',
    name: `Report ${randomBytes(2).toString('hex')}`,
    source: 'widget',
    dashboardId: new mongoose.Types.ObjectId().toString(),
    widgetId: new mongoose.Types.ObjectId().toString(),
    ...extra,
  };
}

function alertInput(tenantId, extra = {}) {
  return {
    tenantId,
    actorId: 'u1',
    name: `Alert ${randomBytes(2).toString('hex')}`,
    source: 'widget',
    dashboardId: new mongoose.Types.ObjectId().toString(),
    widgetId: new mongoose.Types.ObjectId().toString(),
    metric: 'count',
    condition: 'gt',
    threshold: 1,
    ...extra,
  };
}

/* ------------------------- per-resource lifecycles ------------------------- */

test('connectors: create, update, validate, sync and delete keep the counter equal to live connectors (free plan)', async () => {
  const tenantId = await makeTenant('free'); // connectors max 1 hard
  const created = await csvConnector(tenantId);
  assert.equal(await counter(tenantId, 'connectors'), 1);
  for (let i = 0; i < 5; i += 1) {
    await connectorService.updateConnectorRecord({ tenantId, connectorId: String(created._id), patch: { name: `Orders ${i}` } });
  }
  await connectorService.validateConnectorRecord({ tenantId, connectorId: String(created._id) });
  for (let i = 0; i < 3; i += 1) {
    await connectorService.processSyncMessage(csvJob(tenantId, created._id, 'id,amount\n1,10\n2,20\n'));
  }
  await assertCountersMatch(tenantId, 'after updates and syncs');
  assert.equal(await counter(tenantId, 'connectors'), 1);

  await connectorService.deleteConnectorRecord({ tenantId, connectorId: String(created._id), actorId: 'u1' });
  assert.equal(await counter(tenantId, 'connectors'), 0);
  assert.equal(await counter(tenantId, 'storedRows'), 0);
  // The slot is free again: a new create succeeds on the 1-connector plan.
  await csvConnector(tenantId, 'Orders again');
  await assertCountersMatch(tenantId, 'after re-create');
});

test('dashboards: create, update, publish, widgets, duplicate and delete keep the counter equal to live dashboards', async () => {
  const tenantId = await makeTenant('starter');
  const dataset = await csvConnector(tenantId);
  const created = [];
  for (let i = 0; i < 3; i += 1) {
    created.push(await dashboardService.createDashboard({ tenantId, actorId: 'u1', name: `D${i}` }));
  }
  for (let i = 0; i < 10; i += 1) {
    await dashboardService.updateDashboard({ tenantId, dashboardId: String(created[0]._id), patch: { name: `Renamed ${i}` } });
  }
  for (let i = 0; i < 4; i += 1) {
    await dashboardService.createWidget({
      tenantId, dashboardId: String(created[0]._id), data: { name: `W${i}`, type: 'table', datasetId: String(dataset._id) },
    });
  }
  // Publishing needs widgets (an empty dashboard is refused), so it follows them.
  await dashboardService.publishDashboard({ tenantId, dashboardId: String(created[0]._id) });
  await dashboardService.duplicateDashboard({ tenantId, dashboardId: String(created[0]._id) });
  await assertCountersMatch(tenantId, 'after edits');
  assert.equal(await counter(tenantId, 'dashboards'), 4);

  await dashboardService.deleteDashboard({ tenantId, dashboardId: String(created[1]._id) });
  await dashboardService.deleteDashboard({ tenantId, dashboardId: String(created[2]._id) });
  assert.equal(await counter(tenantId, 'dashboards'), await Dashboard.countDocuments({ tenantId }));
  await assertCountersMatch(tenantId, 'after deletes');
});

test('dashboards: ten create/delete cycles on the free plan never lock the tenant out', async () => {
  const tenantId = await makeTenant('free'); // dashboards max 5 hard
  for (let i = 0; i < 10; i += 1) {
    const d = await dashboardService.createDashboard({ tenantId, name: `Cycle ${i}` });
    await dashboardService.updateDashboard({ tenantId, dashboardId: String(d._id), patch: { description: 'x' } });
    await dashboardService.deleteDashboard({ tenantId, dashboardId: String(d._id) });
  }
  assert.equal(await counter(tenantId, 'dashboards'), 0);
});

test('reports and scheduled reports: create, schedule toggles and delete keep both counters exact', async () => {
  const tenantId = await makeTenant('starter');
  const plain = await reportService.create(reportInput(tenantId));
  const scheduled = await reportService.create(reportInput(tenantId, { schedule: { enabled: true, cron: '0 9 * * *' } }));
  assert.equal(await counter(tenantId, 'reports'), 2);
  assert.equal(await counter(tenantId, 'scheduledReports'), 1);

  await reportService.update({ tenantId, reportId: String(plain._id), patch: { name: 'Renamed' } });
  await reportService.update({ tenantId, reportId: String(plain._id), patch: { schedule: { enabled: true, cron: '0 8 * * *' } } });
  assert.equal(await counter(tenantId, 'scheduledReports'), 2);
  await reportService.update({ tenantId, reportId: String(scheduled._id), patch: { schedule: { enabled: false } } });
  assert.equal(await counter(tenantId, 'scheduledReports'), 1);
  await assertCountersMatch(tenantId, 'after toggles');

  await reportService.remove({ tenantId, reportId: String(plain._id) });
  assert.equal(await counter(tenantId, 'reports'), 1);
  assert.equal(await counter(tenantId, 'scheduledReports'), 0);
  assert.equal(await Report.countDocuments({ tenantId, 'schedule.enabled': true }), 0);
  await assertCountersMatch(tenantId, 'after delete');
});

test('scheduled reports respect their own limit (free plan allows none)', async () => {
  const tenantId = await makeTenant('free'); // scheduledReports max 0 hard
  await assert.rejects(
    () => reportService.create(reportInput(tenantId, { schedule: { enabled: true, cron: '0 9 * * *' } })),
    (err) => err.code === 'QUOTA_EXCEEDED' && err.details.metric === 'scheduledReports',
  );
  // The report quota taken first was given back.
  assert.equal(await counter(tenantId, 'reports'), 0);
  const r = await reportService.create(reportInput(tenantId));
  await assert.rejects(
    () => reportService.update({ tenantId, reportId: String(r._id), patch: { schedule: { enabled: true, cron: '0 9 * * *' } } }),
    (err) => err.code === 'QUOTA_EXCEEDED',
  );
  const stored = await Report.findById(r._id).lean();
  assert.equal(stored.schedule.enabled, false, 'refused schedule is not saved');
  await assertCountersMatch(tenantId, 'after refusals');
});

test('alerts: create, update and delete keep the counter equal to live rules', async () => {
  const tenantId = await makeTenant('starter');
  const a1 = await alertService.createRule(alertInput(tenantId));
  const a2 = await alertService.createRule(alertInput(tenantId));
  await alertService.updateRule({ tenantId, alertId: String(a1._id), patch: { threshold: 5 } });
  await alertService.updateRule({ tenantId, alertId: String(a1._id), patch: { enabled: false } });
  assert.equal(await counter(tenantId, 'alerts'), 2);
  await alertService.removeRule({ tenantId, alertId: String(a2._id) });
  assert.equal(await counter(tenantId, 'alerts'), await AlertRule.countDocuments({ tenantId }));
  await assertCountersMatch(tenantId, 'alerts');
});

test('a failed create gives its quota back (validation after the check, bad cron)', async () => {
  const tenantId = await makeTenant('starter');
  await assert.rejects(() => reportService.create(reportInput(tenantId, { source: 'query', query: null })));
  await assert.rejects(() => reportService.create(reportInput(tenantId, { schedule: { enabled: true, cron: 'not a cron' } })));
  await assert.rejects(() => alertService.createRule(alertInput(tenantId, { schedule: { cron: 'nope' } })));
  await assert.rejects(() => alertService.createRule(alertInput(tenantId, { source: 'widget', widgetId: null })));
  assert.equal(await counter(tenantId, 'reports'), 0);
  assert.equal(await counter(tenantId, 'scheduledReports'), 0);
  assert.equal(await counter(tenantId, 'alerts'), 0);
});

/* ------------------------------ concurrency -------------------------------- */

test('N concurrent dashboard creates against a hard limit K succeed exactly K times', async () => {
  const tenantId = await makeTenant('free'); // dashboards max 5 hard
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, (_, i) => dashboardService.createDashboard({ tenantId, name: `Race ${i}` })),
  );
  const ok = results.filter((r) => r.status === 'fulfilled');
  const refused = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 5);
  assert.equal(refused.length, 7);
  for (const r of refused) {
    assert.equal(r.reason.code, 'QUOTA_EXCEEDED');
    assert.equal(r.reason.statusCode, 409);
    assert.equal(r.reason.details.metric, 'dashboards');
    assert.equal(r.reason.details.limit, 5);
  }
  assert.equal(await Dashboard.countDocuments({ tenantId }), 5);
  assert.equal(await counter(tenantId, 'dashboards'), 5);
});

test('N concurrent connector creates against a hard limit K succeed exactly K times', async () => {
  const tenantId = await makeTenant('starter');
  await limitOverride(tenantId, 'connectors', 3);
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) => csvConnector(tenantId, `C${i}`)),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
  assert.equal(await Connector.countDocuments({ tenantId }), 3);
  assert.equal(await counter(tenantId, 'connectors'), 3);
});

test('the counter never passes a hard limit, even transiently, under concurrent consumes', async () => {
  const tenantId = await makeTenant('starter');
  await limitOverride(tenantId, 'alerts', 4);
  const seen = [];
  await Promise.allSettled(Array.from({ length: 20 }, async () => {
    const r = await usageService.checkAndConsume({ tenantId, metric: 'alerts' });
    seen.push(r.value);
  }));
  assert.equal(seen.length, 4);
  assert.ok(seen.every((v) => v <= 4));
  assert.equal(await counter(tenantId, 'alerts'), 4);
});

/* ------------------------------ never negative ----------------------------- */

test('deletes and releases never drive a counter below zero', async () => {
  const tenantId = await makeTenant('starter');
  const d = await dashboardService.createDashboard({ tenantId, name: 'Only' });
  // Corrupt the counter low (e.g. an earlier double release), then delete.
  await usageCounterRepository.setToActual({ tenantId, metric: 'dashboards', value: 0 });
  await dashboardService.deleteDashboard({ tenantId, dashboardId: String(d._id) });
  assert.equal(await counter(tenantId, 'dashboards'), 0);

  const released = await usageService.release({ tenantId, metric: 'connectors', requested: 5 });
  assert.equal(released.value, 0);
  assert.equal(await counter(tenantId, 'connectors'), 0);
  await usageCounterRepository.setToActual({ tenantId, metric: 'storedRows', value: 3 });
  await usageService.adjustStoredRows({ tenantId, delta: -10 });
  assert.equal(await counter(tenantId, 'storedRows'), 0);
  // Concurrent releases of the same unit stay at zero.
  await usageCounterRepository.setToActual({ tenantId, metric: 'reports', value: 1 });
  await Promise.all(Array.from({ length: 5 }, () => usageService.release({ tenantId, metric: 'reports' })));
  assert.equal(await counter(tenantId, 'reports'), 0);
});

test('deleting the same dashboard twice releases its quota once', async () => {
  const tenantId = await makeTenant('starter');
  const keep = await dashboardService.createDashboard({ tenantId, name: 'Keep' });
  const gone = await dashboardService.createDashboard({ tenantId, name: 'Gone' });
  await dashboardService.deleteDashboard({ tenantId, dashboardId: String(gone._id) });
  await assert.rejects(() => dashboardService.deleteDashboard({ tenantId, dashboardId: String(gone._id) }), (err) => err.statusCode === 404);
  assert.equal(await counter(tenantId, 'dashboards'), 1);
  assert.ok(keep);
});

test('a delete that loses a race to another delete releases nothing (dashboards, reports, alerts)', async (t) => {
  const tenantId = await makeTenant('starter');
  await dashboardService.createDashboard({ tenantId, name: 'Keep' });
  const gone = await dashboardService.createDashboard({ tenantId, name: 'Gone' });
  await reportService.create(reportInput(tenantId, { schedule: { enabled: true, cron: '0 9 * * *' } }));
  const report = await reportService.create(reportInput(tenantId, { schedule: { enabled: true, cron: '0 9 * * *' } }));
  await alertService.createRule(alertInput(tenantId));
  const rule = await alertService.createRule(alertInput(tenantId));

  // Read each row the way a concurrent second delete does (before the first
  // delete lands), let the first delete win, then replay the stale read.
  const stale = {
    dashboard: await dashboardRepository.findById(String(gone._id), { tenantId }),
    report: await reportRepository.findById(String(report._id), { tenantId }),
    alert: await alertRepository.findRuleById(String(rule._id), { tenantId }),
  };
  await dashboardService.deleteDashboard({ tenantId, dashboardId: String(gone._id) });
  await reportService.remove({ tenantId, reportId: String(report._id) });
  await alertService.removeRule({ tenantId, alertId: String(rule._id) });

  const originals = {
    dashboard: dashboardRepository.findById,
    report: reportRepository.findById,
    alert: alertRepository.findRuleById,
  };
  t.after(() => {
    dashboardRepository.findById = originals.dashboard;
    reportRepository.findById = originals.report;
    alertRepository.findRuleById = originals.alert;
  });
  dashboardRepository.findById = async () => stale.dashboard;
  reportRepository.findById = async () => stale.report;
  alertRepository.findRuleById = async () => stale.alert;

  await assert.rejects(() => dashboardService.deleteDashboard({ tenantId, dashboardId: String(gone._id) }), (err) => err.statusCode === 404);
  await assert.rejects(() => reportService.remove({ tenantId, reportId: String(report._id) }), (err) => err.statusCode === 404);
  await assert.rejects(() => alertService.removeRule({ tenantId, alertId: String(rule._id) }), (err) => err.statusCode === 404);

  dashboardRepository.findById = originals.dashboard;
  reportRepository.findById = originals.report;
  alertRepository.findRuleById = originals.alert;
  assert.equal(await counter(tenantId, 'dashboards'), 1, 'the losing delete gave nothing back');
  assert.equal(await counter(tenantId, 'reports'), 1);
  assert.equal(await counter(tenantId, 'scheduledReports'), 1);
  assert.equal(await counter(tenantId, 'alerts'), 1);
  await assertCountersMatch(tenantId, 'after a lost delete race');
});

test('concurrent deletes of the same dashboard release its quota at most once', async () => {
  const tenantId = await makeTenant('starter');
  await dashboardService.createDashboard({ tenantId, name: 'Keep' });
  const target = await dashboardService.createDashboard({ tenantId, name: 'Target' });
  await Promise.allSettled(
    Array.from({ length: 6 }, () => dashboardService.deleteDashboard({ tenantId, dashboardId: String(target._id) })),
  );
  assert.equal(await Dashboard.countDocuments({ tenantId }), 1);
  assert.equal(await counter(tenantId, 'dashboards'), 1);
});

/* ------------------------------- soft limits ------------------------------- */

test('a soft limit allows the action past the limit and flags it (bil.07)', async () => {
  const tenantId = await makeTenant('pro'); // dashboards max 50 soft
  await usageCounterRepository.setToActual({ tenantId, metric: 'dashboards', value: 50 });
  const r = await usageService.checkAndConsume({ tenantId, metric: 'dashboards' });
  assert.equal(r.allowed, true);
  assert.equal(r.soft, true);
  assert.equal(r.value, 51);
  const d = await dashboardService.createDashboard({ tenantId, name: 'Over soft limit' });
  assert.ok(d._id);
  assert.equal(await counter(tenantId, 'dashboards'), 52);
});

test('write-blocked subscriptions refuse creates with SUBSCRIPTION_WRITE_BLOCKED and consume nothing', async () => {
  const tenantId = await makeTenant('starter');
  await subscriptionService.setState({ tenantId, state: 'restricted', reason: 'test' });
  await assert.rejects(
    () => dashboardService.createDashboard({ tenantId, name: 'Blocked' }),
    (err) => err.statusCode === 403 && err.code === 'SUBSCRIPTION_WRITE_BLOCKED',
  );
  assert.equal(await counter(tenantId, 'dashboards'), 0);
});

/* ------------------------------- stored rows ------------------------------- */

test('storedRows follows rows a CSV sync really adds; replays add nothing; delete releases', async () => {
  const tenantId = await makeTenant('starter');
  const c = await csvConnector(tenantId);
  await connectorService.processSyncMessage(csvJob(tenantId, c._id, 'id,amount\n1,10\n2,20\n3,30\n'));
  assert.equal(await counter(tenantId, 'storedRows'), 3);
  await connectorService.processSyncMessage(csvJob(tenantId, c._id, 'id,amount\n1,11\n2,21\n3,31\n'));
  assert.equal(await counter(tenantId, 'storedRows'), 3, 'a refresh adds no rows');
  await connectorService.processSyncMessage(csvJob(tenantId, c._id, 'id,amount\n3,32\n4,40\n4,41\n'));
  assert.equal(await counter(tenantId, 'storedRows'), 4, 'only the new id counts, duplicates in a batch once');
  assert.equal(await ConnectorRow.countDocuments({ tenantId }), 4);
  // The enqueue path no longer charges an estimate.
  await connectorService.syncCsvUpload({ tenantId, connectorId: String(c._id), buffer: Buffer.from('id\n9\n'.repeat(500)) });
  assert.equal(await counter(tenantId, 'storedRows'), 4);

  await connectorService.deleteConnectorRecord({ tenantId, connectorId: String(c._id) });
  assert.equal(await counter(tenantId, 'storedRows'), 0);
  await assertCountersMatch(tenantId, 'after delete');
});

test('storedRows: XLSX sync is metered on real rows', async () => {
  const tenantId = await makeTenant('starter');
  const c = await connectorService.createConnectorRecord({ tenantId, type: 'xlsx', name: 'Sheet', config: { hasHeader: true }, fieldMapping: { sku: 'sku' } });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');
  ws.addRow(['sku', 'qty']);
  for (let i = 1; i <= 7; i += 1) ws.addRow([`S${i}`, i]);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const job = { data: { connectorId: String(c._id), tenantId, jobType: 'ingest', payload: { buffer: buffer.toString('base64') } } };
  const result = await connectorService.processSyncMessage(job);
  assert.equal(result.upserted, 7);
  assert.equal(await counter(tenantId, 'storedRows'), 7);
  await connectorService.processSyncMessage(job);
  assert.equal(await counter(tenantId, 'storedRows'), 7);
  await assertCountersMatch(tenantId, 'xlsx');
});

test('storedRows: MongoDB pull sync is metered on real documents', async (t) => {
  // processSyncMessage does not close the provider's MongoClient; close it
  // after each pull here so the test process can exit.
  const originalIngest = MongoDBConnector.prototype.ingest;
  MongoDBConnector.prototype.ingest = async function* closingIngest(...args) {
    try {
      yield* originalIngest.apply(this, args);
    } finally {
      await this.disconnect();
    }
  };
  t.after(() => { MongoDBConnector.prototype.ingest = originalIngest; });
  const tenantId = await makeTenant('starter');
  const sourceDb = `quota_source_${randomBytes(3).toString('hex')}`;
  const source = mongoose.connection.client.db(sourceDb).collection('orders');
  await source.insertMany(Array.from({ length: 6 }, (_, i) => ({ orderId: `o${i}`, total: i })));
  const c = await connectorService.createConnectorRecord({
    tenantId, type: 'mongodb', name: 'Orders DB', config: { uri: getMongoUri(), database: sourceDb, collection: 'orders' }, fieldMapping: { orderId: 'orderId' },
  });
  await connectorService.syncMongoDB({ tenantId, connectorId: String(c._id) });
  const job = { data: { connectorId: String(c._id), tenantId, jobType: 'ingest', payload: {} } };
  const result = await connectorService.processSyncMessage(job);
  assert.equal(result.upserted, 6);
  assert.equal(await counter(tenantId, 'storedRows'), 6);
  await source.insertOne({ orderId: 'o-new', total: 99 });
  await connectorService.processSyncMessage(job);
  assert.equal(await counter(tenantId, 'storedRows'), 7);
  await assertCountersMatch(tenantId, 'mongodb');
  await mongoose.connection.client.db(sourceDb).dropDatabase();
});

test('storedRows hard limit: new rows beyond the limit fail the sync, refreshes still apply, enqueue refuses when over', async () => {
  const tenantId = await makeTenant('starter');
  await limitOverride(tenantId, 'storedRows', 4);
  const c = await csvConnector(tenantId);
  await connectorService.processSyncMessage(csvJob(tenantId, c._id, 'id,amount\n1,10\n2,20\n3,30\n'));
  assert.equal(await counter(tenantId, 'storedRows'), 3);
  // A plan limit is a permanent sync failure: the run fails once with the
  // typed QUOTA_EXCEEDED instead of being retried by the queue.
  const refused = await connectorService.processSyncMessage(csvJob(tenantId, c._id, 'id,amount\n1,99\n5,50\n6,60\n'));
  assert.equal(refused.failed.code, 'QUOTA_EXCEEDED');
  assert.match(refused.failed.message, /storedRows \(max 4\)/);
  assert.equal(await counter(tenantId, 'storedRows'), 3);
  assert.equal(await ConnectorRow.countDocuments({ tenantId }), 3);
  const refreshed = await ConnectorRow.findOne({ tenantId, sourceRowId: 'id:1' }).lean();
  assert.equal(refreshed.data.amount, '99', 'existing rows in the refused batch are refreshed');
  const failed = await Connector.findById(c._id).lean();
  assert.equal(failed.syncStatus, 'failed');
  const run = await SyncRun.findOne({ tenantId, connectorId: String(c._id), status: 'failed' }).lean();
  assert.equal(run.error.code, 'QUOTA_EXCEEDED', 'the run history names the plan limit');
  // On the queue's last attempt the typed error itself propagates.
  await assert.rejects(
    () => connectorService.processSyncMessage({ ...csvJob(tenantId, c._id, 'id,amount\n5,50\n6,60\n'), attemptsMade: 4, attempts: 5 }),
    (err) => err.code === 'QUOTA_EXCEEDED' && err.details.metric === 'storedRows' && err.details.limit === 4,
  );
  assert.equal(await counter(tenantId, 'storedRows'), 3);

  // Over the limit (e.g. after a downgrade): new syncs are refused up front.
  await usageCounterRepository.setToActual({ tenantId, metric: 'storedRows', value: 5 });
  await assert.rejects(
    () => connectorService.syncCsvUpload({ tenantId, connectorId: String(c._id), buffer: Buffer.from('id\n1\n') }),
    (err) => err.code === 'QUOTA_EXCEEDED',
  );
});

test('scheduledReports: a connector delete that stops dependent report schedules gives their slots back', async () => {
  const tenantId = await makeTenant('starter');
  const doomed = await csvConnector(tenantId, 'Doomed');
  const kept = await csvConnector(tenantId, 'Kept');
  const hourly = { enabled: true, cron: '0 * * * *' };
  await reportService.create(reportInput(tenantId, { source: 'query', query: { datasetId: String(doomed._id) }, schedule: hourly }));
  await reportService.create(reportInput(tenantId, { source: 'query', query: { datasetId: String(doomed._id) } }));
  await reportService.create(reportInput(tenantId, { source: 'query', query: { datasetId: String(kept._id) }, schedule: hourly }));
  assert.equal(await counter(tenantId, 'scheduledReports'), 2);
  assert.equal(await counter(tenantId, 'reports'), 3);

  const removed = await connectorService.deleteConnectorRecord({ tenantId, connectorId: String(doomed._id), actorId: 'u1' });
  assert.equal(removed.cascade.reportsBroken, 2, 'each broken report is counted once');
  assert.equal(await counter(tenantId, 'scheduledReports'), 1, 'only the stopped schedule is given back');
  assert.equal(await counter(tenantId, 'reports'), 3, 'broken reports still exist and keep their report slot');
  await assertCountersMatch(tenantId, 'after the delete cascade');
});

test('storedRows: a webhook reservation is drawn on by the worker meter and only the unused part is given back', async () => {
  const tenantId = await makeTenant('starter');
  await limitOverride(tenantId, 'storedRows', 5);
  const c = await connectorService.createConnectorRecord({
    tenantId, type: 'webhook', name: 'Reserved', config: { signingSecret: 'quota-test-signing-secret-0003' }, fieldMapping: { id: 'id' },
  });
  const job = (records, reservedRows) => ({
    data: { connectorId: String(c._id), tenantId, jobType: 'ingest', payload: { records, reservedRows, source: 'webhook' } },
  });
  // Request time reserved 3 for e1..e3; the plan is then filled to its limit
  // by other work. The reserved rows still land: the meter draws on the
  // reservation instead of consuming again (no double count, no refusal).
  await usageService.checkAndConsume({ tenantId, metric: 'storedRows', requested: 3 });
  await usageService.checkAndConsume({ tenantId, metric: 'storedRows', requested: 2 });
  const first = await connectorService.processSyncMessage(job([{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }], 3));
  assert.equal(first.upserted, 3);
  assert.equal(await counter(tenantId, 'storedRows'), 5);

  // e3 exists, e4 is new: of the 2 reserved, 1 becomes a row and 1 is given back.
  await usageService.release({ tenantId, metric: 'storedRows', requested: 2 });
  await usageService.checkAndConsume({ tenantId, metric: 'storedRows', requested: 2 });
  const second = await connectorService.processSyncMessage(job([{ id: 'e3' }, { id: 'e4' }], 2));
  assert.equal(second.upserted, 1);
  assert.equal(await counter(tenantId, 'storedRows'), 4, 'rows e1..e4');
  await assertCountersMatch(tenantId, 'reserved webhook deliveries');

  // A reservation that never became rows is given back exactly once.
  await usageService.checkAndConsume({ tenantId, metric: 'storedRows', requested: 1 });
  const sink = usageService.createStoredRowsSink({ tenantId, connectorId: String(c._id), reserved: 1, upsert: async () => ({ upserted: 0, matched: 0 }) });
  assert.equal(sink.reserved, 1);
  assert.equal(await sink.settle(), 1);
  assert.equal(await sink.settle(), 0);
  assert.equal(await counter(tenantId, 'storedRows'), 4);
});

test('adjustStoredRows is the helper other ingestion paths use for rows they add or remove', async () => {
  const tenantId = await makeTenant('starter');
  assert.equal((await usageService.adjustStoredRows({ tenantId, delta: 12 })).value, 12);
  assert.equal((await usageService.adjustStoredRows({ tenantId, delta: -5 })).value, 7);
  await assert.rejects(() => usageService.adjustStoredRows({ tenantId, delta: 1.5 }), (err) => err.statusCode === 400);
  await assert.rejects(() => usageService.adjustStoredRows({ delta: 1 }), (err) => err.statusCode === 400);
});

/* ---------------------------------- seats ---------------------------------- */

async function captureInviteToken(fn) {
  const sink = [];
  emailService.captureInto(sink);
  try {
    await fn();
  } finally {
    emailService.stopCapture();
  }
  const link = sink.map((m) => m.text).join('\n').match(/https?:\/\/[^\s]+/u)?.[0];
  return link ? new URL(link).searchParams.get('token') : null;
}

test('seats: owner, invite, revoke, re-invite, resend and accept keep members equal to real seats (no revoke bypass)', async () => {
  const email = `owner-${randomBytes(3).toString('hex')}@example.com`;
  let tenantId;
  const ownerToken = await captureInviteToken(async () => {
    const res = await tenantService.create({ tenant: { name: `Seats ${randomBytes(2).toString('hex')}` }, owner: { email, name: 'Owner' }, initialize: true, by: 'platform-admin' });
    tenantId = String(res.tenant._id);
  });
  assert.equal(await counter(tenantId, 'members'), 1, 'the invited owner holds a seat');
  await invitationService.accept({ token: ownerToken, name: 'Owner', password: PASSWORD });
  await assertCountersMatch(tenantId, 'after owner accepts');

  const invite = (address) => invitationService.create({ tenantId, email: address, roleName: 'Viewer', invitedBy: 'platform-admin' });
  const { invitation } = await invite('a@example.com');
  assert.equal(await counter(tenantId, 'members'), 2);
  const again = await invite('a@example.com');
  assert.equal(again.alreadyPending, true);
  assert.equal(await counter(tenantId, 'members'), 2, 'a duplicate invite takes no seat');

  await invitationService.revoke({ id: String(invitation._id), tenantId, by: 'platform-admin' });
  assert.equal(await counter(tenantId, 'members'), 1);
  await invite('a@example.com');
  assert.equal(await counter(tenantId, 'members'), 2, 're-inviting a revoked invitee takes a seat again');
  await invitationService.resend({ tenantId, email: 'a@example.com', roleName: 'Viewer', invitedBy: 'platform-admin' });
  assert.equal(await counter(tenantId, 'members'), 2, 'resend keeps one seat');
  await assertCountersMatch(tenantId, 'after invitation churn');
});

test('seats: the member limit is enforced on invitations and counts the owner', async () => {
  const res = await tenantService.create({
    tenant: { name: `Limit ${randomBytes(2).toString('hex')}` },
    owner: { email: `o-${randomBytes(3).toString('hex')}@example.com`, name: 'Owner', password: PASSWORD },
    initialize: true,
    by: 'platform-admin',
  });
  const tenantId = String(res.tenant._id);
  assert.equal(await counter(tenantId, 'members'), 1, 'initialization seeds the owner seat');
  await limitOverride(tenantId, 'members', 2);
  await invitationService.create({ tenantId, email: 'one@example.com', roleName: 'Viewer', invitedBy: 'platform-admin' });
  await assert.rejects(
    () => invitationService.create({ tenantId, email: 'two@example.com', roleName: 'Viewer', invitedBy: 'platform-admin' }),
    (err) => err.code === 'QUOTA_EXCEEDED' && err.details.metric === 'members' && err.details.limit === 2,
  );
  assert.equal(await counter(tenantId, 'members'), 2);
  await assertCountersMatch(tenantId, 'member limit');
});

test('seats: concurrent invitations for the same address take exactly one seat', async () => {
  const res = await tenantService.create({
    tenant: { name: `Race ${randomBytes(2).toString('hex')}` },
    owner: { email: `o-${randomBytes(3).toString('hex')}@example.com`, name: 'Owner', password: PASSWORD },
    initialize: true,
    by: 'platform-admin',
  });
  const tenantId = String(res.tenant._id);
  await Promise.allSettled(Array.from({ length: 5 }, () => invitationService.create({
    tenantId, email: 'same@example.com', roleName: 'Viewer', invitedBy: 'platform-admin',
  })));
  assert.equal(await counter(tenantId, 'members'), 2, 'owner + one pending invitee');
  await assertCountersMatch(tenantId, 'concurrent invites');
});

test('storedRows: webhook-delivered records persisted by the sync worker are metered too', async () => {
  const tenantId = await makeTenant('starter');
  const c = await connectorService.createConnectorRecord({
    tenantId, type: 'webhook', name: 'Events', config: { signingSecret: 'quota-test-signing-secret-0001' }, fieldMapping: { id: 'id' },
  });
  const job = (records) => ({ data: { connectorId: String(c._id), tenantId, jobType: 'ingest', payload: { records } } });
  await connectorService.processSyncMessage(job([{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }]));
  assert.equal(await counter(tenantId, 'storedRows'), 3);
  await connectorService.processSyncMessage(job([{ id: 'e3' }, { id: 'e4' }]));
  assert.equal(await counter(tenantId, 'storedRows'), 4);
  await assertCountersMatch(tenantId, 'webhook records');
});

test('storedRows: a job that reserved its rows up front is settled by its reservation, not metered twice', async () => {
  const tenantId = await makeTenant('starter');
  const c = await connectorService.createConnectorRecord({
    tenantId, type: 'webhook', name: 'Reserved', config: { signingSecret: 'quota-test-signing-secret-0002' }, fieldMapping: { id: 'id' },
  });
  // The request path reserved 2 rows (usageService.checkAndConsume) and
  // passes the reservation along; the worker must not consume again.
  await usageService.checkAndConsume({ tenantId, metric: 'storedRows', requested: 2 });
  await connectorService.processSyncMessage({
    data: { connectorId: String(c._id), tenantId, jobType: 'ingest', payload: { records: [{ id: 'r1' }, { id: 'r2' }], reservedRows: 2 } },
  });
  assert.equal(await counter(tenantId, 'storedRows'), 2);
  await assertCountersMatch(tenantId, 'reserved webhook job');
});

/* ------------------- reserved webhook deliveries (ledger) ------------------ */

function webhookConnector(tenantId, name = 'Ledger') {
  return connectorService.createConnectorRecord({
    tenantId, type: 'webhook', name, config: { signingSecret: `quota-test-signing-secret-${randomBytes(4).toString('hex')}` }, fieldMapping: { id: 'id' },
  });
}

/** A webhook delivery as handleWebhook enqueues it (reservation in the ledger under the job id). */
function reservedDelivery(tenantId, connectorId, key, records, attempt = { attemptsMade: 0, attempts: 3 }) {
  return {
    id: key,
    ...attempt,
    data: { connectorId: String(connectorId), tenantId, jobType: 'ingest', payload: { records, reservedRows: records.length, reservationKey: key, source: 'webhook' } },
  };
}

/** Make the first `failures` bulk writes fail after storing `partial` rows of the batch. */
function failWrites(t, { failures = 1, partial = 0 } = {}) {
  const original = connectorRowRepository.upsertRows;
  let calls = 0;
  connectorRowRepository.upsertRows = async (connectorId, tenantId, rows) => {
    calls += 1;
    if (calls <= failures) {
      const stored = partial > 0 ? await original(connectorId, tenantId, rows.slice(0, partial)) : { upserted: 0 };
      throw Object.assign(new Error('bulk write interrupted'), { result: { upsertedCount: stored.upserted } });
    }
    return original(connectorId, tenantId, rows);
  };
  t.after(() => { connectorRowRepository.upsertRows = original; });
}

test('storedRows: a reserved delivery retried after a failed write keeps the counter equal to the rows stored', async (t) => {
  const tenantId = await makeTenant('starter');
  await limitOverride(tenantId, 'storedRows', 6);
  const c = await webhookConnector(tenantId);
  const key = `webhook-${c._id}-retry`;
  const records = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  await usageService.reserve({ tenantId, key, connectorId: String(c._id), requested: records.length });
  assert.equal(await counter(tenantId, 'storedRows'), 4, 'reserved at request time');

  // Attempt 1 of 3 fails with nothing stored: the drawn rows go back to the
  // reservation (not to the plan), so the retry draws them again.
  failWrites(t, { failures: 1 });
  await assert.rejects(() => connectorService.processSyncMessage(reservedDelivery(tenantId, c._id, key, records)), /bulk write interrupted/);
  assert.equal(await ConnectorRow.countDocuments({ tenantId }), 0);
  assert.equal(await counter(tenantId, 'storedRows'), 4, 'the reservation still holds the unstored rows');
  assert.equal((await usageReservationRepository.findOne({ tenantId, metric: 'storedRows', key })).remaining, 4);

  const retried = await connectorService.processSyncMessage(reservedDelivery(tenantId, c._id, key, records, { attemptsMade: 1, attempts: 3 }));
  assert.equal(retried.upserted, 4);
  assert.equal(await ConnectorRow.countDocuments({ tenantId }), 4);
  assert.equal(await counter(tenantId, 'storedRows'), 4, 'counter equals the rows stored');
  const settled = await usageReservationRepository.findOne({ tenantId, metric: 'storedRows', key });
  assert.equal(settled.remaining, 0);
  assert.ok(settled.settledAt, 'the reservation is settled once the message is done');
  await assertCountersMatch(tenantId, 'retried reserved delivery');
  // Only 2 of the 6 remain: the retry did not let the tenant pass the limit.
  await assert.rejects(
    () => usageService.checkAndConsume({ tenantId, metric: 'storedRows', requested: 3 }),
    (err) => err.code === 'QUOTA_EXCEEDED',
  );
});

test('storedRows: rows a failed attempt did store are not drawn again by the retry (partial write)', async (t) => {
  const tenantId = await makeTenant('starter');
  const c = await webhookConnector(tenantId);
  const key = `webhook-${c._id}-partial`;
  const records = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }];
  await usageService.reserve({ tenantId, key, connectorId: String(c._id), requested: records.length });

  // Attempt 1 stores 2 of the 4 rows, then the bulk write fails.
  failWrites(t, { failures: 1, partial: 2 });
  await assert.rejects(() => connectorService.processSyncMessage(reservedDelivery(tenantId, c._id, key, records)), /bulk write interrupted/);
  assert.equal(await ConnectorRow.countDocuments({ tenantId }), 2);
  assert.equal(await counter(tenantId, 'storedRows'), 4);
  assert.equal((await usageReservationRepository.findOne({ tenantId, metric: 'storedRows', key })).remaining, 2, 'only the unstored rows stay reserved');

  const retried = await connectorService.processSyncMessage(reservedDelivery(tenantId, c._id, key, records, { attemptsMade: 1, attempts: 3 }));
  assert.equal(retried.upserted, 2);
  assert.equal(retried.matched, 2);
  assert.equal(await counter(tenantId, 'storedRows'), 4);
  await assertCountersMatch(tenantId, 'partially written reserved delivery');
});

test('storedRows: an in-message reservation (no ledger key) retried after a failed write is not given back early', async (t) => {
  const tenantId = await makeTenant('starter');
  const c = await webhookConnector(tenantId);
  const records = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }, { id: 'm4' }];
  const job = (attemptsMade) => ({
    id: `legacy-${c._id}`,
    attemptsMade,
    attempts: 3,
    data: { connectorId: String(c._id), tenantId, jobType: 'ingest', payload: { records, reservedRows: 4, source: 'webhook' } },
  });
  await usageService.checkAndConsume({ tenantId, metric: 'storedRows', requested: 4 });
  failWrites(t, { failures: 1 });
  await assert.rejects(() => connectorService.processSyncMessage(job(0)), /bulk write interrupted/);
  assert.equal(await counter(tenantId, 'storedRows'), 4, 'nothing released before the retry');
  await connectorService.processSyncMessage(job(1));
  assert.equal(await ConnectorRow.countDocuments({ tenantId }), 4);
  assert.equal(await counter(tenantId, 'storedRows'), 4);
  await assertCountersMatch(tenantId, 'retried in-message reservation');
});

test('reconcile counts open webhook reservations as in use, skips while one is being drawn, and voids stale ones', async () => {
  const tenantId = await makeTenant('starter');
  const c = await webhookConnector(tenantId);
  const connectorId = String(c._id);
  const key = `webhook-${connectorId}-queued`;
  await usageService.reserve({ tenantId, key, connectorId, requested: 3 });

  // The delivery waits in the queue long past the settle window, and
  // nothing else touches the counter: the reservation is still in use.
  const longAgo = new Date(Date.now() - 60 * 60 * 1000);
  await UsageCounter.updateOne({ tenantId, metric: 'storedRows', period: 'current' }, { $set: { lastIncrementedAt: longAgo } });
  await UsageReservation.updateOne({ tenantId, key }, { $set: { updatedAt: longAgo } }, { timestamps: false });
  const waiting = await usageService.reconcile({ tenantId, dryRun: false, settleMs: 120_000 });
  const stored = waiting.metrics.find((m) => m.metric === 'storedRows');
  assert.deepEqual(
    { recorded: stored.recorded, actual: stored.actual, reserved: stored.reserved, drift: stored.drift, action: stored.action },
    { recorded: 3, actual: 3, reserved: 3, drift: 0, action: 'none' },
  );
  assert.equal(await counter(tenantId, 'storedRows'), 3, 'the reservation is not erased');

  // A worker drew on it and has not written the rows yet: the metric is in
  // flight, so reconciliation leaves it alone.
  assert.equal(await usageReservationRepository.draw({ tenantId, metric: 'storedRows', key, max: 1 }), 1);
  const drawing = await usageService.reconcile({ tenantId, dryRun: false, settleMs: 120_000 });
  assert.equal(drawing.metrics.find((m) => m.metric === 'storedRows').action, 'skipped_recent_activity');
  assert.equal(await counter(tenantId, 'storedRows'), 3);
  await usageReservationRepository.giveBack({ tenantId, metric: 'storedRows', key, amount: 1 });

  // The worker stores the rows: exact, with or without the earlier reconcile.
  const result = await connectorService.processSyncMessage(reservedDelivery(tenantId, connectorId, key, [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }]));
  assert.equal(result.upserted, 3);
  assert.equal(await counter(tenantId, 'storedRows'), 3);
  await assertCountersMatch(tenantId, 'queued reserved delivery');

  // A delivery whose message was lost: past its TTL the reservation no
  // longer counts; applying voids it and gives the capacity back.
  const lostKey = `webhook-${connectorId}-lost`;
  const reservedAt = new Date(Date.now() - (env.usage.reservationTtlHours + 1) * 60 * 60 * 1000);
  await usageService.reserve({ tenantId, key: lostKey, connectorId, requested: 2, now: reservedAt });
  // Long after: the first delivery's settlement is no longer recent either.
  await UsageCounter.updateOne({ tenantId, metric: 'storedRows', period: 'current' }, { $set: { lastIncrementedAt: longAgo } });
  await UsageReservation.updateMany({ tenantId }, { $set: { updatedAt: longAgo } }, { timestamps: false });
  assert.equal(await counter(tenantId, 'storedRows'), 5);
  const dry = await usageService.reconcile({ tenantId, settleMs: 120_000 });
  assert.equal(dry.metrics.find((m) => m.metric === 'storedRows').action, 'would_correct');
  assert.equal((await usageReservationRepository.findOne({ tenantId, metric: 'storedRows', key: lostKey })).settledAt, null, 'a dry run voids nothing');
  const applied = await usageService.reconcile({ tenantId, dryRun: false, settleMs: 120_000 });
  assert.equal(applied.metrics.find((m) => m.metric === 'storedRows').action, 'corrected');
  assert.equal(await counter(tenantId, 'storedRows'), 3);
  const voided = await usageReservationRepository.findOne({ tenantId, metric: 'storedRows', key: lostKey });
  assert.ok(voided.voidedAt && voided.settledAt);
  assert.equal(voided.remaining, 0);

  // If the lost message turns up after all, it draws nothing and its rows
  // are metered against the plan instead (no uncounted rows).
  await connectorService.processSyncMessage(reservedDelivery(tenantId, connectorId, lostKey, [{ id: 'l1' }, { id: 'l2' }]));
  assert.equal(await counter(tenantId, 'storedRows'), 5);
  await assertCountersMatch(tenantId, 'late lost delivery');
});

test('reserve and cancelReservation: the ledger entry and the counter move together; cancel is idempotent', async () => {
  const tenantId = await makeTenant('starter');
  await limitOverride(tenantId, 'storedRows', 3);
  const c = await webhookConnector(tenantId);
  const key = `webhook-${c._id}-cancel`;
  await assert.rejects(
    () => usageService.reserve({ tenantId, key, connectorId: String(c._id), requested: 4 }),
    (err) => err.code === 'QUOTA_EXCEEDED',
  );
  assert.equal(await usageReservationRepository.findOne({ tenantId, metric: 'storedRows', key }), null, 'a refused reservation records nothing');
  await usageService.reserve({ tenantId, key, connectorId: String(c._id), requested: 3 });
  // A second reservation under the same key is refused and gives its capacity back.
  await usageService.release({ tenantId, metric: 'storedRows', requested: 1 });
  await assert.rejects(() => usageService.reserve({ tenantId, key, connectorId: String(c._id), requested: 1 }));
  assert.equal(await counter(tenantId, 'storedRows'), 2);
  await usageService.checkAndConsume({ tenantId, metric: 'storedRows', requested: 1 });
  assert.equal(await usageService.cancelReservation({ tenantId, key }), 3);
  assert.equal(await usageService.cancelReservation({ tenantId, key }), 0);
  assert.equal(await counter(tenantId, 'storedRows'), 0);
  await assert.rejects(() => usageService.reserve({ tenantId, key: 'k', requested: 0 }), (err) => err.statusCode === 400);
  await assert.rejects(() => usageService.reserve({ tenantId, requested: 1 }), (err) => err.statusCode === 400);
  await assert.rejects(() => usageService.reserve({ tenantId, key: 'k', metric: 'apiCallsPerDay', requested: 1 }), (err) => err.statusCode === 400);
});

test('a driver error that only carries a quota code is not treated as a plan refusal (generic message, retried)', async (t) => {
  const tenantId = await makeTenant('starter');
  const c = await csvConnector(tenantId);
  const original = connectorRowRepository.upsertRows;
  connectorRowRepository.upsertRows = async () => {
    throw Object.assign(new Error('quota exceeded on mongodb://admin:hunter2@10.1.2.3:27017'), { code: 'QUOTA_EXCEEDED' });
  };
  t.after(() => { connectorRowRepository.upsertRows = original; });
  const job = { ...csvJob(tenantId, c._id, 'id,amount\n1,10\n'), id: 'driver-code', attemptsMade: 0, attempts: 3 };
  await assert.rejects(() => connectorService.processSyncMessage(job), (err) => err.code === 'QUOTA_EXCEEDED');
  const run = await SyncRun.findOne({ tenantId, connectorId: String(c._id) }).lean();
  assert.equal(run.status, 'retrying', 'not permanent: the queue retries it');
  assert.equal(run.error.code, 'CONNECTOR_SYNC_FAILED');
  const connector = await Connector.findById(c._id).lean();
  for (const text of [run.error.message, connector.lastError]) {
    assert.doesNotMatch(String(text), /hunter2|10\.1\.2\.3|mongodb:\/\//);
  }
  assert.equal(await counter(tenantId, 'storedRows'), 0, 'the failed write took nothing');
});

test('release ignores invalid amounts instead of guessing one', async () => {
  const tenantId = await makeTenant('starter');
  await usageCounterRepository.setToActual({ tenantId, metric: 'dashboards', value: 3 });
  for (const requested of [-2, 1.5, Number.NaN, '2', 0]) {
    await usageService.release({ tenantId, metric: 'dashboards', requested });
  }
  assert.equal(await counter(tenantId, 'dashboards'), 3);
  // Unknown metrics and metered metrics are never released.
  assert.deepEqual(await usageService.release({ tenantId, metric: 'nope' }), { value: 0 });
  assert.deepEqual(await usageService.release({ tenantId, metric: 'apiCallsPerDay' }), { value: 0 });
});

test('metered consumption without a hard limit still lands in the day row and expires', async () => {
  const tenantId = await makeTenant('enterprise'); // apiCallsPerDay soft
  const now = new Date('2026-05-02T08:00:00.000Z');
  const r = await usageService.checkAndConsume({ tenantId, metric: 'apiCallsPerDay', requested: 3, now });
  assert.equal(r.hard, false);
  const row = await usageCounterRepository.findOne(tenantId, 'apiCallsPerDay', '2026-05-02');
  assert.equal(row.value, 3);
  assert.equal(row.kind, 'cumulative');
  assert.ok(row.expiresAt, 'metered rows carry their expiry');
  assert.equal(await counter(tenantId, 'apiCallsPerDay'), 0, 'nothing is written to the current row');
});
