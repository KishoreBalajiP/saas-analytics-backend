/**
 * Durable jobs (roadmap 1.4): atomic scheduler claims + tenant suspension
 * (roadmap 1.6, scheduler side).
 *
 * Exit criteria covered here:
 *   - two scheduler instances running concurrently against the same database
 *     execute each due report and each due alert exactly once per tick;
 *   - suspended tenants' schedules are skipped (and re-checked at execution
 *     time for queued report jobs).
 *
 * "Two instances" are two concurrent scans with distinct claim owners, as two
 * processes would run them: each scan reads the due candidates and races the
 * other one on the same documents.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { shortToken } from '../../src/utils/id.js';
import * as tenantService from '../../src/services/tenant.service.js';
import * as tenantLifecycle from '../../src/services/tenantLifecycle.service.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import connectorRepository from '../../src/repositories/connector.repository.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import { AlertEvent } from '../../src/models/AlertEvent.js';
import * as alertService from '../../src/services/alert.service.js';
import alertRepository from '../../src/repositories/alert.repository.js';
import * as reportService from '../../src/services/report.service.js';
import reportRepository from '../../src/repositories/report.repository.js';
import { Report } from '../../src/models/Report.js';
import { AlertRule } from '../../src/models/AlertRule.js';
import * as queueService from '../../src/services/queue.service.js';
import { registerAnalyticsWorker } from '../../src/jobs/analytics.worker.js';
import { runJob, resetSchedulerForTests } from '../../src/jobs/scheduler.js';
import reportScheduleJob from '../../src/jobs/reportSchedule.job.js';
import alertEvalJob from '../../src/jobs/alertEval.job.js';
import { JobRun } from '../../src/models/JobRun.js';
// billing: tenants exercising paid features need a plan that includes them.
import { entitleTenant } from '../helpers/billing.js';

const PASSWORD = 'Password123!';
const PAST = () => new Date(Date.now() - 120000);

before(async () => { await startMongo(); });
beforeEach(async () => { await resetMongo(); await rbacCache.clearAll(); });
after(async () => {
  await queueService.closeAll();
  await stopMongo();
});

async function onboard() {
  const owner = { email: `owner-${shortToken(10).toLowerCase()}@example.com`, name: 'Owner', password: PASSWORD };
  const { tenant } = await tenantService.create({ tenant: { name: `Claims ${shortToken(10)}` }, owner, initialize: true, by: 'root' });
  await entitleTenant(tenant._id);
  return { tenantId: tenant._id.toString(), ownerId: tenant.ownerUserId?.toString?.() || null };
}

async function seedDataset(tenantId) {
  const connector = await connectorRepository.create({ tenantId, type: 'csv', name: 'Orders', status: 'active', createdBy: 'u1' });
  await ConnectorRow.insertMany([
    { tenantId, connectorId: connector._id, sourceRowId: 'r1', data: { region: 'EU', amount: 100 }, ingestedAt: new Date('2024-01-02') },
    { tenantId, connectorId: connector._id, sourceRowId: 'r2', data: { region: 'US', amount: 200 }, ingestedAt: new Date('2024-01-03') },
  ]);
  return String(connector._id);
}

async function createDueReports(tenantId, ownerId, datasetId, n) {
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const report = await reportService.create({
      tenantId, actorId: ownerId, name: `Scheduled ${i}`, source: 'query', format: 'csv',
      query: { datasetId }, schedule: { enabled: true, cron: '0 * * * *' },
    });
    await reportRepository.update(report._id, { nextRunAt: PAST() });
    ids.push(String(report._id));
  }
  return ids;
}

async function createDueAlerts(tenantId, ownerId, datasetId, n) {
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const rule = await alertService.createRule({
      tenantId, actorId: ownerId, name: `Rule ${i}`, source: 'query',
      query: { datasetId }, metric: 'count', condition: 'gt', threshold: 1,
      cooldownMinutes: 0, schedule: { cron: '*/5 * * * *' }, enabled: true,
    });
    await alertRepository.updateRule(rule._id, { nextEvaluationAt: PAST() });
    ids.push(String(rule._id));
  }
  return ids;
}

