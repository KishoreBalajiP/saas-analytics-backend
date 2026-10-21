/**
 * Durable jobs (roadmap 1.4): platform-admin job-run history and live queue /
 * scheduler health (replacing the deferred monitoring stubs; findings
 * con.13, tst.10).
 *
 * Exit criterion covered here: the job-run endpoint enforces permissions.
 */

import test, { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import { shortToken } from '../../src/utils/id.js';
import adminService from '../../src/services/admin.service.js';
import roleService from '../../src/services/role.service.js';
import permissionService from '../../src/services/permission.service.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import * as tenantService from '../../src/services/tenant.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import { runJob, resetSchedulerForTests } from '../../src/jobs/scheduler.js';
import { getQueueReadiness } from '../../src/services/monitoring.service.js';
import { JobRun } from '../../src/models/JobRun.js';

const PASSWORD = 'Password123!';

async function ensureModule(key) {
  if (key.includes('.')) await ensureModule(key.slice(0, key.lastIndexOf('.')));
  try { await permissionService.createModule({ key, name: key }); } catch (err) { if (err.statusCode !== 409) throw err; }
}

async function ensurePermission(key) {
  const module = key.slice(0, key.lastIndexOf('.'));
  const action = key.slice(key.lastIndexOf('.') + 1);
  await ensureModule(module);
  try { await permissionService.createPermission({ module, action }); } catch (err) { if (err.statusCode !== 409) throw err; }
}

async function adminToken(permissionKey) {
  const admin = await adminService.create({
    email: `admin-${shortToken(8)}@platform.test`, password: PASSWORD, adminType: 'platform', name: 'Jobs Tester',
  });
  const role = await roleService.create({ tenantId: null, name: `role_${shortToken(8)}` });
  await ensurePermission(permissionKey);
  await roleService.addPermission({ roleId: role._id, permissionKey, by: null /* fixture seeding */ });
  await adminService.assignRole({ adminId: admin._id, roleId: role._id, tenantId: null, by: null /* fixture seeding */ });
  const login = await api('/api/v1/admin-auth/login', { method: 'POST', body: { email: admin.email, password: PASSWORD } });
  assert.equal(login.status, 200);
  return { authorization: `Bearer ${login.json.data.accessToken}` };
}

async function seedRuns() {
  const base = Date.now() - 60 * 60 * 1000;
  await JobRun.create([
    { job: 'report-schedule', status: 'succeeded', instanceId: 'w1', startedAt: new Date(base + 1000), finishedAt: new Date(base + 1500), durationMs: 500, counts: { enqueued: 2 } },
    { job: 'alert-evaluation', status: 'failed', instanceId: 'w1', startedAt: new Date(base + 2000), finishedAt: new Date(base + 2100), durationMs: 100, error: { code: 'JOB_FAILED', message: 'boom' } },
    { job: 'report-schedule', status: 'succeeded', instanceId: 'w2', startedAt: new Date(base + 3000), finishedAt: new Date(base + 3200), durationMs: 200 },
  ]);
}

describe('job monitoring surface', () => {
  before(async () => { await startMongo(); await startHttp(); });
  after(async () => { await stopHttp(); await stopMongo(); });
  beforeEach(async () => {
    await resetMongo();
    await rbacCache.clearAll();
    await cacheService.flushAll?.();
    resetSchedulerForTests();
  });

  test('job runs and job health require an admin with monitoring.view', async () => {
    for (const path of ['/api/v1/monitoring/jobs/runs', '/api/v1/monitoring/health/queue', '/api/v1/monitoring/health/scheduler']) {
      const anonymous = await api(path);
      assert.equal(anonymous.status, 401, `${path} requires auth`);
    }
    const wrong = await adminToken('compliance.view');
    const denied = await api('/api/v1/monitoring/jobs/runs', { headers: wrong });
    assert.equal(denied.status, 403);

    // A tenant user token is not a platform admin token.
    const owner = { email: `owner-${shortToken(10).toLowerCase()}@example.com`, name: 'Owner', password: PASSWORD };
    const { tenant } = await tenantService.create({ tenant: { name: `T ${shortToken(8)}` }, owner, initialize: true, by: 'root' });
    const login = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': String(tenant._id) }, body: { email: owner.email, password: PASSWORD } });
    const tenantAuth = { authorization: `Bearer ${login.json.data.accessToken}`, 'X-Tenant-Id': String(tenant._id) };
    const tenantDenied = await api('/api/v1/monitoring/jobs/runs', { headers: tenantAuth });
    assert.ok([401, 403].includes(tenantDenied.status), `tenant token -> ${tenantDenied.status}`);
  });

  test('GET /monitoring/jobs/runs lists runs newest first, paginated and filterable', async () => {
    const headers = await adminToken('monitoring.view');
    await seedRuns();

    const all = await api('/api/v1/monitoring/jobs/runs?limit=2', { headers });
    assert.equal(all.status, 200, JSON.stringify(all.json));
    assert.equal(all.json.data.length, 2);
    assert.deepEqual(all.json.meta, { page: 1, limit: 2, total: 3, pages: 2 });
    assert.equal(all.json.data[0].instanceId, 'w2', 'newest first');
    assert.deepEqual(Object.keys(all.json.data[0]).sort(), [
      'counts', 'durationMs', 'error', 'finishedAt', 'id', 'instanceId', 'job', 'startedAt', 'status', 'trigger',
    ]);

    const byJob = await api('/api/v1/monitoring/jobs/runs?job=report-schedule', { headers });
    assert.equal(byJob.json.data.length, 2);
    const failed = await api('/api/v1/monitoring/jobs/runs?status=failed', { headers });
    assert.equal(failed.json.data.length, 1);
    assert.equal(failed.json.data[0].error.message, 'boom');

    const badStatus = await api('/api/v1/monitoring/jobs/runs?status=exploded', { headers });
    assert.equal(badStatus.status, 400);
    const badJob = await api('/api/v1/monitoring/jobs/runs?job=%24where', { headers });
    assert.equal(badJob.status, 400);
  });

  test('scheduler health reports each registered job with its last run', async () => {
    const headers = await adminToken('monitoring.view');
    await runJob({ name: 'stale-job-recovery', leaseMs: 60000, handler: async () => ({ recovered: 0 }) }, { instanceId: 'w9' });

    const res = await api('/api/v1/monitoring/health/scheduler', { headers });
    assert.equal(res.status, 200);
    const data = res.json.data;
    assert.ok(['ok', 'degraded'].includes(data.status), data.status);
    assert.equal(data.enabled, true);
    const names = data.jobs.map((j) => j.name);
    for (const name of ['report-schedule', 'alert-evaluation', 'stale-job-recovery']) assert.ok(names.includes(name), name);
    const reaper = data.jobs.find((j) => j.name === 'stale-job-recovery');
    assert.equal(reaper.lastRun.status, 'succeeded');
    assert.equal(reaper.lastRun.instanceId, 'w9');
    assert.ok(reaper.lastSuccessAt);
    assert.equal(reaper.overdue, false);
    assert.ok(data.lastTickAt);
    assert.equal(typeof data.process.role, 'string');
  });

  test('scheduler health is degraded when a job is overdue or its last run failed', async () => {
    const headers = await adminToken('monitoring.view');
    await JobRun.create({
      job: 'report-schedule', status: 'succeeded', startedAt: new Date(Date.now() - 60 * 60 * 1000), finishedAt: new Date(Date.now() - 59 * 60 * 1000),
    });
    await JobRun.create({ job: 'alert-evaluation', status: 'failed', startedAt: new Date(), finishedAt: new Date() });
    const res = await api('/api/v1/monitoring/health/scheduler', { headers });
    assert.equal(res.json.data.status, 'degraded');
    assert.equal(res.json.data.jobs.find((j) => j.name === 'report-schedule').overdue, true);
    assert.equal(res.json.data.jobs.find((j) => j.name === 'alert-evaluation').lastRun.status, 'failed');
  });

  test('readiness includes the queue transport and fails (bounded) when Redis does not answer', async () => {
    // (The /health/ready route itself is covered by tests/health.test.js; it
    // needs the app's own connectDatabase() flag, which tests never set.)
    assert.equal(await getQueueReadiness(), 'memory', 'tests run the in-process transport');
    assert.equal(await getQueueReadiness({ redisEnabled: false }), 'memory');
    assert.equal(await getQueueReadiness({ redisEnabled: true, ping: async () => 'PONG' }), 'ok');
    const t0 = Date.now();
    const hung = await getQueueReadiness({ redisEnabled: true, ping: () => new Promise(() => {}), timeoutMs: 50 });
    assert.equal(hung, 'down');
    assert.ok(Date.now() - t0 < 1000, 'the readiness probe never hangs on Redis');
    assert.equal(
      await getQueueReadiness({ redisEnabled: true, ping: async () => { throw new Error("Stream isn't writeable"); } }),
      'down',
    );
  });

  test('queue health lists every queue with live counts', async () => {
    const headers = await adminToken('monitoring.view');
    const res = await api('/api/v1/monitoring/health/queue', { headers });
    assert.equal(res.status, 200);
    const data = res.json.data;
    assert.equal(data.status, 'ok');
    assert.equal(data.transport, 'memory');
    assert.equal(data.consumersInProcess, true);
    const names = data.queues.map((q) => q.name).sort();
    assert.deepEqual(names, ['analytics.jobs', 'connector.sync', 'email.delivery', 'export.jobs']);
    const analytics = data.queues.find((q) => q.name === 'analytics.jobs');
    assert.equal(analytics.status, 'ok');
    assert.equal(typeof analytics.waiting, 'number');
    assert.equal(analytics.consuming, true, 'app.js registers the analytics consumer in role "all"');
  });
});
