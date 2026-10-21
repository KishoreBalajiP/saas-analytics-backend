/**
 * Metered usage, reconciliation and the tenant usage API (roadmap 1.3;
 * findings api.10, bil.08, bil.07, db.02).
 *
 *   - every authenticated external API call counts toward the per-day
 *     `apiCallsPerDay` counter, the limit is enforced per UTC day (fixed
 *     clock), key creation consumes nothing, tenants are isolated
 *   - reconcile() fixes deliberately corrupted counters: dry run reports,
 *     apply writes; settle window and compare-and-set protect live traffic
 *   - the reconcile script (dry run by default, --apply) and the daily job
 *   - GET /tenants/:id/usage returns usage, limits and warning flags, is
 *     permission-gated and tenant-isolated; hard-limit errors share one
 *     typed QUOTA_EXCEEDED envelope
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import * as emailService from '../../src/services/email.service.js';
import tenantService from '../../src/services/tenant.service.js';
import invitationService from '../../src/services/tenantInvitation.service.js';
import planService from '../../src/services/plan.service.js';
import subscriptionService from '../../src/services/subscription.service.js';
import entitlementOverrideService from '../../src/services/entitlementOverride.service.js';
import usageService from '../../src/services/usage.service.js';
import entitlementService from '../../src/services/entitlement.service.js';
import * as dashboardService from '../../src/services/dashboard.service.js';
import connectorService from '../../src/services/connector.service.js';
import tenantRepository from '../../src/repositories/tenant.repository.js';
import usageCounterRepository from '../../src/repositories/usageCounter.repository.js';
import usageSourceRepository from '../../src/repositories/usageSource.repository.js';
import usageReconcileJob from '../../src/jobs/usageReconcile.job.js';
import { runJob, getRegisteredJobs, resetSchedulerForTests } from '../../src/jobs/scheduler.js';
import { createMongoLock } from '../../src/jobs/lock.js';
import { JobRun } from '../../src/models/JobRun.js';
import { run as runReconcileScript, parseArgs } from '../../scripts/ci/reconcile-usage.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { periodKeyFor } from '../../src/models/UsageCounter.js';
// billing: tenants exercising paid features need a plan that includes them.
import { entitleTenant } from '../helpers/billing.js';

const PASSWORD = 'MeterPassword123!';

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => { await resetMongo(); await planService.ensureDefaults('test'); });
after(async () => { await emailService.close(); await stopHttp(); await stopMongo(); });

async function counter(tenantId, metric, period = 'current') {
  return (await usageCounterRepository.findOne(tenantId, metric, period))?.value ?? 0;
}

async function limitOverride(tenantId, metric, max, hard = true) {
  await entitlementOverrideService.create({
    tenantId, metric, kind: 'limit', value: { max, hard }, reason: 'test limit', by: 'admin-test',
  });
}

async function makeTenant(planId = 'starter') {
  const suffix = randomBytes(4).toString('hex');
  const tenant = await tenantRepository.create({ name: `M ${suffix}`, slug: `m-${suffix}`, planId, status: 'active' });
  const tenantId = String(tenant._id);
  await subscriptionService.createForTenant({ tenantId, planId });
  return tenantId;
}

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

async function login(slug, email) {
  const res = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': slug }, body: { email, password: PASSWORD } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return { authorization: `Bearer ${res.json.data.accessToken}` };
}

/** Initialised workspace whose owner accepted and is logged in. */
async function workspace() {
  const email = `owner-${randomBytes(4).toString('hex')}@example.com`;
  let result;
  const token = await captureInviteToken(async () => {
    result = await tenantService.create({ tenant: { name: `Meter ${randomBytes(3).toString('hex')}` }, owner: { email, name: 'Owner' }, initialize: true, by: 'platform-admin' });
  });
  await invitationService.accept({ token, name: 'Owner', password: PASSWORD });
  await entitleTenant(result.tenant._id, 'starter');
  return { tenantId: String(result.tenant._id), slug: result.tenant.slug, email, auth: await login(result.tenant.slug, email) };
}