test('two concurrent report scans enqueue each due report exactly once per tick', async () => {
  const { tenantId, ownerId } = await onboard();
  const datasetId = await seedDataset(tenantId);
  const ids = await createDueReports(tenantId, ownerId, datasetId, 4);

  const now = new Date();
  const [a, b] = await Promise.all([
    reportService.runDue({ now, owner: 'instance-a' }),
    reportService.runDue({ now, owner: 'instance-b' }),
  ]);
  // Both instances saw every due report (they really raced)...
  assert.equal(a.scanned, ids.length, JSON.stringify({ a, b }));
  assert.equal(b.scanned, ids.length, JSON.stringify({ a, b }));
  // ...yet each report was enqueued once in total.
  assert.equal(a.enqueued + b.enqueued, ids.length, JSON.stringify({ a, b }));
  assert.equal(a.claimed + b.claimed, ids.length);

  for (const id of ids) {
    const doc = await Report.findById(id).lean();
    assert.equal(doc.runs.length, 1, `report ${id} must have exactly one run`);
    assert.equal(doc.runs[0].triggeredBy, 'schedule');
    assert.ok(doc.nextRunAt > now, 'nextRunAt advanced in the claim');
    assert.equal(doc.lockedBy, null, 'claim released after enqueue');
    assert.equal(doc.lockedUntil, null);
  }

  // Same tick again: nothing is due any more.
  const again = await reportService.runDue({ now, owner: 'instance-c' });
  assert.equal(again.enqueued, 0);
});

test('two scheduler instances ticking the real jobs concurrently run each due report and alert exactly once', async () => {
  resetSchedulerForTests();
  const { tenantId, ownerId } = await onboard();
  const datasetId = await seedDataset(tenantId);
  const reportIds = await createDueReports(tenantId, ownerId, datasetId, 3);
  const alertIds = await createDueAlerts(tenantId, ownerId, datasetId, 3);

  // 1) Normal case: the shared job lock lets one instance run each job and
  //    the other skips the tick.
  const tickAt = new Date();
  const outcomes = await Promise.all([
    runJob(reportScheduleJob, { instanceId: 'instance-a', tickAt }),
    runJob(reportScheduleJob, { instanceId: 'instance-b', tickAt }),
    runJob(alertEvalJob, { instanceId: 'instance-a', tickAt }),
    runJob(alertEvalJob, { instanceId: 'instance-b', tickAt }),
  ]);
  assert.deepEqual(outcomes.map((o) => o.status).sort(), ['skipped', 'skipped', 'succeeded', 'succeeded']);
  for (const id of reportIds) {
    assert.equal((await Report.findById(id).lean()).runs.length, 1, `report ${id} ran once`);
  }
  for (const id of alertIds) {
    assert.equal(await AlertEvent.countDocuments({ alertId: id }), 1, `alert ${id} fired once`);
  }
  assert.equal(await JobRun.countDocuments({ job: 'report-schedule' }), 1);
  assert.equal(await JobRun.countDocuments({ job: 'alert-evaluation' }), 1);
  const reportRun = await JobRun.findOne({ job: 'report-schedule' }).lean();
  assert.equal(reportRun.counts.enqueued, reportIds.length, 'job run records the counts');

  // 2) Lock lapse (a lease that expired mid-tick, split brain): both
  //    instances run the scan at once, and the atomic claims alone still
  //    give each due item to exactly one of them.
  //    (A second workspace keeps the fixtures inside the plan's limits.)
  const second = await onboard();
  const secondDataset = await seedDataset(second.tenantId);
  const freshReports = await createDueReports(second.tenantId, second.ownerId, secondDataset, 3);
  const freshAlerts = await createDueAlerts(second.tenantId, second.ownerId, secondDataset, 3);
  const openLock = { acquire: async () => 'token', renew: async () => true, release: async () => true };
  const lapsed = await Promise.all([
    runJob(reportScheduleJob, { instanceId: 'instance-a', lock: openLock }),
    runJob(reportScheduleJob, { instanceId: 'instance-b', lock: openLock }),
    runJob(alertEvalJob, { instanceId: 'instance-a', lock: openLock }),
    runJob(alertEvalJob, { instanceId: 'instance-b', lock: openLock }),
  ]);
  assert.ok(lapsed.every((o) => o.status === 'succeeded'), JSON.stringify(lapsed));
  for (const id of freshReports) {
    assert.equal((await Report.findById(id).lean()).runs.length, 1, `report ${id} ran once without the lock`);
  }
  for (const id of freshAlerts) {
    assert.equal(await AlertEvent.countDocuments({ alertId: id }), 1, `alert ${id} fired once without the lock`);
  }
});

