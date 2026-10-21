/**
 * Durable jobs (roadmap 1.4): tenant sync-run history endpoint and the sync
 * API contract (409 while a sync is in flight, typed 503 when the queue does
 * not accept the job).
 *
 * Exit criterion covered here: the sync-run endpoint enforces permissions and
 * tenant isolation.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api, apiMultipart } from '../helpers/http.js';
import { shortToken } from '../../src/utils/id.js';
import { hash } from '../../src/utils/password.js';
import * as tenantService from '../../src/services/tenant.service.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import userRepository from '../../src/repositories/user.repository.js';
import connectorRepository from '../../src/repositories/connector.repository.js';
import syncRunRepository from '../../src/repositories/syncRun.repository.js';
import { connectorQueue } from '../../src/queues/connector.queue.js';
import { QueueError } from '../../src/queues/errors.js';
import { UsageCounter } from '../../src/models/UsageCounter.js';

const PASSWORD = 'Password123!';

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => { await resetMongo(); await rbacCache.clearAll(); });
after(async () => { await stopHttp(); await stopMongo(); });

async function onboard() {
  const owner = { email: `owner-${shortToken(10).toLowerCase()}@example.com`, name: 'Owner', password: PASSWORD };
  const { tenant } = await tenantService.create({ tenant: { name: `Sync ${shortToken(10)}` }, owner, initialize: true, by: 'root' });
  const tenantId = tenant._id.toString();
  const login = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email: owner.email, password: PASSWORD } });
  assert.equal(login.status, 200);
  return { tenantId, auth: { authorization: `Bearer ${login.json.data.accessToken}`, 'X-Tenant-Id': tenantId } };
}

async function memberWithoutRights(tenantId) {
  const email = `nobody-${shortToken(10).toLowerCase()}@example.com`;
  await userRepository.create({ tenantId, email, status: 'active', passwordHash: await hash(PASSWORD), profile: { name: 'Nobody' } });
  const login = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email, password: PASSWORD } });
  assert.equal(login.status, 200);
  return { authorization: `Bearer ${login.json.data.accessToken}`, 'X-Tenant-Id': tenantId };
}

async function connectorWithRuns(tenantId, n) {
  const connector = await connectorRepository.create({ tenantId, type: 'csv', name: 'Orders', status: 'active' });
  const connectorId = String(connector._id);
  for (let i = 0; i < n; i += 1) {
    await syncRunRepository.create({
      tenantId, connectorId, trigger: 'manual', status: i === 0 ? 'failed' : 'succeeded',
      attempts: 1, queuedAt: new Date(Date.now() - (n - i) * 1000),
      rows: { received: 10 * i, upserted: 10 * i },
      error: i === 0 ? { code: 'SYNC_FAILED', message: 'bad header' } : null,
      // Worker bookkeeping that must never reach tenant users.
      instanceId: 'worker-host.internal:4242', jobId: `csv-${i}`, leaseUntil: new Date(), heartbeatAt: new Date(),
    });
    await new Promise((r) => setTimeout(r, 2));
  }
  return connectorId;
}

test('GET /connectors/:id/sync-runs lists the history newest first with pagination', async () => {
  const { tenantId, auth } = await onboard();
  const connectorId = await connectorWithRuns(tenantId, 3);

  const page1 = await api(`/api/v1/connectors/${connectorId}/sync-runs?limit=2`, { headers: auth });
  assert.equal(page1.status, 200, JSON.stringify(page1.json));
  assert.equal(page1.json.data.length, 2);
  assert.deepEqual(page1.json.meta, { page: 1, limit: 2, total: 3, pages: 2 });
  assert.ok(new Date(page1.json.data[0].createdAt) >= new Date(page1.json.data[1].createdAt), 'newest first');
  const run = page1.json.data[0];
  assert.equal(typeof run.id, 'string');
  assert.equal(run.connectorId, connectorId);
  for (const internal of ['expiresAt', 'instanceId', 'jobId', 'leaseUntil', 'heartbeatAt', '_id', '__v', 'tenantId']) {
    assert.equal(internal in run, false, `internal field ${internal} is not exposed`);
  }
  assert.doesNotMatch(JSON.stringify(page1.json), /worker-host\.internal/);

  const page2 = await api(`/api/v1/connectors/${connectorId}/sync-runs?limit=2&page=2`, { headers: auth });
  assert.equal(page2.json.data.length, 1);
  assert.equal(page2.json.data[0].error.code, 'SYNC_FAILED');

  const failedOnly = await api(`/api/v1/connectors/${connectorId}/sync-runs?status=failed`, { headers: auth });
  assert.equal(failedOnly.json.data.length, 1);

  const badFilter = await api(`/api/v1/connectors/${connectorId}/sync-runs?status=exploded`, { headers: auth });
  assert.equal(badFilter.status, 422);
});

test('sync runs are tenant-isolated: another tenant gets 404 and never sees the runs', async () => {
  const a = await onboard();
  const b = await onboard();
  const connectorId = await connectorWithRuns(a.tenantId, 2);

  const cross = await api(`/api/v1/connectors/${connectorId}/sync-runs`, { headers: b.auth });
  assert.equal(cross.status, 404);

  // Even with a forged tenant header the caller only reaches its own tenant.
  const forged = await api(`/api/v1/connectors/${connectorId}/sync-runs`, { headers: { ...b.auth, 'X-Tenant-Id': a.tenantId } });
  assert.ok([401, 403, 404].includes(forged.status), `forged tenant header -> ${forged.status}`);

  // Tenant B's own connector with the same history shape stays separate.
  const own = await connectorWithRuns(b.tenantId, 1);
  const ownRuns = await api(`/api/v1/connectors/${own}/sync-runs`, { headers: b.auth });
  assert.equal(ownRuns.json.data.length, 1);
  assert.ok(ownRuns.json.data.every((r) => r.connectorId === own));
});

test('sync runs require authentication and connectors.view', async () => {
  const { tenantId } = await onboard();
  const connectorId = await connectorWithRuns(tenantId, 1);
  const anonymous = await api(`/api/v1/connectors/${connectorId}/sync-runs`);
  assert.equal(anonymous.status, 401);
  const noRights = await memberWithoutRights(tenantId);
  const denied = await api(`/api/v1/connectors/${connectorId}/sync-runs`, { headers: noRights });
  assert.equal(denied.status, 403);
});

test('a second sync while one is in flight is 409 SYNC_IN_PROGRESS; the first returns its run id', async () => {
  const { tenantId, auth } = await onboard();
  const connector = await connectorRepository.create({ tenantId, type: 'csv', name: 'Upload', status: 'active' });
  const connectorId = String(connector._id);
  // Hold queued messages (no consumer runs them in this test).
  connectorQueue.getQueue().consume(() => new Promise(() => {}));

  const file = { buffer: Buffer.from('id,name\n1,A\n'), type: 'text/csv', name: 'a.csv' };
  const first = await apiMultipart(`/api/v1/connectors/${connectorId}/sync`, { headers: auth, file });
  assert.equal(first.status, 202, JSON.stringify(first.json));
  assert.ok(first.json.data.syncRunId);
  assert.equal(first.json.data.status, 'queued');

  // storedRows is metered by the worker on the rows it really adds
  // (roadmap 1.3): a queued sync holds no stored-rows estimate.
  const consumed = await UsageCounter.findOne({ tenantId, metric: 'storedRows' }).lean();
  assert.equal(consumed?.value ?? 0, 0, 'the accepted sync holds no stored-rows estimate');

  const second = await apiMultipart(`/api/v1/connectors/${connectorId}/sync`, { headers: auth, file });
  assert.equal(second.status, 409);
  assert.equal(second.json.code, 'SYNC_IN_PROGRESS');
  const unchanged = await UsageCounter.findOne({ tenantId, metric: 'storedRows' }).lean();
  assert.equal(unchanged?.value ?? 0, consumed?.value ?? 0, 'a refused sync consumes no quota');

  const runs = await api(`/api/v1/connectors/${connectorId}/sync-runs`, { headers: auth });
  assert.equal(runs.json.data.length, 1);
  assert.equal(runs.json.data[0].id, first.json.data.syncRunId);
  assert.equal(runs.json.data[0].filename, 'a.csv');
});

test('a very long upload name is truncated on the run, never fails the sync', async () => {
  const { tenantId, auth } = await onboard();
  const connector = await connectorRepository.create({ tenantId, type: 'csv', name: 'Long names', status: 'active' });
  const connectorId = String(connector._id);
  connectorQueue.getQueue().consume(() => new Promise(() => {}));

  const longName = `${'x'.repeat(400)}.csv`;
  const res = await apiMultipart(`/api/v1/connectors/${connectorId}/sync`, {
    headers: auth,
    file: { buffer: Buffer.from('id\n1\n'), type: 'text/csv', name: longName },
  });
  assert.equal(res.status, 202, JSON.stringify(res.json));
  const runs = await api(`/api/v1/connectors/${connectorId}/sync-runs`, { headers: auth });
  assert.equal(runs.json.data[0].id, res.json.data.syncRunId);
  assert.equal(runs.json.data[0].filename.length, 255);
  assert.equal(runs.json.data[0].status, 'queued');
});

test('a queue that does not accept the job answers a typed 503 and leaves nothing wedged', async () => {
  const { tenantId, auth } = await onboard();
  const connector = await connectorRepository.create({ tenantId, type: 'csv', name: 'Outage', status: 'active' });
  const connectorId = String(connector._id);
  const original = connectorQueue.enqueue;
  connectorQueue.enqueue = async () => {
    throw new QueueError('QUEUE_TIMEOUT', 'The job queue did not accept the job in time; please retry shortly');
  };
  try {
    const before = await UsageCounter.findOne({ tenantId, metric: 'storedRows' }).lean();
    const file = { buffer: Buffer.from('id,name\n1,A\n2,B\n'), type: 'text/csv', name: 'b.csv' };
    const res = await apiMultipart(`/api/v1/connectors/${connectorId}/sync`, { headers: auth, file });
    assert.equal(res.status, 503, JSON.stringify(res.json));
    assert.equal(res.json.code, 'QUEUE_TIMEOUT');
    assert.equal(res.json.success, false);

    const after = await connectorRepository.findById(connectorId, { tenantId });
    assert.equal(after.syncStatus, 'failed');
    assert.equal(after.currentSyncRunId, null, 'the slot is free for a retry');
    const runs = await syncRunRepository.listForConnector({ tenantId, connectorId });
    assert.equal(runs.docs[0].status, 'failed');
    assert.equal(runs.docs[0].error.code, 'QUEUE_TIMEOUT');

    // No stored-rows quota is held for a sync the queue refused.
    const usage = await UsageCounter.findOne({ tenantId, metric: 'storedRows' }).lean();
    assert.equal(usage?.value ?? 0, before?.value ?? 0);
  } finally {
    connectorQueue.enqueue = original;
  }
});