async function member(ws, roleName) {
  const email = `${roleName.toLowerCase()}-${randomBytes(4).toString('hex')}@example.com`;
  const token = await captureInviteToken(() => invitationService.create({ tenantId: ws.tenantId, email, name: roleName, roleName, invitedBy: 'platform-admin' }));
  await invitationService.accept({ token, name: roleName, password: PASSWORD });
  return { email, auth: await login(ws.slug, email) };
}

async function apiKey(ws) {
  const created = await api('/api/v1/api-keys', { method: 'POST', headers: ws.auth, body: { name: 'meter', scopes: ['datasets:read'] } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return created.json.data.secret;
}

/* --------------------------- metered API calls ----------------------------- */

test('apiCallsPerDay is metered per call and enforced per UTC day (fixed clock)', async () => {
  const tenantId = await makeTenant('starter');
  await limitOverride(tenantId, 'apiCallsPerDay', 3);
  const day1 = new Date('2026-03-10T10:00:00.000Z');
  const values = [];
  for (let i = 0; i < 3; i += 1) values.push((await usageService.meterApiCall({ tenantId, now: day1 })).value);
  assert.deepEqual(values, [1, 2, 3]);
  await assert.rejects(
    () => usageService.meterApiCall({ tenantId, now: new Date('2026-03-10T23:59:59.000Z') }),
    (err) => {
      assert.equal(err.statusCode, 429);
      assert.equal(err.code, 'QUOTA_EXCEEDED');
      assert.equal(err.details.metric, 'apiCallsPerDay');
      assert.equal(err.details.limit, 3);
      assert.equal(err.details.current, 3);
      assert.equal(err.details.period, '2026-03-10');
      assert.equal(err.details.resetsAt, '2026-03-11T00:00:00.000Z');
      assert.equal(err.errors[0].field, 'apiCallsPerDay');
      return true;
    },
  );
  // The next UTC day starts from zero; the previous day keeps its count.
  const next = await usageService.meterApiCall({ tenantId, now: new Date('2026-03-11T00:00:01.000Z') });
  assert.equal(next.value, 1);
  assert.equal(next.remaining, 2);
  assert.equal(next.resetsAt, '2026-03-12T00:00:00.000Z');
  assert.equal(await counter(tenantId, 'apiCallsPerDay', '2026-03-10'), 3);
  assert.equal(await counter(tenantId, 'apiCallsPerDay', '2026-03-11'), 1);
  const row = await usageCounterRepository.findOne(tenantId, 'apiCallsPerDay', '2026-03-10');
  assert.equal(row.kind, 'cumulative');
  assert.equal(new Date(row.expiresAt).toISOString(), '2026-06-09T00:00:00.000Z', 'metered rows expire after retention');
});

test('apiCallsPerDay: concurrent calls never pass the daily limit; soft limits only warn; no audit row per call', async () => {
  const tenantId = await makeTenant('starter');
  await limitOverride(tenantId, 'apiCallsPerDay', 4);
  const now = new Date('2026-04-01T12:00:00.000Z');
  const auditsBefore = await AuditLog.countDocuments({ module: 'iam.usage' });
  const results = await Promise.allSettled(Array.from({ length: 15 }, () => usageService.meterApiCall({ tenantId, now })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 4);
  assert.equal(await counter(tenantId, 'apiCallsPerDay', '2026-04-01'), 4);
  assert.equal(await AuditLog.countDocuments({ module: 'iam.usage' }), auditsBefore, 'metering writes no audit rows');

  const soft = await makeTenant('starter');
  await limitOverride(soft, 'apiCallsPerDay', 1, false);
  await usageService.meterApiCall({ tenantId: soft, now });
  const over = await usageService.meterApiCall({ tenantId: soft, now });
  assert.equal(over.value, 2);
  assert.equal(over.soft, true);
});

test('external API: each authenticated call counts, key creation does not, invalid keys do not, 429 past the limit, tenants isolated', async () => {
  const a = await workspace();
  const b = await workspace();
  const secret = await apiKey(a);
  const today = periodKeyFor('apiCallsPerDay');
  assert.equal(await counter(a.tenantId, 'apiCallsPerDay', today), 0, 'creating a key consumes no API calls');

  const first = await api('/api/v1/external/datasets', { headers: { 'X-Api-Key': secret } });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-quota-limit'), '10000');
  assert.equal(first.headers.get('x-quota-remaining'), '9999');
  assert.ok(Number(first.headers.get('x-quota-reset')) > Date.now() / 1000);
  await api('/api/v1/external/datasets', { headers: { 'X-Api-Key': secret } });
  assert.equal(await counter(a.tenantId, 'apiCallsPerDay', today), 2);

  const bad = await api('/api/v1/external/datasets', { headers: { 'X-Api-Key': `${secret.split('.')[0]}.${'x'.repeat(32)}` } });
  assert.equal(bad.status, 401);
  assert.equal(await counter(a.tenantId, 'apiCallsPerDay', today), 2, 'failed authentication is not metered');

  await limitOverride(a.tenantId, 'apiCallsPerDay', 3);
  assert.equal((await api('/api/v1/external/datasets', { headers: { 'X-Api-Key': secret } })).status, 200);
  const refused = await api('/api/v1/external/datasets', { headers: { 'X-Api-Key': secret } });
  assert.equal(refused.status, 429);
  assert.equal(refused.json.code, 'QUOTA_EXCEEDED');
  assert.equal(refused.json.errors[0].metric, 'apiCallsPerDay');
  assert.equal(refused.json.errors[0].limit, 3);
  assert.ok(Number(refused.headers.get('retry-after')) > 0);
  assert.equal(refused.headers.get('x-quota-remaining'), '0');
  assert.equal(await counter(a.tenantId, 'apiCallsPerDay', today), 3, 'a refused call is not counted');
  assert.equal(await counter(b.tenantId, 'apiCallsPerDay', today), 0, 'tenant B is untouched');

  const usage = await api(`/api/v1/tenants/${a.tenantId}/usage`, { headers: a.auth });
  assert.equal(usage.json.data.usage.apiCallsPerDay.current, 3);
  assert.equal(usage.json.data.usage.apiCallsPerDay.period, 'day');
  assert.equal(usage.json.data.usage.apiCallsPerDay.periodKey, today);
  assert.equal(usage.json.data.usage.apiCallsPerDay.blocked, true);
});

/* ------------------------------ reconciliation ----------------------------- */

async function seedResources(tenantId) {
  const c = await connectorService.createConnectorRecord({ tenantId, type: 'csv', name: 'Orders', config: {}, fieldMapping: { id: 'id' } });
  await connectorService.processSyncMessage({ data: { connectorId: String(c._id), tenantId, jobType: 'ingest', payload: { buffer: Buffer.from('id\n1\n2\n3\n').toString('base64') } } });
  await dashboardService.createDashboard({ tenantId, name: 'One' });
  await dashboardService.createDashboard({ tenantId, name: 'Two' });
}

async function corrupt(tenantId) {
  await usageCounterRepository.setToActual({ tenantId, metric: 'dashboards', value: 42 });
  await usageCounterRepository.setToActual({ tenantId, metric: 'connectors', value: 0 });
  await usageCounterRepository.setToActual({ tenantId, metric: 'storedRows', value: 1000 });
  await usageCounterRepository.setToActual({ tenantId, metric: 'alerts', value: 7 });
}

test('reconcile: dry run reports a corrupted counter without writing; apply corrects it and audits', async () => {
  const tenantId = await makeTenant('starter');
  await seedResources(tenantId);
  await corrupt(tenantId);

  const dry = await usageService.reconcile({ tenantId, settleMs: 0 });
  assert.equal(dry.dryRun, true);
  const byMetric = Object.fromEntries(dry.metrics.map((m) => [m.metric, m]));
  assert.deepEqual(
    { recorded: byMetric.dashboards.recorded, actual: byMetric.dashboards.actual, action: byMetric.dashboards.action },
    { recorded: 42, actual: 2, action: 'would_correct' },
  );
  assert.equal(byMetric.connectors.actual, 1);
  assert.equal(byMetric.storedRows.actual, 3);
  assert.equal(byMetric.alerts.actual, 0);
  assert.equal(dry.drifted, 4);
  assert.equal(await counter(tenantId, 'dashboards'), 42, 'dry run writes nothing');

  const applied = await usageService.reconcile({ tenantId, dryRun: false, settleMs: 0, by: 'test' });
  assert.equal(applied.corrected, 4);
  assert.equal(await counter(tenantId, 'dashboards'), 2);
  assert.equal(await counter(tenantId, 'connectors'), 1);
  assert.equal(await counter(tenantId, 'storedRows'), 3);
  assert.equal(await counter(tenantId, 'alerts'), 0);
  const audit = await AuditLog.findOne({ action: 'usage.reconciled', tenantId }).lean();
  assert.ok(audit, 'corrections are audited');
  assert.equal(audit.before.dashboards, 42);
  assert.equal(audit.after.dashboards, 2);

  const again = await usageService.reconcile({ tenantId, dryRun: false, settleMs: 0 });
  assert.equal(again.drifted, 0);
  // A fixed counter enforces the plan again: starter allows 5 connectors.
  const actual = await usageSourceRepository.countResources(tenantId);
  assert.equal(actual.connectors, 1);
});

test('reconcile: the settle window and compare-and-set never overwrite live changes; other tenants are untouched', async () => {
  const tenantId = await makeTenant('starter');
  const other = await makeTenant('starter');
  await dashboardService.createDashboard({ tenantId, name: 'Fresh' });
  await usageCounterRepository.setToActual({ tenantId, metric: 'alerts', value: 3 }); // never incremented
  // Simulate an in-flight create: counter bumped, document not yet written.
  await usageService.checkAndConsume({ tenantId, metric: 'dashboards' });
  await usageCounterRepository.setToActual({ tenantId: other, metric: 'dashboards', value: 9 });

  const res = await usageService.reconcile({ tenantId, dryRun: false, settleMs: 60_000 });
  const byMetric = Object.fromEntries(res.metrics.map((m) => [m.metric, m]));
  assert.equal(byMetric.dashboards.action, 'skipped_recent_activity');
  assert.equal(await counter(tenantId, 'dashboards'), 2);
  assert.equal(byMetric.alerts.action, 'corrected');
  assert.equal(await counter(tenantId, 'alerts'), 0);
  assert.equal(await counter(other, 'dashboards'), 9, 'reconciling one tenant leaves others alone');

  const row = await usageCounterRepository.findOne(tenantId, 'dashboards');
  const stale = { value: row.value - 1, lastIncrementedAt: row.lastIncrementedAt };
  assert.equal(await usageCounterRepository.compareAndSet({ tenantId, metric: 'dashboards', expected: stale, value: 0 }), false);
  assert.equal(await counter(tenantId, 'dashboards'), 2);
  await assert.rejects(() => usageService.reconcile({}), (err) => err.statusCode === 400);
});

test('reconcile script: dry run by default, --apply writes, --tenant restricts', async () => {
  const t1 = await makeTenant('starter');
  const t2 = await makeTenant('starter');
  await seedResources(t1);
  await corrupt(t1);
  await usageCounterRepository.setToActual({ tenantId: t2, metric: 'reports', value: 4 });

  assert.deepEqual(parseArgs([]), { apply: false, tenantIds: [] });
  assert.deepEqual(parseArgs(['--apply', '--tenant', 'abc', '--tenant', 'def']), { apply: true, tenantIds: ['abc', 'def'] });

  const lines = [];
  const dry = await runReconcileScript({ settleMs: 0, log: (l) => lines.push(l) });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.tenants, 2);
  assert.ok(lines.some((l) => l.startsWith('drift') && l.includes(t1) && l.includes('dashboards 42->2')));
  assert.ok(lines.some((l) => l.includes('Dry run only')));
  assert.equal(await counter(t1, 'dashboards'), 42);
  assert.equal(await counter(t2, 'reports'), 4);

  const only = await runReconcileScript({ apply: true, settleMs: 0, tenantIds: [t2], log: () => {} });
  assert.equal(only.tenants, 1);
  assert.equal(await counter(t2, 'reports'), 0);
  assert.equal(await counter(t1, 'dashboards'), 42, '--tenant leaves other tenants alone');

  const applied = await runReconcileScript({ apply: true, settleMs: 0, log: () => {} });
  assert.equal(applied.corrected, 4);
  assert.equal(await counter(t1, 'dashboards'), 2);
});

test('daily reconcile job corrects drift and is registered disabled by default', async () => {
  const tenantId = await makeTenant('starter');
  await usageCounterRepository.setToActual({ tenantId, metric: 'alerts', value: 5 });
  assert.equal(usageReconcileJob.name, 'usage-reconcile');
  assert.equal(usageReconcileJob.cronExpression, '30 2 * * *');
  assert.equal(usageReconcileJob.enabled, false);
  const summary = await usageReconcileJob.handler();
  assert.equal(summary.dryRun, false);
  assert.equal(await counter(tenantId, 'alerts'), 0);
});

test('daily reconcile job runs through the jobs scheduler: registered, under the job lock, recorded as a JobRun', async () => {
  resetSchedulerForTests();
  const tenantId = await makeTenant('starter');
  await usageCounterRepository.setToActual({ tenantId, metric: 'alerts', value: 4 });

  const registered = getRegisteredJobs().find((j) => j.name === 'usage-reconcile');
  assert.ok(registered, 'usage-reconcile is registered with the scheduler');
  assert.deepEqual(registered, { name: 'usage-reconcile', cronExpression: '30 2 * * *', enabled: false });

  const lock = createMongoLock();
  // Another instance holds the job lock: this tick is skipped, nothing changes.
  const held = await lock.acquire('job:usage-reconcile', { owner: 'other-instance', leaseMs: 60000 });
  assert.ok(held);
  const skipped = await runJob(usageReconcileJob, { lock, instanceId: 'instance-a', trigger: 'manual' });
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.reason, 'locked');
  assert.equal(await counter(tenantId, 'alerts'), 4);
  await lock.release('job:usage-reconcile', held);

  const outcome = await runJob(usageReconcileJob, { lock, instanceId: 'instance-a', trigger: 'manual' });
  assert.equal(outcome.status, 'succeeded');
  assert.equal(await counter(tenantId, 'alerts'), 0, 'the drifted counter is corrected');
  const run = await JobRun.findById(outcome.runId).lean();
  assert.equal(run.job, 'usage-reconcile');
  assert.equal(run.status, 'succeeded');
  assert.equal(run.instanceId, 'instance-a');
  assert.equal(run.counts.tenants, 1);
  assert.equal(run.counts.corrected, 1);
  assert.equal(run.counts.failed, 0);
});

/* -------------------------------- usage API -------------------------------- */

test('usage API: usage, limits and warning flags per metric; QUOTA_EXCEEDED envelope on create', async () => {
  const ws = await workspace();
  await limitOverride(ws.tenantId, 'dashboards', 5);
  for (let i = 0; i < 4; i += 1) {
    const res = await api('/api/v1/dashboards', { method: 'POST', headers: ws.auth, body: { name: `D${i}` } });
    assert.equal(res.status, 201, JSON.stringify(res.json));
  }
  let usage = await api(`/api/v1/tenants/${ws.tenantId}/usage`, { headers: ws.auth });
  assert.equal(usage.status, 200);
  const data = usage.json.data;
  assert.equal(data.warningThreshold, 0.8);
  assert.deepEqual(
    (({ current, limit, hard, period, warning, atLimit, blocked, status, remaining, percent }) => ({ current, limit, hard, period, warning, atLimit, blocked, status, remaining, percent }))(data.usage.dashboards),
    { current: 4, limit: 5, hard: true, period: 'current', warning: true, atLimit: false, blocked: false, status: 'warning', remaining: 1, percent: 80 },
  );
  assert.ok(data.warnings.includes('dashboards'));
  assert.equal(data.usage.members.current, 1, 'the owner holds a seat');
  assert.equal(data.usage.members.warning, false);
  assert.equal(data.usage.apiCallsPerDay.period, 'day');
  assert.ok(data.usage.apiCallsPerDay.resetsAt);
  assert.equal(data.usage.connectors.status, 'ok');

  assert.equal((await api('/api/v1/dashboards', { method: 'POST', headers: ws.auth, body: { name: 'D5' } })).status, 201);
  const refused = await api('/api/v1/dashboards', { method: 'POST', headers: ws.auth, body: { name: 'D6' } });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, 'QUOTA_EXCEEDED');
  assert.equal(refused.json.errors.length, 1);
  const detail = refused.json.errors[0];
  assert.deepEqual(
    { field: detail.field, metric: detail.metric, limit: detail.limit, current: detail.current, period: detail.period },
    { field: 'dashboards', metric: 'dashboards', limit: 5, current: 5, period: 'current' },
  );
  usage = await api(`/api/v1/tenants/${ws.tenantId}/usage`, { headers: ws.auth });
  assert.equal(usage.json.data.usage.dashboards.status, 'at_limit');
  assert.equal(usage.json.data.usage.dashboards.blocked, true);
});

