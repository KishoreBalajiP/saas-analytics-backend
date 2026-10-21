/**
 * Durable jobs (roadmap 1.4): stale-job reaper and the sync lease
 * (findings con.02, con.04, ops2.10, ops.09).
 *
 * Exit criterion covered here: a worker killed mid-sync (simulated by a
 * connector left `running` with an expired lease) is recovered by the reaper
 * and its SyncRun is marked `abandoned`; suspended tenants' syncs are
 * skipped.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { factories } from '../helpers/factories.js';
import staleJobRecovery, { reap, recoverStaleConnectors } from '../../src/jobs/stale-job-recovery.job.js';
import connectorService from '../../src/services/connector.service.js';
import connectorRepository from '../../src/repositories/connector.repository.js';
import syncRunRepository from '../../src/repositories/syncRun.repository.js';
import { Connector } from '../../src/models/Connector.js';
import { SyncRun } from '../../src/models/SyncRun.js';
import { JobRun } from '../../src/models/JobRun.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import { connectorQueue } from '../../src/queues/connector.queue.js';
import * as queueService from '../../src/services/queue.service.js';

before(async () => { await startMongo(); });
beforeEach(async () => { await resetMongo(); });
after(async () => {
  await queueService.closeAll();
  await stopMongo();
});

const MINUTE = 60 * 1000;

/** Capture every message enqueued on the connector queue. */
function captureQueue() {
  const captured = [];
  connectorQueue.getQueue().consume((job) => { captured.push(job); });
  return captured;
}