test('a due report candidate can be claimed by exactly one of two racing owners', async () => {
  const { tenantId, ownerId } = await onboard();
  const datasetId = await seedDataset(tenantId);
  const [id] = await createDueReports(tenantId, ownerId, datasetId, 1);
  const now = new Date();
  const [candidate] = await reportRepository.findByDueSchedule({ now });
  assert.equal(String(candidate._id), id);

  const next = new Date(now.getTime() + 3600000);
  const claims = await Promise.all(['x', 'y', 'z'].map((owner) => reportRepository.claimDueSchedule({
    id, expectedNextRunAt: candidate.nextRunAt, nextRunAt: next, owner, leaseMs: 60000, now,
  })));
  assert.equal(claims.filter(Boolean).length, 1, 'exactly one owner wins the claim');
});

test('a live claim lease blocks other owners until it expires', async () => {
  const { tenantId, ownerId } = await onboard();
  const datasetId = await seedDataset(tenantId);
  const [id] = await createDueReports(tenantId, ownerId, datasetId, 1);
  // Another instance holds a live lease on this (still due) report.
  await Report.updateOne({ _id: id }, { $set: { lockedBy: 'crashed-instance', lockedUntil: new Date(Date.now() + 60000) } });
  const blocked = await reportService.runDue({ now: new Date(), owner: 'instance-a' });
  assert.equal(blocked.enqueued, 0);

  // Its lease expires (the instance died): the next tick takes it over.
  await Report.updateOne({ _id: id }, { $set: { lockedUntil: new Date(Date.now() - 1000) } });
  const taken = await reportService.runDue({ now: new Date(), owner: 'instance-a' });
  assert.equal(taken.enqueued, 1);
});

test('two concurrent alert scans evaluate each due alert exactly once per tick', async () => {
  const { tenantId, ownerId } = await onboard();
  const datasetId = await seedDataset(tenantId);
  const ids = await createDueAlerts(tenantId, ownerId, datasetId, 4);

  const now = new Date();
  const [a, b] = await Promise.all([
    alertService.evaluateDue({ now, owner: 'instance-a' }),
    alertService.evaluateDue({ now, owner: 'instance-b' }),
  ]);
  assert.equal(a.scanned, ids.length, JSON.stringify({ a, b }));
  assert.equal(b.scanned, ids.length, JSON.stringify({ a, b }));
  assert.equal(a.evaluated + b.evaluated, ids.length, JSON.stringify({ a, b }));
  assert.equal(a.triggered + b.triggered, ids.length);

  for (const id of ids) {
    const events = await AlertEvent.countDocuments({ alertId: id });
    assert.equal(events, 1, `alert ${id} must produce exactly one event`);
    const rule = await AlertRule.findById(id).lean();
    assert.ok(rule.nextEvaluationAt > now);
    assert.equal(rule.lockedBy, null);
  }
});

test('an alert whose evaluation throws is not due again until its next slot', async () => {
  const { tenantId, ownerId } = await onboard();
  const datasetId = await seedDataset(tenantId);
  const [id] = await createDueAlerts(tenantId, ownerId, datasetId, 1);
  // Break the rule's source so evaluation throws.
  await AlertRule.updateOne({ _id: id }, { $set: { query: { datasetId: '000000000000000000000000' } } });

  const first = await alertService.evaluateDue({ now: new Date() });
  assert.equal(first.claimed, 1);
  assert.equal(first.failed, 1);
  const rule = await AlertRule.findById(id).lean();
  assert.ok(rule.nextEvaluationAt > new Date(), 'claim advanced the schedule before the failure');
  const second = await alertService.evaluateDue({ now: new Date() });
  assert.equal(second.claimed, 0, 'the failing rule is not retried every tick');
});

