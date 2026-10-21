/**
 * Async analytics export, end to end over HTTP (roadmap 1.5, finding ana.08):
 *
 *   POST /analytics/export -> analytics queue (type 'export') -> worker writes
 *   the whole result to storage -> GET /analytics/exports/:id reaches
 *   `ready` -> GET /analytics/exports/:id/download returns a short-lived
 *   signed URL that serves the file.
 *
 * Plus: tenant isolation (another workspace can neither read the export nor
 * export this workspace's datasets), owner-only access inside a workspace,
 * permission gates (analytics.export), strict input (pagination, format),
 * 409 until ready, inactive workspaces, idempotent redelivery.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse/sync';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import { shortToken } from '../../src/utils/id.js';
import { hash } from '../../src/utils/password.js';
import * as tenantService from '../../src/services/tenant.service.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import userRepository from '../../src/repositories/user.repository.js';
import connectorRepository from '../../src/repositories/connector.repository.js';
import tenantRepository from '../../src/repositories/tenant.repository.js';
import * as analyticsRepository from '../../src/repositories/analytics.repository.js';
import * as analyticsExportService from '../../src/services/analyticsExport.service.js';
import { handleAnalyticsJob } from '../../src/jobs/analytics.worker.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import { AnalyticsQuery } from '../../src/models/AnalyticsQuery.js';
import * as storageService from '../../src/services/storage.service.js';
import * as queueService from '../../src/services/queue.service.js';
import { QUEUE_NAMES } from '../../src/queues/constants.js';
import { Job } from 'bullmq';

const PASSWORD = 'Password123!';
let baseUrl;

before(async () => { await startMongo(); baseUrl = await startHttp(); });
beforeEach(async () => { await resetMongo(); await rbacCache.clearAll(); await cacheService.flushAll(); });
after(async () => { await stopHttp(); await stopMongo(); });

async function login(tenantId, email) {
  const res = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email, password: PASSWORD } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return { authorization: `Bearer ${res.json.data.accessToken}`, 'X-Tenant-Id': tenantId };
}

async function onboard(rows = 250) {
  const owner = { email: `owner-${shortToken(10).toLowerCase()}@example.com`, name: 'Owner', password: PASSWORD };
  const { tenant } = await tenantService.create({ tenant: { name: `Exp ${shortToken(10)}` }, owner, initialize: true, by: 'root' });
  const tenantId = tenant._id.toString();
  const auth = await login(tenantId, owner.email);
  const connector = await connectorRepository.create({ tenantId, type: 'csv', name: 'Orders', status: 'active' });
  await ConnectorRow.collection.insertMany(Array.from({ length: rows }, (_, i) => ({
    tenantId, connectorId: connector._id, sourceRowId: `r${i}`, data: { order_id: i, region: i % 2 ? 'EU' : 'US', amount: String(i) },
  })));
  const user = await mongoose.model('User').findOne({ tenantId, email: owner.email }).lean();
  return { tenantId, auth, datasetId: String(connector._id), userId: String(user._id) };
}

async function pollExport(auth, id, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await api(`/api/v1/analytics/exports/${id}`, { headers: auth });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    if (['ready', 'failed'].includes(res.json.data.status)) return res.json.data;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('export did not finish');
}

async function download(url) {
  const res = await fetch(url.startsWith('/') ? `${baseUrl}${url}` : url);
  return { res, body: Buffer.from(await res.arrayBuffer()) };
}

test('an export runs end to end: queued, written in full, downloadable through a signed URL', async () => {
  const { auth, datasetId } = await onboard(250);

  const queued = await api('/api/v1/analytics/export', { method: 'POST', headers: auth, body: { connectorIds: [datasetId], format: 'xlsx' } });
  assert.equal(queued.status, 202, JSON.stringify(queued.json));
  assert.equal(queued.json.data.status, 'pending');
  assert.equal(queued.json.data.format, 'xlsx');
  const { exportId } = queued.json.data;

  const done = await pollExport(auth, exportId);
  assert.equal(done.status, 'ready', done.error);
  assert.equal(done.rowCount, 250, 'every row, not one page');
  assert.equal(done.truncated, false);
  assert.match(done.fileName, /^analytics-export-\d{4}-\d{2}-\d{2}-\d{4}\.xlsx$/);
  assert.equal(done.error, null);

  const dl = await api(`/api/v1/analytics/exports/${exportId}/download`, { headers: auth });
  assert.equal(dl.status, 200, JSON.stringify(dl.json));
  assert.equal(dl.json.data.fileName, done.fileName);
  assert.equal(dl.json.data.rowCount, 250);
  assert.match(dl.json.data.url, /^\/api\/v1\/files\//);
  assert.ok(new Date(dl.json.data.expiresAt) > new Date());
  const file = await download(dl.json.data.url);
  assert.equal(file.res.status, 200);
  assert.equal(file.res.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(file.res.headers.get('content-disposition'), `attachment; filename="${done.fileName}"`);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.body);
  assert.equal(workbook.worksheets[0].actualRowCount, 251);

  // CSV of a grouped query (the history shows the export too).
  const csv = await api('/api/v1/analytics/export', {
    method: 'POST', headers: auth,
    body: { connectorIds: [datasetId], groupBy: ['region'], metrics: [{ op: 'count' }], orderBy: ['region'], format: 'csv' },
  });
  assert.equal(csv.status, 202, JSON.stringify(csv.json));
  const csvDone = await pollExport(auth, csv.json.data.exportId);
  assert.equal(csvDone.rowCount, 2);
  const csvDl = await api(`/api/v1/analytics/exports/${csv.json.data.exportId}/download`, { headers: auth });
  const csvFile = await download(csvDl.json.data.url);
  assert.equal(csvFile.res.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.deepEqual(parseCsv(csvFile.body.toString('utf8'), { columns: true }), [{ region: 'EU', count: '125' }, { region: 'US', count: '125' }]);

  const history = await api('/api/v1/analytics/queries', { headers: auth });
  assert.ok(history.json.data.some((q) => String(q._id) === exportId && q.kind === 'export'));
});

test('exports are tenant-isolated and visible only to the user who asked', async () => {
  const a = await onboard(5);
  const b = await onboard(5);
  const queued = await api('/api/v1/analytics/export', { method: 'POST', headers: a.auth, body: { connectorIds: [a.datasetId] } });
  const { exportId } = queued.json.data;
  assert.equal((await pollExport(a.auth, exportId)).status, 'ready');

  // Another workspace: 404 on status and download, and it cannot export A's dataset.
  assert.equal((await api(`/api/v1/analytics/exports/${exportId}`, { headers: b.auth })).status, 404);
  assert.equal((await api(`/api/v1/analytics/exports/${exportId}/download`, { headers: b.auth })).status, 404);
  const foreign = await api('/api/v1/analytics/export', { method: 'POST', headers: b.auth, body: { connectorIds: [a.datasetId] } });
  assert.equal(foreign.status, 400);
  assert.deepEqual(foreign.json.errors, [{ field: 'connectorIds[0]', message: 'is not a dataset of this workspace' }]);
  // Header spoofing: B's token with A's tenant id is refused by tenant resolution.
  const spoof = await api(`/api/v1/analytics/exports/${exportId}`, { headers: { ...b.auth, 'X-Tenant-Id': a.tenantId } });
  assert.ok([401, 403, 404].includes(spoof.status), `spoofed tenant header: ${spoof.status}`);

  // Another user of the same workspace does not see it either.
  await assert.rejects(
    () => analyticsExportService.getStatus({ tenantId: a.tenantId, actorId: 'someone-else', exportId }),
    (e) => e.statusCode === 404,
  );
  await assert.rejects(
    () => analyticsExportService.getDownload({ tenantId: a.tenantId, actorId: 'someone-else', exportId }),
    (e) => e.statusCode === 404,
  );
  // An export without tenant data never reads another workspace's rows.
  const all = await api('/api/v1/analytics/export', { method: 'POST', headers: b.auth, body: { format: 'json' } });
  const allDone = await pollExport(b.auth, all.json.data.exportId);
  assert.equal(allDone.rowCount, 5, 'only workspace B rows');
});

test('export routes require analytics.export', async () => {
  const { tenantId, datasetId, auth } = await onboard(1);
  const queued = await api('/api/v1/analytics/export', { method: 'POST', headers: auth, body: { connectorIds: [datasetId] } });
  const { exportId } = queued.json.data;
  await pollExport(auth, exportId);

  const email = `nobody-${shortToken(10).toLowerCase()}@example.com`;
  await userRepository.create({ tenantId, email, status: 'active', passwordHash: await hash(PASSWORD), profile: { name: 'Nobody' } });
  const noRights = await login(tenantId, email);
  assert.equal((await api('/api/v1/analytics/export', { method: 'POST', headers: noRights, body: { connectorIds: [datasetId] } })).status, 403);
  assert.equal((await api(`/api/v1/analytics/exports/${exportId}`, { headers: noRights })).status, 403);
  assert.equal((await api(`/api/v1/analytics/exports/${exportId}/download`, { headers: noRights })).status, 403);
  assert.equal((await api(`/api/v1/analytics/exports/${exportId}`)).status, 401);
});

test('export input is strict, and download is refused until the export is ready', async () => {
  const { tenantId, auth, datasetId, userId } = await onboard(1);
  const paged = await api('/api/v1/analytics/export', { method: 'POST', headers: auth, body: { connectorIds: [datasetId], pagination: { page: 2 } } });
  assert.equal(paged.status, 400);
  assert.equal(paged.json.code, 'INVALID_QUERY');
  assert.ok(paged.json.errors.some((e) => e.field === 'pagination'));
  const pdf = await api('/api/v1/analytics/export', { method: 'POST', headers: auth, body: { format: 'pdf' } });
  assert.ok([400, 422].includes(pdf.status), `format pdf: ${pdf.status}`);
  assert.equal((await api('/api/v1/analytics/exports/not-an-id', { headers: auth })).status, 422);
  assert.equal((await api(`/api/v1/analytics/exports/${new mongoose.Types.ObjectId()}`, { headers: auth })).status, 404);

  // A pending export (worker not run yet) answers 409 EXPORT_NOT_READY.
  const pending = await analyticsRepository.createQuery({
    tenantId, createdBy: userId, params: { connectorIds: [datasetId] }, status: 'pending', kind: 'export', artifact: { format: 'csv' },
  });
  const notReady = await api(`/api/v1/analytics/exports/${pending._id}/download`, { headers: auth });
  assert.equal(notReady.status, 409);
  assert.equal(notReady.json.code, 'EXPORT_NOT_READY');
  const status = await api(`/api/v1/analytics/exports/${pending._id}`, { headers: auth });
  assert.equal(status.json.data.status, 'pending');
  assert.equal(status.json.data.fileName, null);
  // A failed export also refuses the download, and says why.
  await analyticsRepository.updateResult(tenantId, String(pending._id), { status: 'failed', error: 'boom' });
  const failed = await api(`/api/v1/analytics/exports/${pending._id}/download`, { headers: auth });
  assert.equal(failed.status, 409);
  assert.match(failed.json.message, /failed/);
  assert.equal((await api(`/api/v1/analytics/exports/${pending._id}`, { headers: auth })).json.data.error, 'boom');
});

test('the worker: idempotent on redelivery, skips inactive workspaces, records failures', async () => {
  const { tenantId, datasetId } = await onboard(3);
  const exp = await analyticsExportService.scheduleExport({ tenantId, actorId: 'u1', format: 'csv', query: { connectorIds: [datasetId] } });
  // The in-memory queue already ran it; a redelivered job does nothing.
  for (let i = 0; i < 50; i += 1) {
    const doc = await AnalyticsQuery.findById(exp.exportId).lean();
    if (doc.status === 'ready') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const ready = await AnalyticsQuery.findById(exp.exportId).lean();
  assert.equal(ready.status, 'ready');
  assert.deepEqual(await analyticsExportService.processExport({ tenantId, exportId: exp.exportId }), { status: 'skipped' });
  assert.equal((await AnalyticsQuery.findById(exp.exportId).lean()).artifact.resultKey, ready.artifact.resultKey);
  assert.ok(await storageService.exists(ready.artifact.resultKey));
  // Another tenant's id cannot claim it.
  assert.deepEqual(await analyticsExportService.processExport({ tenantId: 'other', exportId: exp.exportId }), { status: 'skipped' });

  // A running export whose worker died is taken over by a redelivered job
  // once it is stale; a fresh running one is left to its worker.
  const fresh = await analyticsRepository.createQuery({
    tenantId, createdBy: 'u1', params: { connectorIds: [datasetId] }, status: 'running', kind: 'export', artifact: { format: 'csv', startedAt: new Date() },
  });
  assert.deepEqual(await analyticsExportService.processExport({ tenantId, exportId: String(fresh._id) }), { status: 'skipped' });
  const stale = await analyticsRepository.createQuery({
    tenantId, createdBy: 'u1', params: { connectorIds: [datasetId] }, status: 'running', kind: 'export', artifact: { format: 'csv', startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
  });
  const retaken = await analyticsExportService.processExport({ tenantId, exportId: String(stale._id) });
  assert.equal(retaken.status, 'ready');
  assert.equal(retaken.rowCount, 3);

  // A stored query the contract rejects fails with its field errors.
  const bad = await analyticsRepository.createQuery({
    tenantId, createdBy: 'u1', params: { filters: [{ field: 'region', op: 'like', value: 'E' }] }, status: 'pending', kind: 'export', artifact: { format: 'json' },
  });
  await handleAnalyticsJob({ data: { type: 'export', tenantId, params: { exportId: String(bad._id) } } });
  const failed = await AnalyticsQuery.findById(bad._id).lean();
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /filters\[0\]\.op/);
  assert.equal(failed.artifact.resultKey, null);

  // A workspace that is no longer active: the queued export is not run.
  const queued = await analyticsRepository.createQuery({
    tenantId, createdBy: 'u1', params: {}, status: 'pending', kind: 'export', artifact: { format: 'csv' },
  });
  await tenantRepository.update(tenantId, { status: 'suspended' });
  await handleAnalyticsJob({ data: { type: 'export', tenantId, params: { exportId: String(queued._id) } } });
  const skipped = await AnalyticsQuery.findById(queued._id).lean();
  assert.equal(skipped.status, 'failed');
  assert.equal(skipped.error, 'Skipped: the workspace is not active');
  // A redelivered job of an export that already finished leaves it ready.
  await handleAnalyticsJob({ data: { type: 'export', tenantId, params: { exportId: exp.exportId } } });
  const stillReady = await AnalyticsQuery.findById(exp.exportId).lean();
  assert.equal(stillReady.status, 'ready');
  assert.equal(stillReady.error, null);
});

test('export jobs are queued under a deterministic job id that BullMQ accepts', async () => {
  const { tenantId, datasetId } = await onboard(2);
  const completed = [];
  const off = queueService.on(QUEUE_NAMES.ANALYTICS_JOBS, 'completed', (job) => {
    if (job?.data?.type === 'export') completed.push(job.id);
  });
  try {
    const exp = await analyticsExportService.scheduleExport({ tenantId, actorId: 'u1', format: 'csv', query: { connectorIds: [datasetId] } });
    for (let i = 0; i < 100 && !completed.length; i += 1) await new Promise((r) => setTimeout(r, 20));
    const jobId = analyticsExportService.exportJobId(exp.exportId);
    assert.deepEqual(completed, [jobId], 'the queued job carries the export job id');

    // BullMQ's own job-option validation (what Queue.add runs with REDIS_URL):
    // it refuses integer ids and ids containing ':' (e.g. 'export:<id>').
    const validate = (id) => Job.prototype.validateOptions.call({ opts: { jobId: id }, name: 'export' }, { data: '{}' });
    assert.doesNotThrow(() => validate(jobId));
    assert.throws(() => validate(`export:${exp.exportId}`), /Custom Id cannot contain :/, 'the validator is the real BullMQ rule');
  } finally {
    off?.();
  }
});