async function waitFor(predicate, timeout = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

/**
 * A connector whose worker died mid-sync: `running`, lease expired, with its
 * SyncRun still `running`.
 */
async function stuckConnector({ type = 'csv', tenantStatus = 'active', leaseAgoMs = MINUTE, recoveryAttempt = 0 } = {}) {
  const tenant = await factories.tenant.create({ status: tenantStatus });
  const tenantId = String(tenant._id);
  const connector = await connectorRepository.create({ tenantId, type, name: `${type} source`, status: 'active' });
  const runId = syncRunRepository.newId();
  const leaseUntil = new Date(Date.now() - leaseAgoMs);
  await syncRunRepository.create({
    _id: runId, tenantId, connectorId: String(connector._id), trigger: 'manual', status: 'running',
    attempts: 1, startedAt: new Date(Date.now() - 20 * MINUTE), leaseUntil, recoveryAttempt,
  });
  await Connector.updateOne({ _id: connector._id }, {
    $set: { syncStatus: 'running', syncRequestedAt: new Date(Date.now() - 20 * MINUTE), syncLeaseUntil: leaseUntil, currentSyncRunId: runId },
  });
  return { tenantId, connectorId: String(connector._id), runId };
}

test('the reaper module imports cleanly and is wired as a scheduled job', () => {
  assert.equal(staleJobRecovery.name, 'stale-job-recovery');
  assert.equal(typeof staleJobRecovery.handler, 'function');
  assert.equal(staleJobRecovery.enabled, true);
});

test('a worker killed mid-sync: the reaper resets the connector and marks the SyncRun abandoned', async () => {
  const { tenantId, connectorId, runId } = await stuckConnector({ type: 'csv' });

  const counts = await reap();
  assert.equal(counts.recovered, 1);
  assert.equal(counts.syncRunsAbandoned, 1);
  assert.equal(counts.requeued, 0, 'an upload cannot be replayed');

  const connector = await connectorRepository.findById(connectorId, { tenantId });
  assert.equal(connector.syncStatus, 'failed');
  assert.match(connector.lastError, /upload the file again/);
  assert.equal(connector.syncLeaseUntil, null);
  assert.equal(connector.currentSyncRunId, null);

  const run = await syncRunRepository.findById(runId, { tenantId });
  assert.equal(run.status, 'abandoned');
  assert.equal(run.error.code, 'LEASE_EXPIRED');
  assert.ok(run.finishedAt);

  // The connector is no longer wedged: a new sync is accepted.
  const captured = captureQueue();
  const next = await connectorService.syncFileUpload({
    tenantId, connectorId, buffer: Buffer.from('id,name\n1,A\n'), filename: 'again.csv',
  });
  assert.equal(next.accepted, true);
  assert.ok(await waitFor(() => captured.length === 1));

  // A redelivered message of the abandoned run is ignored.
  const redelivered = await connectorService.processSyncMessage({
    data: { connectorId, tenantId, jobType: 'ingest', syncRunId: runId, payload: { buffer: Buffer.from('id\n9\n').toString('base64') } },
  });
  assert.equal(redelivered.skipped, true);
  assert.equal(redelivered.reason, 'run_closed');
  assert.equal(await ConnectorRow.countDocuments({ connectorId }), 0);
});

test('a sync whose lease is still live is left alone', async () => {
  const { tenantId, connectorId, runId } = await stuckConnector({ leaseAgoMs: -5 * MINUTE });
  const counts = await recoverStaleConnectors();
  assert.equal(counts.recovered, 0);
  const connector = await connectorRepository.findById(connectorId, { tenantId });
  assert.equal(connector.syncStatus, 'running');
  assert.equal((await syncRunRepository.findById(runId, { tenantId })).status, 'running');
});

test('a stuck MongoDB pull sync is re-queued once as a recovery run, then failed', async () => {
  const captured = captureQueue();
  const { tenantId, connectorId, runId } = await stuckConnector({ type: 'mongodb' });

  const first = await reap();
  assert.equal(first.recovered, 1);
  assert.equal(first.requeued, 1);
  assert.ok(await waitFor(() => captured.length === 1), 'recovery job enqueued');

  const connector = await connectorRepository.findById(connectorId, { tenantId });
  assert.equal(connector.syncStatus, 'queued');
  const recovery = await syncRunRepository.findById(connector.currentSyncRunId, { tenantId });
  assert.equal(recovery.trigger, 'recovery');
  assert.equal(recovery.recoveryAttempt, 1);
  assert.equal(recovery.recoveredFrom, runId);
  assert.equal(captured[0].data.syncRunId, String(recovery._id));
  assert.equal((await syncRunRepository.findById(runId, { tenantId })).status, 'abandoned');

  // The recovery run dies too: the budget (1) is spent, so it fails for good.
  await Connector.updateOne({ _id: connectorId }, { $set: { syncLeaseUntil: new Date(Date.now() - MINUTE) } });
  const second = await reap();
  assert.equal(second.recovered, 1);
  assert.equal(second.requeued, 0);
  const final = await connectorRepository.findById(connectorId, { tenantId });
  assert.equal(final.syncStatus, 'failed');
  assert.match(final.lastError, /start a new sync/);
  assert.equal((await syncRunRepository.findById(String(recovery._id), { tenantId })).status, 'abandoned');
});

test('a stuck webhook ingest is reset with a webhook-specific message, not an upload hint', async () => {
  const { tenantId, connectorId, runId } = await stuckConnector({ type: 'webhook' });
  const counts = await reap();
  assert.equal(counts.recovered, 1);
  assert.equal(counts.requeued, 0, 'webhook events cannot be pulled again');
  const connector = await connectorRepository.findById(connectorId, { tenantId });
  assert.equal(connector.syncStatus, 'failed');
  assert.match(connector.lastError, /sent again/);
  assert.doesNotMatch(connector.lastError, /upload/);
  assert.equal((await syncRunRepository.findById(runId, { tenantId })).status, 'abandoned');
});

test('a stuck sync of a suspended tenant is reset but not re-queued', async () => {
  const { tenantId, connectorId } = await stuckConnector({ type: 'mongodb', tenantStatus: 'suspended' });
  const counts = await reap();
  assert.equal(counts.recovered, 1);
  assert.equal(counts.requeued, 0);
  const connector = await connectorRepository.findById(connectorId, { tenantId });
  assert.equal(connector.syncStatus, 'failed');
  assert.match(connector.lastError, /workspace is not active/);
});

test('legacy stuck connectors (no lease, old request) are recovered', async () => {
  const tenant = await factories.tenant.create({ status: 'active' });
  const tenantId = String(tenant._id);
  const connector = await connectorRepository.create({ tenantId, type: 'csv', name: 'legacy', status: 'active' });
  await Connector.updateOne({ _id: connector._id }, {
    $set: { syncStatus: 'queued', syncRequestedAt: new Date(Date.now() - 24 * 60 * MINUTE), syncLeaseUntil: null },
  });
  const counts = await recoverStaleConnectors();
  assert.equal(counts.recovered, 1);
  assert.equal((await connectorRepository.findById(String(connector._id), { tenantId })).syncStatus, 'failed');
});

test('an expired lease frees the sync slot even before the reaper runs (con.02)', async () => {
  const { tenantId, connectorId, runId } = await stuckConnector({ type: 'csv' });
  captureQueue();
  const accepted = await connectorService.syncFileUpload({
    tenantId, connectorId, buffer: Buffer.from('id\n1\n'), filename: 'retry.csv',
  });
  assert.equal(accepted.accepted, true);
  // The dead worker's run is closed by the takeover.
  assert.equal((await syncRunRepository.findById(runId, { tenantId })).status, 'abandoned');
  const connector = await connectorRepository.findById(connectorId, { tenantId });
  assert.equal(connector.currentSyncRunId, accepted.syncRunId);
});

test('job runs whose process stopped heartbeating are closed as abandoned', async () => {
  await JobRun.create([
    { job: 'report-schedule', status: 'running', startedAt: new Date(Date.now() - 10 * MINUTE), leaseUntil: new Date(Date.now() - MINUTE) },
    { job: 'alert-evaluation', status: 'running', startedAt: new Date(), leaseUntil: new Date(Date.now() + 5 * MINUTE) },
  ]);
  const counts = await reap();
  assert.equal(counts.jobRunsClosed, 1);
  const stale = await JobRun.findOne({ job: 'report-schedule' }).lean();
  assert.equal(stale.status, 'abandoned');
  assert.equal(stale.error.code, 'LEASE_EXPIRED');
  const live = await JobRun.findOne({ job: 'alert-evaluation' }).lean();
  assert.equal(live.status, 'running');
});

test('a queued sync of a tenant suspended before it ran is cancelled at execution time', async () => {
  const tenant = await factories.tenant.create({ status: 'active' });
  const tenantId = String(tenant._id);
  const connector = await connectorRepository.create({ tenantId, type: 'csv', name: 'to-suspend', status: 'active' });
  const connectorId = String(connector._id);
  const captured = captureQueue();
  const queued = await connectorService.syncFileUpload({
    tenantId, connectorId, buffer: Buffer.from('id,name\n1,A\n2,B\n'), filename: 'x.csv',
  });
  assert.ok(await waitFor(() => captured.length === 1));

  const { Tenant } = await import('../../src/models/Tenant.js');
  await Tenant.updateOne({ _id: tenant._id }, { $set: { status: 'suspended' } });

  const outcome = await connectorService.processSyncMessage(captured[0]);
  assert.equal(outcome.skipped, true);
  assert.equal(outcome.reason, 'tenant_not_active');
  assert.equal(outcome.skippedReason, 'TENANT_NOT_ACTIVE');
  assert.equal(await ConnectorRow.countDocuments({ connectorId }), 0, 'no rows ingested');
  const run = await syncRunRepository.findById(queued.syncRunId, { tenantId });
  assert.equal(run.status, 'cancelled');
  assert.equal(run.error.code, 'TENANT_NOT_ACTIVE');
  const after = await connectorRepository.findById(connectorId, { tenantId });
  assert.equal(after.syncStatus, 'failed');
  assert.equal(after.currentSyncRunId, null);
});

test('a failed attempt with retries left is recorded as retrying, the last one as failed', async () => {
  const tenant = await factories.tenant.create({ status: 'active' });
  const tenantId = String(tenant._id);
  const connector = await connectorRepository.create({ tenantId, type: 'csv', name: 'flaky', status: 'active' });
  const connectorId = String(connector._id);
  const captured = captureQueue();
  const queued = await connectorService.syncFileUpload({ tenantId, connectorId, buffer: Buffer.from('id\n1\n'), filename: 'f.csv' });
  assert.ok(await waitFor(() => captured.length === 1));
  const job = captured[0];

  // Break persistence for this attempt (transient error).
  const original = ConnectorRow.bulkWrite;
  ConnectorRow.bulkWrite = async () => { throw new Error('transient write failure'); };
  try {
    await assert.rejects(() => connectorService.processSyncMessage({ ...job, attemptsMade: 0, attempts: 2 }));
    let run = await syncRunRepository.findById(queued.syncRunId, { tenantId });
    assert.equal(run.status, 'retrying');
    assert.equal(run.attempts, 1);
    let c = await connectorRepository.findById(connectorId, { tenantId });
    assert.equal(c.syncStatus, 'queued', 'slot kept for the retry');
    assert.ok(c.syncLeaseUntil > new Date());

    await assert.rejects(() => connectorService.processSyncMessage({ ...job, attemptsMade: 1, attempts: 2 }));
    run = await syncRunRepository.findById(queued.syncRunId, { tenantId });
    assert.equal(run.status, 'failed');
    assert.equal(run.attempts, 2);
    // The run is tenant-visible: it stores the tenant-safe message, never
    // the raw driver / library text (operators get that in the log).
    assert.equal(run.error.code, 'CONNECTOR_SYNC_FAILED');
    assert.doesNotMatch(run.error.message, /transient write failure/);
    c = await connectorRepository.findById(connectorId, { tenantId });
    assert.equal(c.syncStatus, 'failed');
    assert.equal(c.currentSyncRunId, null);
  } finally {
    ConnectorRow.bulkWrite = original;
  }
});