test('suspended tenants: due reports and alerts are skipped, schedules move on, and resume after restore', async () => {
  const active = await onboard();
  const suspended = await onboard();
  const activeDataset = await seedDataset(active.tenantId);
  const suspendedDataset = await seedDataset(suspended.tenantId);
  const [activeReport] = await createDueReports(active.tenantId, active.ownerId, activeDataset, 1);
  const [suspendedReport] = await createDueReports(suspended.tenantId, suspended.ownerId, suspendedDataset, 1);
  const [activeAlert] = await createDueAlerts(active.tenantId, active.ownerId, activeDataset, 1);
  const [suspendedAlert] = await createDueAlerts(suspended.tenantId, suspended.ownerId, suspendedDataset, 1);

  await tenantLifecycle.suspend({ tenantId: suspended.tenantId, reason: 'non-payment', by: null });

  const now = new Date();
  const reports = await reportService.runDue({ now });
  assert.equal(reports.enqueued, 1);
  assert.equal(reports.skippedInactive, 1);
  assert.equal((await Report.findById(activeReport).lean()).runs.length, 1);
  const skippedReport = await Report.findById(suspendedReport).lean();
  assert.equal(skippedReport.runs.length, 0, 'no run for a suspended tenant');
  assert.ok(skippedReport.nextRunAt > now, 'the suspended schedule moved on (no backlog burst later)');

  const alerts = await alertService.evaluateDue({ now });
  assert.equal(alerts.evaluated, 1);
  assert.equal(alerts.skippedInactive, 1);
  assert.equal(await AlertEvent.countDocuments({ alertId: activeAlert }), 1);
  assert.equal(await AlertEvent.countDocuments({ alertId: suspendedAlert }), 0, 'no alert event for a suspended tenant');

  // Restored: the next due tick runs again.
  await tenantLifecycle.restore({ tenantId: suspended.tenantId, reason: 'paid', by: null });
  await reportRepository.update(suspendedReport, { nextRunAt: PAST() });
  await alertRepository.updateRule(suspendedAlert, { nextEvaluationAt: PAST() });
  const resumedReports = await reportService.runDue({ now: new Date() });
  assert.equal(resumedReports.enqueued, 1);
  const resumedAlerts = await alertService.evaluateDue({ now: new Date() });
  assert.equal(resumedAlerts.evaluated, 1);
});

test('a report run queued before suspension is skipped at execution time', async () => {
  const { tenantId, ownerId } = await onboard();
  const datasetId = await seedDataset(tenantId);
  const report = await reportService.create({
    tenantId, actorId: ownerId, name: 'Queued', source: 'query', format: 'csv', query: { datasetId },
  });
  // Enqueue while active (no consumer yet), then suspend, then start the worker.
  const { runId } = await reportService.run({ tenantId, reportId: String(report._id), triggeredBy: 'schedule' });
  await tenantLifecycle.suspend({ tenantId, reason: 'abuse', by: null });
  registerAnalyticsWorker();

  const deadline = Date.now() + 5000;
  let run = null;
  while (Date.now() < deadline) {
    const doc = await Report.findById(report._id).lean();
    run = doc.runs.find((r) => String(r._id) === runId);
    if (run?.status === 'failed' || run?.status === 'ready') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(run?.status, 'failed', 'the queued run must not generate an artefact');
  assert.match(run.error, /workspace is not active/);
  assert.equal(run.resultKey, null);
});

// Kept last in this file: it closes the cached analytics queue handle.
test('a scheduled report whose job the queue refuses is marked failed, not left pending', async () => {
  const { tenantId, ownerId } = await onboard();
  const datasetId = await seedDataset(tenantId);
  const [id] = await createDueReports(tenantId, ownerId, datasetId, 1);
  const { QUEUE_NAMES } = await import('../../src/queues/constants.js');
  // A queue that no longer accepts jobs (Redis outage): enqueue -> typed 503.
  await queueService.getQueue(QUEUE_NAMES.ANALYTICS_JOBS).close();

  const now = new Date();
  const outcome = await reportService.runDue({ now, owner: 'instance-a' });
  assert.equal(outcome.claimed, 1);
  assert.equal(outcome.enqueued, 0);
  assert.equal(outcome.failed, 1);
  const doc = await Report.findById(id).lean();
  assert.equal(doc.runs.length, 1);
  assert.equal(doc.runs[0].status, 'failed');
  assert.match(doc.runs[0].error, /could not be queued/);
  assert.ok(doc.nextRunAt > now, 'the schedule still moved on (no retry storm every tick)');
  assert.equal(doc.lockedBy, null);

  await assert.rejects(
    () => reportService.run({ tenantId, reportId: id, triggeredBy: 'manual' }),
    (err) => err.code === 'QUEUE_UNAVAILABLE' && err.statusCode === 503,
  );
  await queueService.closeAll();
});