test('warning flag: usage at the threshold share of a limit warns, one below does not (no float drift)', () => {
  for (const [threshold, max, atThreshold] of [[0.07, 100, 7], [0.14, 50, 7], [0.55, 20, 11], [0.8, 5, 4], [0.8, 1, 1]]) {
    const limit = { max, hard: true };
    const at = entitlementService.describeMetric({ metric: 'dashboards', current: atThreshold, limit, threshold });
    assert.equal(at.warning, true, `${atThreshold}/${max} at ${threshold} warns`);
    const below = entitlementService.describeMetric({ metric: 'dashboards', current: atThreshold - 1, limit, threshold });
    assert.equal(below.warning, false, `${atThreshold - 1}/${max} at ${threshold} does not warn`);
  }
  const notIncluded = entitlementService.describeMetric({ metric: 'alerts', current: 0, limit: { max: 0, hard: true }, threshold: 0.8 });
  assert.deepEqual(
    { warning: notIncluded.warning, status: notIncluded.status, included: notIncluded.included },
    { warning: false, status: 'not_included', included: false },
  );
});

test('usage API: permission-gated and tenant-isolated', async () => {
  const a = await workspace();
  const b = await workspace();
  const viewer = await member(a, 'Viewer');
  assert.equal((await api(`/api/v1/tenants/${a.tenantId}/usage`, { headers: viewer.auth })).status, 403, 'viewers lack iam.entitlements.view');
  assert.equal((await api(`/api/v1/tenants/${a.tenantId}/usage`, { headers: b.auth })).status, 403, 'another tenant is refused');
  assert.equal((await api(`/api/v1/tenants/${a.tenantId}/usage`)).status, 401);
  assert.equal((await api('/api/v1/tenants/not-an-id/usage', { headers: a.auth })).status >= 400, true);
  const own = await api(`/api/v1/tenants/${a.tenantId}/usage`, { headers: a.auth });
  assert.equal(own.status, 200);
  assert.equal(own.json.data.tenantId, a.tenantId);
  assert.equal(own.json.data.usage.members.current, 2, 'owner + viewer');
});

test('usage API: ?period=YYYY-MM-DD reads metered usage for that UTC day; invalid periods are rejected', async () => {
  const ws = await workspace();
  for (let i = 0; i < 3; i += 1) await usageService.meterApiCall({ tenantId: ws.tenantId, now: new Date('2026-03-10T08:00:00.000Z') });
  const past = await api(`/api/v1/tenants/${ws.tenantId}/usage?period=2026-03-10`, { headers: ws.auth });
  assert.equal(past.status, 200);
  assert.equal(past.json.data.usage.apiCallsPerDay.current, 3);
  assert.equal(past.json.data.usage.apiCallsPerDay.periodKey, '2026-03-10');
  assert.equal(past.json.data.usage.apiCallsPerDay.resetsAt, '2026-03-11T00:00:00.000Z');
  const today = await api(`/api/v1/tenants/${ws.tenantId}/usage`, { headers: ws.auth });
  assert.equal(today.json.data.usage.apiCallsPerDay.current, 0);
  for (const bad of ['2026-02-30', 'yesterday', '2026-3-1']) {
    const res = await api(`/api/v1/tenants/${ws.tenantId}/usage?period=${bad}`, { headers: ws.auth });
    assert.equal(res.status, 400, bad);
  }
});
