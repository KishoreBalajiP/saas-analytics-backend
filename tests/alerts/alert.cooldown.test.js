/**
 * Alert cooldown (roadmap 1.5, finding ana.07), on a fixed clock:
 *
 *   - a suppressed (cooldown) evaluation still advances `nextEvaluationAt`
 *     to the next cron slot and is recorded (`lastEvaluation`, a
 *     `suppressed` event), without notifying;
 *   - the scheduler therefore evaluates a firing rule once per cron slot
 *     during the cooldown (never every minute), and the rule triggers again
 *     exactly when the cooldown has elapsed;
 *   - concurrent evaluations of a firing rule trigger and notify exactly
 *     once (atomic trigger claim): no notification storm;
 *   - not-met and failed evaluations advance the schedule too.
 */

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useMongo, resetMongo } from '../helpers/index.js';
import { factories } from '../helpers/factories.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import { AlertEvent } from '../../src/models/AlertEvent.js';
import { Notification } from '../../src/models/Notification.js';
import connectorRepository from '../../src/repositories/connector.repository.js';
import alertRepository from '../../src/repositories/alert.repository.js';
import * as alertService from '../../src/services/alert.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import clock from '../../src/utils/clock.js';
// billing: tenants exercising paid features need a plan that includes them.
import { entitleTenant } from '../helpers/billing.js';

useMongo();

const T0 = new Date('2026-03-01T12:00:00Z');
const at = (minutes) => new Date(T0.getTime() + minutes * 60_000);
const iso = (d) => new Date(d).toISOString();

let tenantId;
let datasetId;

beforeEach(async () => {
  await resetMongo();
  await cacheService.flushAll();
  clock.set(T0);
  tenantId = String((await factories.tenant.create({ status: 'active' }))._id);
  await entitleTenant(tenantId);
  const connector = await connectorRepository.create({ tenantId, type: 'csv', name: 'Orders', status: 'active' });
  datasetId = String(connector._id);
  await ConnectorRow.insertMany([
    { tenantId, connectorId: connector._id, sourceRowId: 'r1', data: { amount: '10' } },
    { tenantId, connectorId: connector._id, sourceRowId: 'r2', data: { amount: '20' } },
  ]);
});

afterEach(() => clock.reset());

function firingRule(extra = {}) {
  return alertService.createRule({
    tenantId, actorId: 'owner-1', name: 'Always firing', source: 'query', query: { datasetId },
    metric: 'count', condition: 'gt', threshold: 0, cooldownMinutes: 60, schedule: { cron: '*/5 * * * *', timezone: 'UTC' },
    ...extra,
  });
}

async function scanAt(minutes) {
  clock.set(at(minutes));
  return alertService.evaluateDue({ now: at(minutes) });
}

const events = async (status) => AlertEvent.countDocuments({ tenantId, ...(status ? { status } : {}) });
const notifications = async () => Notification.countDocuments({ tenantId });

test('a suppressed evaluation advances nextEvaluationAt, is recorded, and never notifies', async () => {
  const rule = await firingRule();
  const id = String(rule._id);

  const first = await scanAt(0);
  assert.equal(first.triggered, 1);
  let stored = await alertService.getById({ tenantId, alertId: id });
  assert.equal(iso(stored.nextEvaluationAt), iso(at(5)));
  assert.equal(stored.lastEvaluation.outcome, 'triggered');
  assert.equal(await notifications(), 1);

  // Not due again within the slot: nothing runs.
  for (const minute of [1, 2, 3, 4]) {
    assert.equal((await scanAt(minute)).scanned, 0, `minute ${minute}`);
  }

  const second = await scanAt(5);
  assert.equal(second.evaluated, 1);
  assert.equal(second.triggered, 0);
  assert.equal(second.suppressed, 1);
  stored = await alertService.getById({ tenantId, alertId: id });
  assert.equal(iso(stored.nextEvaluationAt), iso(at(10)), 'the next evaluation moved to the next cron slot');
  assert.equal(iso(stored.lastEvaluatedAt), iso(at(5)));
  assert.equal(stored.lastEvaluation.outcome, 'suppressed');
  assert.equal(stored.lastEvaluation.value, 2);
  assert.equal(iso(stored.lastTriggeredAt), iso(at(0)), 'a suppression does not restart the cooldown');
  assert.equal(await events('triggered'), 1);
  assert.equal(await events('suppressed'), 1);
  assert.equal(await notifications(), 1, 'no notification while cooling down');

  const [suppressedEvent] = (await alertRepository.listEvents({ tenantId, alertId: rule._id })).docs.filter((e) => e.status === 'suppressed');
  assert.equal(iso(suppressedEvent.triggeredAt), iso(at(5)));
  assert.match(suppressedEvent.message, /suppressed \(cooldown 60 min\)/);
});

