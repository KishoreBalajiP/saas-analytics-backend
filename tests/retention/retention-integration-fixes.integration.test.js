/**
 * Retention x audit/reports integration (roadmap 2.5 + 2.7 + 1.5).
 *
 * Covers two behaviours that only exist once the packages are combined:
 *   - The audit trail is hash-chained (audit package). A retention run that
 *     stops at its batch cap must delete a contiguous prefix of the chain, so
 *     the remaining trail still verifies (anchored at its first row).
 *   - Analytics exports (reports package) keep their file in storage. The
 *     retention job expires that file after RETENTION_EXPORT_DAYS (download
 *     then answers 410 EXPORT_EXPIRED) and never deletes an export record
 *     that still owns a stored file, so no object is orphaned.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import retentionService from '../../src/services/retention.service.js';
import auditLogRepository from '../../src/repositories/auditLog.repository.js';
import { verifyAuditChain } from '../../src/services/auditChain.service.js';
import * as storageService from '../../src/services/storage.service.js';
import * as analyticsExportService from '../../src/services/analyticsExport.service.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { AnalyticsQuery } from '../../src/models/AnalyticsQuery.js';
import { Report } from '../../src/models/Report.js';
import * as reportService from '../../src/services/report.service.js';
import mongoose from 'mongoose';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();
const ago = (days) => new Date(NOW.getTime() - days * DAY);

/** Explicit windows so the tests do not depend on the runner's env. */
const SETTINGS = Object.freeze({
  auditLogDays: 90,
  analyticsQueryDays: 90,
  exportDays: 1,
  batchSize: 2,
  maxBatchesPerRun: 1,
  legalHoldTenantIds: [],
});

before(async () => {
  await startMongo();
  await resetMongo();
});
after(async () => { await stopMongo(); });

test('a partial audit purge removes a contiguous prefix, so the chain still verifies', async () => {
  // Eight chained rows: the first five are past the 90-day window.
  for (let i = 0; i < 8; i += 1) {
    await auditLogRepository.insert({
      actor: { type: 'system', id: null },
      action: `retention.test.${i}`,
      module: 'test',
      tenantId: null,
      occurredAt: ago(i < 5 ? 200 - i : 10 - i),
    });
  }
  assert.equal((await verifyAuditChain()).ok, true, 'chain verifies before the purge');

  // Batch cap: 2 rows per batch, 1 batch per run, so each run removes 2 rows.
  const first = await retentionService.runRetention({ now: NOW, dryRun: false, settings: SETTINGS, only: ['auditLogs'] });
  const firstPolicy = first.policies.find((p) => p.key === 'auditLogs');
  assert.equal(firstPolicy.deleted, 2);
  const remaining = (await AuditLog.find({}).sort({ seq: 1 }).lean()).map((r) => r.seq);
  assert.deepEqual(remaining, [3, 4, 5, 6, 7, 8], 'the oldest seqs went first, with no gap');
  const midway = await verifyAuditChain();
  assert.equal(midway.ok, true, JSON.stringify(midway));
  assert.equal(midway.anchored, true, 'the first remaining row is the anchor');

  // Further runs finish the expired prefix and stop at the window.
  await retentionService.runRetention({ now: NOW, dryRun: false, settings: SETTINGS, only: ['auditLogs'] });
  await retentionService.runRetention({ now: NOW, dryRun: false, settings: SETTINGS, only: ['auditLogs'] });
  const kept = (await AuditLog.find({}).sort({ seq: 1 }).lean()).map((r) => r.seq);
  assert.deepEqual(kept, [6, 7, 8], 'rows inside the window are kept');
  assert.equal((await verifyAuditChain()).ok, true);
});

test('analytics export files expire with a 410, and records owning a live file are never purged', async () => {
  const tenantId = 'tenant-retention-exports';
  const actorId = 'user-1';
  const expiredKey = `exports/${tenantId}/old.csv`;
  const liveKey = `exports/${tenantId}/live.csv`;
  await storageService.put(expiredKey, Buffer.from('a,b\n1,2\n'), { contentType: 'text/csv' });
  await storageService.put(liveKey, Buffer.from('a,b\n3,4\n'), { contentType: 'text/csv' });

  const base = { tenantId, createdBy: actorId, kind: 'export', status: 'ready' };
  const expired = await AnalyticsQuery.create({
    ...base,
    artifact: { format: 'csv', resultKey: expiredKey, fileName: 'old.csv', contentType: 'text/csv', finishedAt: ago(3) },
  });
  // The record is older than the 90-day record window, but its file was
  // regenerated recently and is still inside the export window: the record
  // must survive with its file.
  const live = await AnalyticsQuery.create({
    ...base,
    artifact: { format: 'csv', resultKey: liveKey, fileName: 'live.csv', contentType: 'text/csv', finishedAt: ago(0.5) },
  });
  await AnalyticsQuery.collection.updateOne({ _id: live._id }, { $set: { createdAt: ago(100) } });

  // 1-day export window: only the 3-day-old file expires.
  await retentionService.runRetention({
    now: NOW, dryRun: false, settings: { ...SETTINGS, exportDays: 1, maxBatchesPerRun: 10 }, only: ['analyticsExports'],
  });
  const expiredDoc = await AnalyticsQuery.findById(expired._id).lean();
  assert.equal(expiredDoc.artifact.resultKey, null);
  assert.ok(expiredDoc.artifact.expiredAt, 'expiredAt recorded');
  assert.equal(await storageService.exists(expiredKey), false, 'stored file deleted');
  await assert.rejects(
    () => analyticsExportService.getDownload({ tenantId, actorId, exportId: String(expired._id) }),
    (err) => err.statusCode === 410 && err.code === 'EXPORT_EXPIRED',
  );

  // The 100-day-old live record is past the record window, but its file is
  // still stored: it is kept, file and all.
  await retentionService.runRetention({
    now: NOW, dryRun: false, settings: { ...SETTINGS, exportDays: 1, maxBatchesPerRun: 10 }, only: ['analyticsExports', 'analyticsQueries'],
  });
  assert.ok(await AnalyticsQuery.findById(live._id).lean(), 'record with a live file is kept');
  assert.equal(await storageService.exists(liveKey), true);

  // Tenant purges cover analytics export files too.
  assert.ok(retentionService.tenantStoragePrefixes(tenantId).includes(`exports/${tenantId}/`));
});

test('a report download without runId answers 410 when the newest ready file has expired', async () => {
  const reportId = new mongoose.Types.ObjectId();
  const olderRun = new mongoose.Types.ObjectId();
  const newestRun = new mongoose.Types.ObjectId();
  const olderKey = `reports/t-dl/${reportId}/${olderRun}.csv`;
  await storageService.put(olderKey, Buffer.from('a\n1\n'));
  await Report.collection.insertOne({
    _id: reportId, tenantId: 't-dl', name: 'R', status: 'active', deletedAt: null,
    runs: [
      { _id: olderRun, status: 'ready', format: 'csv', resultKey: olderKey, finishedAt: ago(2) },
      // The newest run's file was removed by the retention job.
      { _id: newestRun, status: 'ready', format: 'csv', resultKey: null, expiredAt: ago(0.1), finishedAt: ago(1) },
    ],
  });
  await assert.rejects(
    () => reportService.download({ tenantId: 't-dl', reportId: String(reportId) }),
    (err) => err.statusCode === 410 && err.code === 'EXPORT_EXPIRED',
    'the newest file expired: no silent fallback to an older file',
  );
  const older = await reportService.download({ tenantId: 't-dl', reportId: String(reportId), runId: String(olderRun) });
  assert.equal(older.runId, String(olderRun));
});
