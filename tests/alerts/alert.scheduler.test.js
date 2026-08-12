/**
 * Service-level tests for the scheduled alert-evaluation + report-generation
 * jobs (Sprint 7). These exercise the same `evaluateDue` / `runDue` entry points
 * that the per-minute cron jobs invoke, proving the existing scheduler fans
 * out correctly to the real engine, dedups via cooldown, and advances
 * next-run timestamps.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { shortToken } from '../../src/utils/id.js';
import * as tenantService from '../../src/services/tenant.service.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import connectorRepository from '../../src/repositories/connector.repository.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import * as alertService from '../../src/services/alert.service.js';
import alertRepository from '../../src/repositories/alert.repository.js';
import * as reportService from '../../src/services/report.service.js';
import reportRepository from '../../src/repositories/report.repository.js';

const PASSWORD = 'Password123!';

before(async () => { await startMongo(); });
beforeEach(async () => { await resetMongo(); await rbacCache.clearAll(); });
after(async () => { await stopMongo(); });

async function onboard() {
  const ownerEmail = `owner-${shortToken(10).toLowerCase()}@example.com`;
  const owner = { email: ownerEmail, name: 'Owner', password: PASSWORD };
  const { tenant } = await tenantService.create({ tenant: { name: `Sched ${shortToken(10)}` }, owner, initialize: true, by: 'root' });
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

test('scheduler.evaluateDue fires due alerts, creates events, and cooldown-dedupes', async () => {
  const { tenantId, ownerId } = await onboard();
  const datasetId = await seedDataset(tenantId);

  const rule = await alertService.createRule({
    tenantId, actorId: ownerId, name: 'Sched High', source: 'query',
    query: { datasetId }, metric: 'count', condition: 'gt', threshold: 1,
    cooldownMinutes: 60, schedule: { cron: '*/5 * * * *' }, enabled: true,
  });
  await alertRepository.updateRule(rule._id, { nextEvaluationAt: new Date(Date.now() - 120000) });

  const first = await alertService.evaluateDue({ now: new Date() });
  assert.ok(first.evaluated >= 1, JSON.stringify(first));
  assert.ok(first.triggered >= 1, JSON.stringify(first));

  const events1 = await alertRepository.listEvents({ tenantId, alertId: rule._id });
  assert.equal(events1.docs.length, 1);

  const second = await alertService.evaluateDue({ now: new Date() });
  assert.equal(second.triggered, 0, 'immediate second pass must be suppressed by cooldown');
  const events2 = await alertRepository.listEvents({ tenantId, alertId: rule._id });
  assert.equal(events2.docs.length, 1, 'cooldown prevents duplicate events');
});

test('scheduler.runDue enqueues due reports and advances nextRunAt', async () => {
  const { tenantId, ownerId } = await onboard();
  const datasetId = await seedDataset(tenantId);

  const report = await reportService.create({
    tenantId, actorId: ownerId, name: 'Nightly', source: 'query', format: 'csv',
    query: { datasetId }, schedule: { enabled: true, cron: '0 * * * *' },
  });
  await reportRepository.update(report._id, { 'schedule.enabled': true, nextRunAt: new Date(Date.now() - 120000) });

  const res = await reportService.runDue({ now: new Date() });
  assert.ok(res.scanned >= 1, JSON.stringify(res));
  assert.ok(res.enqueued >= 1, JSON.stringify(res));

  const refreshed = await reportRepository.findById(report._id, { tenantId });
  assert.ok(new Date(refreshed.nextRunAt).getTime() > Date.now(), 'nextRunAt should advance into the future');
});

test('scheduler skips disabled alerts (never triggers via schedule)', async () => {
  const { tenantId, ownerId } = await onboard();
  const datasetId = await seedDataset(tenantId);

  const rule = await alertService.createRule({
    tenantId, actorId: ownerId, name: 'Sched Disabled', source: 'query',
    query: { datasetId }, metric: 'count', condition: 'gt', threshold: 1,
    schedule: { cron: '*/5 * * * *' }, enabled: false,
  });
  await alertRepository.updateRule(rule._id, { nextEvaluationAt: new Date(Date.now() - 120000) });

  const res = await alertService.evaluateDue({ now: new Date() });
  assert.equal(res.triggered, 0, 'disabled rules must never trigger');
  const events = await alertRepository.listEvents({ tenantId, alertId: rule._id });
  assert.equal(events.docs.length, 0, 'no event should be recorded for a disabled alert');
});

test('alert re-triggers after cooldown expires (persisted state)', async () => {
  const { tenantId, ownerId } = await onboard();
  const datasetId = await seedDataset(tenantId);

  const rule = await alertService.createRule({
    tenantId, actorId: ownerId, name: 'Cooldown Re-trigger', source: 'query',
    query: { datasetId }, metric: 'count', condition: 'gt', threshold: 1,
    cooldownMinutes: 60, schedule: { cron: '*/5 * * * *' }, enabled: true,
  });

  const first = await alertService.evaluate({ tenantId, alertId: String(rule._id) });
  assert.equal(first.triggered, true);

  // Simulate the cooldown having elapsed by pushing lastTriggeredAt into the past.
  await alertRepository.updateRule(rule._id, { lastTriggeredAt: new Date(Date.now() - 120 * 60000) });

  const again = await alertService.evaluate({ tenantId, alertId: String(rule._id) });
  assert.equal(again.triggered, true, 'alert must re-trigger once the cooldown has expired');
  const events = await alertRepository.listEvents({ tenantId, alertId: rule._id });
  assert.equal(events.docs.length, 2, 'a second distinct event should be recorded after cooldown');
});