test('during the cooldown a firing rule is evaluated once per cron slot and re-triggers when it ends', async () => {
  const rule = await firingRule();
  let evaluations = 0;
  for (let minute = 0; minute < 60; minute += 1) {
    const scan = await scanAt(minute);
    evaluations += scan.evaluated;
    if (minute > 0) assert.equal(scan.triggered, 0, `minute ${minute}: no re-trigger inside the cooldown`);
  }
  assert.equal(evaluations, 12, 'one evaluation per 5-minute slot, not one per minute');
  assert.equal(await events('triggered'), 1);
  assert.equal(await events('suppressed'), 11);
  assert.equal(await notifications(), 1);

  // 60 minutes after the first trigger the cooldown has elapsed.
  const again = await scanAt(60);
  assert.equal(again.triggered, 1);
  assert.equal(await events('triggered'), 2);
  assert.equal(await notifications(), 2);
  const stored = await alertService.getById({ tenantId, alertId: String(rule._id) });
  assert.equal(iso(stored.lastTriggeredAt), iso(at(60)));
  assert.equal(iso(stored.nextEvaluationAt), iso(at(65)));
});

test('concurrent evaluations of a firing rule trigger and notify exactly once', async () => {
  const rule = await firingRule();
  const results = await Promise.all(Array.from({ length: 6 }, () => alertService.evaluate({ tenantId, alertId: String(rule._id) })));
  assert.equal(results.filter((r) => r.triggered).length, 1, 'one winner');
  assert.equal(results.filter((r) => r.suppressed).length, 5, 'the others are recorded as suppressed');
  assert.equal(await events('triggered'), 1);
  assert.equal(await notifications(), 1, 'no notification storm');
});

test('a zero cooldown triggers on every evaluation; manual suppressed evaluations also advance the schedule', async () => {
  const noCooldown = await firingRule({ name: 'No cooldown', cooldownMinutes: 0 });
  assert.equal((await alertService.evaluate({ tenantId, alertId: String(noCooldown._id) })).triggered, true);
  assert.equal((await alertService.evaluate({ tenantId, alertId: String(noCooldown._id) })).triggered, true);

  const rule = await firingRule({ name: 'Manual' });
  await alertService.evaluate({ tenantId, alertId: String(rule._id) });
  clock.set(at(7));
  const manual = await alertService.evaluate({ tenantId, alertId: String(rule._id) });
  assert.equal(manual.suppressed, true);
  assert.equal(manual.outcome, 'suppressed');
  assert.equal(manual.event.status, 'suppressed');
  const stored = await alertService.getById({ tenantId, alertId: String(rule._id) });
  assert.equal(iso(stored.nextEvaluationAt), iso(at(10)));
});

test('not-met and failed evaluations advance the schedule and record the outcome', async () => {
  const quiet = await firingRule({ name: 'Quiet', threshold: 100 });
  const scan = await scanAt(0);
  assert.equal(scan.evaluated, 1);
  let stored = await alertService.getById({ tenantId, alertId: String(quiet._id) });
  assert.equal(stored.lastEvaluation.outcome, 'not_met');
  assert.equal(iso(stored.nextEvaluationAt), iso(at(5)));
  assert.equal(await events(), 0);

  // The dataset is gone: the evaluation fails, says why, and moves on.
  await alertRepository.updateRule(String(quiet._id), { query: { datasetId: '0123456789abcdef01234567' } });
  const failed = await scanAt(5);
  assert.equal(failed.failed, 1);
  stored = await alertService.getById({ tenantId, alertId: String(quiet._id) });
  assert.equal(stored.lastEvaluation.outcome, 'failed');
  assert.match(stored.lastEvaluation.error, /dataset/);
  assert.equal(iso(stored.nextEvaluationAt), iso(at(10)));
});
