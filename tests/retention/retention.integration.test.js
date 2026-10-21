/**
 * Retention (roadmap 2.7; findings gov.03, ops.12, ops2.09, doc.10, gov.11,
 * db.06, ten.14): the cleanup job's policies against a real (in-memory)
 * MongoDB with a fixed clock.
 *
 * Exit criteria covered here:
 *   - each collection is purged by its own window and nothing newer is
 *     touched;
 *   - a dry run deletes nothing;
 *   - cleanup removes expired export / report artefacts from storage;
 *   - legal holds, bounded batches, append-only audit truncation,
 *     soft-delete purge, deleted-user anonymisation, archived-tenant purge,
 *     declared policies, the job's JobRun report and the operator script.
 *
 * The clock is pinned in the future (2030) so the TTL indexes of the real
 * server never remove seeded rows while a test runs.
 */

import test, { describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import clock from '../../src/utils/clock.js';
import env from '../../src/config/env.js';
import retentionService from '../../src/services/retention.service.js';
import * as storageService from '../../src/services/storage.service.js';
import * as reportService from '../../src/services/report.service.js';
import userRepository from '../../src/repositories/user.repository.js';
import cleanupJob from '../../src/jobs/cleanup.job.js';
import { runJob, resetSchedulerForTests } from '../../src/jobs/scheduler.js';
import { run as runRetentionScript, parseArgs } from '../../scripts/ci/run-retention.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { AccessLog } from '../../src/models/AccessLog.js';
import { LoginAttempt } from '../../src/models/LoginAttempt.js';
import { Session } from '../../src/models/Session.js';
import { PasswordResetToken } from '../../src/models/PasswordResetToken.js';
import { EmailVerificationToken } from '../../src/models/EmailVerificationToken.js';
import { TenantInvitation } from '../../src/models/TenantInvitation.js';
import { Notification } from '../../src/models/Notification.js';
import { AlertEvent } from '../../src/models/AlertEvent.js';
import { AnalyticsQuery } from '../../src/models/AnalyticsQuery.js';
import { JobRun } from '../../src/models/JobRun.js';
import { SyncRun } from '../../src/models/SyncRun.js';
import { OutboundEmail } from '../../src/models/OutboundEmail.js';
import { AuditExport } from '../../src/models/AuditExport.js';
import { Report } from '../../src/models/Report.js';
import { User } from '../../src/models/User.js';
import { UserRole } from '../../src/models/UserRole.js';
import { Tenant } from '../../src/models/Tenant.js';
import { Connector } from '../../src/models/Connector.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import { Dashboard } from '../../src/models/Dashboard.js';
import { PaymentTransaction } from '../../src/models/PaymentTransaction.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2030-01-15T03:00:00.000Z');
const ago = (days) => new Date(NOW.getTime() - days * DAY);
const later = (days) => new Date(NOW.getTime() + days * DAY);
const oid = () => new mongoose.Types.ObjectId();

/** Explicit windows so the tests do not depend on the runner's env. */
const SETTINGS = Object.freeze({
  auditLogDays: 90,
  accessLogDays: 30,
  loginAttemptDays: 30,
  sessionDays: 90,
  expiredTokenDays: 1,
  notificationDays: 90,
  alertEventDays: 180,
  analyticsQueryDays: 90,
  jobRunDays: 30,
  syncRunDays: 90,
  outboxDays: 30,
  exportDays: 1,
  exportRecordDays: 30,
  reportArtifactDays: 30,
  softDeleteDays: 30,
  deletedUserDays: 30,
  archivedTenantDays: 0,
  batchSize: 500,
  maxBatchesPerRun: 200,
  legalHoldTenantIds: [],
});

const run = (overrides = {}, opts = {}) =>
  retentionService.runRetention({ now: NOW, dryRun: false, settings: { ...SETTINGS, ...overrides }, ...opts });

const policy = (report, key) => report.policies.find((p) => p.key === key);
const ids = async (model) => (await model.collection.find({}, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id));

/** Fields carrying unique indexes, filled with distinct values when absent. */
const UNIQUE_FIELDS = {
  Session: ['sessionId', 'refreshTokenHash'],
  PasswordResetToken: ['tokenHash'],
  EmailVerificationToken: ['tokenHash'],
  TenantInvitation: ['tokenHash', 'invitedEmail'],
  OutboundEmail: ['dedupeKey'],
  AuditExport: ['exportId'],
  ConnectorRow: ['sourceRowId'],
  PaymentTransaction: ['providerOrderId'],
};

async function insert(model, docs) {
  const withIds = docs.map((d) => {
    const doc = { _id: oid(), ...d };
    for (const field of UNIQUE_FIELDS[model.modelName] ?? []) {
      if (doc[field] === undefined) doc[field] = `${field}-${oid().toHexString()}`;
    }
    return doc;
  });
  await model.collection.insertMany(withIds);
  return withIds.map((d) => String(d._id));
}

before(async () => {
  await startMongo();
});

after(async () => {
  clock.reset();
  await stopMongo();
});

beforeEach(async () => {
  await resetMongo();
  clock.set(NOW);
});

afterEach(() => {
  clock.reset();
});

/* ------------------------- per-collection windows ------------------------ */

/** One expired and one fresh row per simple policy (tenant t1). */
async function seedWindows() {
  const s = {};
  [s.auditOld, s.auditNew] = await insert(AuditLog, [
    { tenantId: 't1', module: 'm', action: 'a', occurredAt: ago(91) },
    { tenantId: 't1', module: 'm', action: 'a', occurredAt: ago(89) },
  ]);
  [s.accessOld, s.accessNew] = await insert(AccessLog, [
    { tenantId: 't1', path: '/x', occurredAt: ago(31) },
    { tenantId: 't1', path: '/x', occurredAt: ago(29) },
  ]);
  [s.loginOld, s.loginNew] = await insert(LoginAttempt, [
    { tenantId: 't1', email: 'a@example.com', occurredAt: ago(31) },
    { tenantId: 't1', email: 'a@example.com', occurredAt: ago(29) },
  ]);
  [s.sessionOld, s.sessionNew, s.sessionActive] = await insert(Session, [
    { tenantId: 't1', status: 'revoked', updatedAt: ago(91), expiresAt: later(10) },
    { tenantId: 't1', status: 'revoked', updatedAt: ago(89), expiresAt: later(10) },
    // Active and unexpired: never purged, however old.
    { tenantId: 't1', status: 'active', updatedAt: ago(400), expiresAt: later(10) },
  ]);
  [s.resetOld, s.resetNew] = await insert(PasswordResetToken, [
    { tenantId: 't1', usedAt: ago(2), expiresAt: later(1) },
    { tenantId: 't1', usedAt: new Date(NOW.getTime() - 12 * 60 * 60 * 1000), expiresAt: later(1) },
  ]);
  [s.verifyOld, s.verifyNew] = await insert(EmailVerificationToken, [
    { tenantId: 't1', status: 'used', usedAt: ago(3), expiresAt: later(1) },
    { tenantId: 't1', status: 'pending', usedAt: null, expiresAt: later(1) },
  ]);
  [s.inviteOld, s.inviteNew, s.invitePending] = await insert(TenantInvitation, [
    { tenantId: 't1', status: 'accepted', updatedAt: ago(2), expiresAt: later(1) },
    { tenantId: 't1', status: 'accepted', updatedAt: new Date(NOW.getTime() - 60 * 60 * 1000), expiresAt: later(1) },
    { tenantId: 't1', status: 'pending', updatedAt: ago(5), expiresAt: later(1) },
  ]);
  [s.notifOld, s.notifNew] = await insert(Notification, [
    { tenantId: 't1', createdAt: ago(91) },
    { tenantId: 't1', createdAt: ago(89) },
  ]);
  [s.alertOld, s.alertNew] = await insert(AlertEvent, [
    { tenantId: 't1', triggeredAt: ago(181) },
    { tenantId: 't1', triggeredAt: ago(179) },
  ]);
  [s.queryOld, s.queryNew] = await insert(AnalyticsQuery, [
    { tenantId: 't1', createdAt: ago(91) },
    { tenantId: 't1', createdAt: ago(89) },
  ]);
  [s.jobOld, s.jobNew, s.jobRunning] = await insert(JobRun, [
    { job: 'x', status: 'succeeded', startedAt: ago(31), finishedAt: ago(31) },
    { job: 'x', status: 'succeeded', startedAt: ago(29), finishedAt: ago(29) },
    { job: 'x', status: 'running', startedAt: ago(60), finishedAt: null },
  ]);
  [s.syncOld, s.syncNew, s.syncOpen] = await insert(SyncRun, [
    { tenantId: 't1', status: 'succeeded', finishedAt: ago(91) },
    { tenantId: 't1', status: 'failed', finishedAt: ago(89) },
    { tenantId: 't1', status: 'running', finishedAt: null, createdAt: ago(200) },
  ]);
  [s.mailOld, s.mailNew, s.mailPending] = await insert(OutboundEmail, [
    { tenantId: 't1', status: 'sent', updatedAt: ago(31) },
    { tenantId: 't1', status: 'dead', updatedAt: ago(29) },
    // Still to be delivered: never purged.
    { tenantId: 't1', status: 'retrying', updatedAt: ago(90) },
  ]);
  [s.exportOld, s.exportNew, s.exportLive] = await insert(AuditExport, [
    { exportId: 'exp_old', tenantId: 't1', status: 'failed', createdAt: ago(31) },
    { exportId: 'exp_new', tenantId: 't1', status: 'failed', createdAt: ago(29) },
    // Old request whose file is still within its window: kept.
    { exportId: 'exp_live', tenantId: 't1', status: 'completed', storageKey: 'audit/exports/t1/exp_live.json', expiresAt: later(1), createdAt: ago(40) },
  ]);
  return s;
}

const WINDOWED = [
  ['auditLogs', AuditLog, 'auditOld', ['auditNew']],
  ['accessLogs', AccessLog, 'accessOld', ['accessNew']],
  ['loginAttempts', LoginAttempt, 'loginOld', ['loginNew']],
  ['sessions', Session, 'sessionOld', ['sessionNew', 'sessionActive']],
  ['passwordResetTokens', PasswordResetToken, 'resetOld', ['resetNew']],
  ['emailVerificationTokens', EmailVerificationToken, 'verifyOld', ['verifyNew']],
  ['tenantInvitations', TenantInvitation, 'inviteOld', ['inviteNew', 'invitePending']],
  ['notifications', Notification, 'notifOld', ['notifNew']],
  ['alertEvents', AlertEvent, 'alertOld', ['alertNew']],
  ['analyticsQueries', AnalyticsQuery, 'queryOld', ['queryNew']],
  ['jobRuns', JobRun, 'jobOld', ['jobNew', 'jobRunning']],
  ['syncRuns', SyncRun, 'syncOld', ['syncNew', 'syncOpen']],
  ['outboundEmails', OutboundEmail, 'mailOld', ['mailNew', 'mailPending']],
  ['exportRecords', AuditExport, 'exportOld', ['exportNew', 'exportLive']],
];

describe('retention windows', () => {
  test('each collection is purged by its own window and nothing newer is touched', async () => {
    const s = await seedWindows();
    const report = await run();
    assert.equal(report.dryRun, false);
    assert.equal(report.totals.errors, 0, JSON.stringify(report.policies.filter((p) => p.error)));

    for (const [key, model, oldKey, keptKeys] of WINDOWED) {
      const remaining = await ids(model);
      assert.ok(!remaining.includes(s[oldKey]), `${key}: the expired row is deleted`);
      for (const k of keptKeys) assert.ok(remaining.includes(s[k]), `${key}: ${k} is kept`);
      assert.equal(policy(report, key).deleted, 1, `${key}: exactly one row deleted`);
    }
  });

  test('a dry run deletes nothing and reports what it would delete', async () => {
    await seedWindows();
    const before = {};
    for (const [key, model] of WINDOWED) before[key] = (await ids(model)).length;

    const report = await run({}, { dryRun: true });
    assert.equal(report.dryRun, true);
    for (const [key, model] of WINDOWED) {
      assert.equal((await ids(model)).length, before[key], `${key}: nothing deleted in a dry run`);
      assert.equal(policy(report, key).matched, 1, `${key}: one row would be deleted`);
      assert.equal(policy(report, key).deleted, 0);
    }
    assert.equal(report.totals.deleted, 0);
    assert.ok(report.totals.matched >= WINDOWED.length);
  });

  test('a window of 0 disables that policy', async () => {
    const s = await seedWindows();
    const report = await run({ accessLogDays: 0 });
    assert.equal(policy(report, 'accessLogs').skipped, 'disabled');
    assert.ok((await ids(AccessLog)).includes(s.accessOld));
  });

  test('purges run in bounded batches and the rest is left for the next run', async () => {
    await insert(AccessLog, Array.from({ length: 5 }, () => ({ tenantId: 't1', occurredAt: ago(40) })));
    const first = await run({ batchSize: 2, maxBatchesPerRun: 2 }, { only: ['accessLogs'] });
    assert.equal(policy(first, 'accessLogs').deleted, 4);
    assert.equal(policy(first, 'accessLogs').more, true);
    assert.equal((await ids(AccessLog)).length, 1);

    const second = await run({ batchSize: 2, maxBatchesPerRun: 2 }, { only: ['accessLogs'] });
    assert.equal(policy(second, 'accessLogs').deleted, 1);
    assert.equal(policy(second, 'accessLogs').more, false);
    assert.equal((await ids(AccessLog)).length, 0);
  });
});

/* -------------------------------- legal hold ------------------------------ */

describe('legal hold', () => {
  test('held tenants (configured or flagged) and held rows are never purged', async () => {
    const flagged = oid();
    await Tenant.collection.insertOne({ _id: flagged, name: 'Flagged', slug: 'flagged', status: 'active', legalHold: true });
    const [heldByConfig, heldByFlag, heldRow, free] = await insert(AccessLog, [
      { tenantId: 'held', occurredAt: ago(60) },
      { tenantId: String(flagged), occurredAt: ago(60) },
      { tenantId: 't1', occurredAt: ago(60), legalHold: true },
      { tenantId: 't1', occurredAt: ago(60) },
    ]);

    const report = await run({ legalHoldTenantIds: ['held'] }, { only: ['accessLogs'] });
    assert.deepEqual([...report.legalHoldTenantIds].sort(), ['held', String(flagged)].sort());
    const remaining = await ids(AccessLog);
    assert.ok(remaining.includes(heldByConfig));
    assert.ok(remaining.includes(heldByFlag));
    assert.ok(remaining.includes(heldRow));
    assert.ok(!remaining.includes(free));
  });

  test('the audit trail is only truncated from its oldest end', async () => {
    const [a, b, c, d] = await insert(AuditLog, [
      { tenantId: 't1', module: 'm', action: 'x', occurredAt: ago(200) },
      { tenantId: 'held', module: 'm', action: 'x', occurredAt: ago(150) },
      { tenantId: 't1', module: 'm', action: 'x', occurredAt: ago(120) },
      { tenantId: 't1', module: 'm', action: 'x', occurredAt: ago(10) },
    ]);
    const report = await run({ legalHoldTenantIds: ['held'] }, { only: ['auditLogs'] });
    const remaining = await ids(AuditLog);
    assert.ok(!remaining.includes(a), 'rows older than the held row go');
    assert.ok(remaining.includes(b), 'the held row stays');
    assert.ok(remaining.includes(c), 'no hole is cut after the held row');
    assert.ok(remaining.includes(d));
    assert.equal(policy(report, 'auditLogs').heldBack, true);

    // Hold lifted: the rest past the window goes.
    await run({}, { only: ['auditLogs'] });
    assert.deepEqual(await ids(AuditLog), [d]);
  });
});

/* ------------------------------ artefacts -------------------------------- */

describe('export and report artefacts', () => {
  test('expired export files are deleted from storage and the row is kept as expired', async () => {
    const key = 'audit/exports/t1/exp_ret_1.json';
    const freshKey = 'audit/exports/t1/exp_ret_2.json';
    await storageService.putJson(key, { rows: [] });
    await storageService.putJson(freshKey, { rows: [] });
    await AuditExport.collection.insertMany([
      { exportId: 'exp_ret_1', kind: 'audit', tenantId: 't1', status: 'completed', format: 'json', storageKey: key, expiresAt: ago(1), createdAt: ago(2) },
      { exportId: 'exp_ret_2', kind: 'audit', tenantId: 't1', status: 'completed', format: 'json', storageKey: freshKey, expiresAt: later(1), createdAt: ago(0.5) },
    ]);

    const dry = await run({}, { dryRun: true, only: ['exportArtifacts'] });
    assert.equal(policy(dry, 'exportArtifacts').matched, 1);
    assert.equal(await storageService.exists(key), true, 'dry run keeps the file');

    const report = await run({}, { only: ['exportArtifacts'] });
    assert.equal(policy(report, 'exportArtifacts').objectsDeleted, 1);
    assert.equal(await storageService.exists(key), false, 'expired file deleted');
    assert.equal(await storageService.exists(freshKey), true, 'file within its window kept');
    const row = await AuditExport.collection.findOne({ exportId: 'exp_ret_1' });
    assert.equal(row.status, 'expired');
    assert.equal(row.storageKey, null);
    await storageService.del(freshKey);
  });

  test('report artefacts past their window are deleted and downloads answer 410', async () => {
    const reportId = oid();
    const oldRun = oid();
    const newRun = oid();
    const oldKey = `reports/t1/${reportId}/${oldRun}.csv`;
    const newKey = `reports/t1/${reportId}/${newRun}.csv`;
    await storageService.put(oldKey, 'a,b\n1,2\n');
    await storageService.put(newKey, 'a,b\n1,2\n');
    const runs = [
      { _id: oldRun, status: 'ready', format: 'csv', resultKey: oldKey, finishedAt: ago(31) },
      { _id: newRun, status: 'ready', format: 'csv', resultKey: newKey, finishedAt: ago(1) },
    ];
    await Report.collection.insertOne({
      _id: reportId, tenantId: 't1', name: 'R', status: 'active', runs,
      lastRun: { status: 'ready', resultKey: oldKey, finishedAt: ago(31), format: 'csv' },
      deletedAt: null,
    });

    const report = await run({}, { only: ['reportArtifacts'] });
    assert.equal(policy(report, 'reportArtifacts').deleted, 1);
    assert.equal(await storageService.exists(oldKey), false);
    assert.equal(await storageService.exists(newKey), true);

    await assert.rejects(
      () => reportService.download({ tenantId: 't1', reportId: String(reportId), runId: String(oldRun) }),
      (err) => err.statusCode === 410 && err.code === 'EXPORT_EXPIRED',
    );
    // Without runId the newest ready run is served (reports' contract): here
    // that is the fresh run, not the expired one lastRun still points at.
    const latest = await reportService.download({ tenantId: 't1', reportId: String(reportId) });
    assert.equal(latest.runId, String(newRun));
    const fresh = await reportService.download({ tenantId: 't1', reportId: String(reportId), runId: String(newRun) });
    assert.equal(fresh.runId, String(newRun));
    assert.ok(fresh.url);
    // Another tenant still cannot reach the report.
    await assert.rejects(
      () => reportService.download({ tenantId: 't2', reportId: String(reportId), runId: String(newRun) }),
      (err) => err.statusCode === 404,
    );
    await storageService.del(newKey);
  });
});

/* ------------------------- soft deletes and users ------------------------ */

describe('soft-deleted data and users', () => {
  test('soft-deleted rows are hard-deleted after the window, with their files', async () => {
    const [gone, recent, live] = await insert(Dashboard, [
      { tenantId: 't1', name: 'old', deletedAt: ago(31) },
      { tenantId: 't1', name: 'recent', deletedAt: ago(5) },
      { tenantId: 't1', name: 'live', deletedAt: null },
    ]);
    const reportId = oid();
    const key = `reports/t1/${reportId}/run.csv`;
    await storageService.put(key, 'x');
    await Report.collection.insertOne({
      _id: reportId, tenantId: 't1', name: 'deleted report', deletedAt: ago(40),
      runs: [{ _id: oid(), resultKey: key, finishedAt: ago(41) }], lastRun: { resultKey: key },
    });
    const [heldDash] = await insert(Dashboard, [{ tenantId: 'held', name: 'held', deletedAt: ago(60) }]);

    const report = await run({ legalHoldTenantIds: ['held'] }, { only: ['softDeleted'] });
    const remaining = await ids(Dashboard);
    assert.ok(!remaining.includes(gone));
    assert.ok(remaining.includes(recent));
    assert.ok(remaining.includes(live));
    assert.ok(remaining.includes(heldDash));
    assert.equal(await Report.collection.countDocuments({ _id: reportId }), 0);
    assert.equal(await storageService.exists(key), false);
    const p = policy(report, 'softDeleted');
    assert.equal(p.details.Dashboard, 1);
    assert.equal(p.details.Report, 1);
    assert.equal(p.objectsDeleted, 1);
  });

  test('soft-deleted users are anonymised and removed after the window (db.06)', async () => {
    const subject = await User.create({ tenantId: 't1', email: 'subject@example.com', status: 'active', profile: { name: 'Subject Person', phone: '+15550100' } });
    await UserRole.collection.insertOne({ tenantId: 't1', userId: String(subject._id), roleId: 'r1' });
    await userRepository.softDelete(String(subject._id), 'compliance');
    // Erased "now" in real time, i.e. years before the pinned clock.
    const recent = await User.create({ tenantId: 't1', email: 'recent@example.com', status: 'active' });
    await User.collection.updateOne({ _id: recent._id }, { $set: { deletedAt: ago(5) } });
    const active = await User.create({ tenantId: 't1', email: 'active@example.com', status: 'active' });

    const dry = await run({}, { dryRun: true, only: ['deletedUsers'] });
    assert.equal(policy(dry, 'deletedUsers').matched, 1);
    assert.equal(await User.collection.countDocuments({ email: 'subject@example.com' }), 1);

    const report = await run({}, { only: ['deletedUsers'] });
    assert.equal(policy(report, 'deletedUsers').deleted, 1);
    assert.equal(policy(report, 'deletedUsers').anonymised, 1);
    assert.equal(await User.collection.countDocuments({ email: 'subject@example.com' }), 0);
    assert.equal(await User.collection.countDocuments({ _id: subject._id }), 0);
    assert.equal(await UserRole.collection.countDocuments({ userId: String(subject._id) }), 0);
    for (const coll of ['users', 'userroles']) {
      const docs = await mongoose.connection.db.collection(coll).find({}).toArray();
      assert.ok(!JSON.stringify(docs).includes('subject@example.com'), `${coll} holds no copy of the email`);
    }
    assert.equal(await User.collection.countDocuments({ _id: recent._id }), 1, 'within the window: kept');
    assert.equal(await User.collection.countDocuments({ _id: active._id }), 1, 'not deleted: kept');
  });
});

/* ---------------------------- archived tenants --------------------------- */

describe('archived tenants', () => {
  async function seedTenant({ status, archivedAt = null, legalHold = false }) {
    const _id = oid();
    await Tenant.collection.insertOne({ _id, name: `T ${_id}`, slug: `t-${_id}`, status, archivedAt, legalHold, dataPurgedAt: null });
    const tenantId = String(_id);
    await insert(User, [{ tenantId, email: `u-${tenantId}@example.com`, status: 'active' }]);
    await insert(Connector, [{ tenantId, name: 'c', type: 'csv' }]);
    await insert(ConnectorRow, [{ tenantId, data: { a: 1 } }, { tenantId, data: { a: 2 } }]);
    await insert(Dashboard, [{ tenantId, name: 'd' }]);
    await insert(AuditLog, [{ tenantId, module: 'm', action: 'a', occurredAt: ago(1) }]);
    await insert(PaymentTransaction, [{ tenantId, amount: 100 }]);
    const key = `reports/${tenantId}/r/run.csv`;
    await storageService.put(key, 'x');
    return { tenantId, _id, key };
  }

  const count = (model, tenantId) => model.collection.countDocuments({ tenantId });

  test('an archived tenant past the window loses every tenant-owned row and file', async () => {
    const archived = await seedTenant({ status: 'archived', archivedAt: ago(40) });
    const active = await seedTenant({ status: 'active' });
    const young = await seedTenant({ status: 'archived', archivedAt: ago(10) });
    const held = await seedTenant({ status: 'archived', archivedAt: ago(400), legalHold: true });

    const disabled = await run({}, { only: ['archivedTenants'] });
    assert.equal(policy(disabled, 'archivedTenants').skipped, 'disabled', 'off by default (0 days)');
    assert.equal(await count(User, archived.tenantId), 1);

    const dry = await run({ archivedTenantDays: 30 }, { dryRun: true, only: ['archivedTenants'] });
    assert.equal(policy(dry, 'archivedTenants').tenants, 1);
    assert.ok(policy(dry, 'archivedTenants').matched >= 5);
    assert.equal(await count(ConnectorRow, archived.tenantId), 2, 'dry run deletes nothing');

    const report = await run({ archivedTenantDays: 30 }, { only: ['archivedTenants'] });
    const p = policy(report, 'archivedTenants');
    assert.equal(p.tenants, 1);
    assert.equal(p.tenantsCompleted, 1);
    for (const model of [User, Connector, ConnectorRow, Dashboard]) {
      assert.equal(await count(model, archived.tenantId), 0, `${model.modelName} purged`);
      assert.ok(await count(model, active.tenantId) > 0, `${model.modelName} of an active tenant untouched`);
      assert.ok(await count(model, young.tenantId) > 0, `${model.modelName} inside the window untouched`);
      assert.ok(await count(model, held.tenantId) > 0, `${model.modelName} under legal hold untouched`);
    }
    assert.equal(await count(AuditLog, archived.tenantId), 1, 'audit trail ages out on its own window');
    assert.equal(await count(PaymentTransaction, archived.tenantId), 1, 'billing records kept');
    assert.equal(await storageService.exists(archived.key), false, 'stored files purged');
    assert.equal(await storageService.exists(active.key), true);
    const tomb = await Tenant.collection.findOne({ _id: archived._id });
    assert.ok(tomb.dataPurgedAt, 'tombstone marks the purge');

    const again = await run({ archivedTenantDays: 30 }, { only: ['archivedTenants'] });
    assert.equal(policy(again, 'archivedTenants').tenants, 0, 'a purged tenant is not processed again');
    for (const t of [active, young, held]) await storageService.del(t.key);
  });
});

/* -------------------------- declared policies ---------------------------- */

describe('declared policies (retention coverage contract)', () => {
  test('policies declared in retention.<package>.js files are applied; invalid ones are reported', async () => {
    const Probe = mongoose.models.RetentionProbe
      || mongoose.model('RetentionProbe', new mongoose.Schema({ tenantId: String, createdAt: Date }));
    const dir = path.join(env.storage.baseDir, `declared-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'retention.testpkg.js'), `export const RETENTION = [
  { model: 'RetentionProbe', field: 'createdAt', envKey: 'RETENTION_PROBE_DAYS', defaultDays: 7 },
  { model: 'not a model', field: 'createdAt', envKey: 'BAD', defaultDays: -1 },
  { model: 'AccessLog', field: 'occurredAt', envKey: 'RETENTION_DUP_DAYS', defaultDays: 1 },
];\n`);
    try {
      const [oldId, newId, heldId] = await insert(Probe, [
        { tenantId: 't1', createdAt: ago(8) },
        { tenantId: 't1', createdAt: ago(6) },
        { tenantId: 'held', createdAt: ago(30) },
      ]);
      const report = await run({ legalHoldTenantIds: ['held'] }, { declaredDir: dir });
      const p = policy(report, 'testpkg:RetentionProbe');
      assert.equal(p.deleted, 1);
      const remaining = await ids(Probe);
      assert.ok(!remaining.includes(oldId));
      assert.ok(remaining.includes(newId));
      assert.ok(remaining.includes(heldId), 'declared policies honour legal holds');
      assert.equal(policy(report, 'testpkg:not a model').skipped, 'invalid');
      assert.equal(policy(report, 'testpkg:AccessLog').skipped, 'invalid', 'built-in collections cannot be redeclared');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('getPolicies lists every window, including the ones enforced by TTLs', async () => {
    const policies = await retentionService.getPolicies({ now: NOW, settings: SETTINGS });
    const byKey = Object.fromEntries(policies.map((p) => [p.key, p]));
    for (const key of ['auditLogs', 'accessLogs', 'loginAttempts', 'sessions', 'exportArtifacts', 'exportRecords',
      'reportArtifacts', 'softDeleted', 'deletedUsers', 'archivedTenants', 'outboundEmails', 'idempotencyKeys']) {
      assert.ok(byKey[key], `${key} is listed`);
    }
    assert.equal(byKey.idempotencyKeys.enforcedBy, 'cache-ttl');
    assert.equal(byKey.archivedTenants.enabled, false);
    assert.equal(byKey.accessLogs.cutoff, ago(30).toISOString());
  });
});

/* --------------------------- job and script ------------------------------ */

describe('cleanup job and operator script', () => {
  beforeEach(() => resetSchedulerForTests());

  test('the cleanup job records a JobRun with per-collection counts and an audit event', async () => {
    const window = env.retention.accessLogDays;
    await insert(AccessLog, [
      { tenantId: 't1', occurredAt: ago(window + 1) },
      { tenantId: 't1', occurredAt: ago(window + 2) },
      { tenantId: 't1', occurredAt: ago(Math.max(0, window - 1)) },
    ]);
    assert.equal(env.retention.dryRun, false, 'the test runner does not set RETENTION_DRY_RUN');
    const result = await runJob(cleanupJob, { instanceId: 'w-test' });
    assert.equal(result.status, 'succeeded');
    const jobRun = await JobRun.findById(result.runId).lean();
    assert.equal(jobRun.job, 'cleanup');
    assert.equal(jobRun.status, 'succeeded');
    assert.equal(jobRun.counts.accessLogs, 2);
    assert.equal(jobRun.counts.dryRun, 0);
    assert.ok(jobRun.counts.deleted >= 2);
    assert.equal(await AccessLog.collection.countDocuments({}), 1);
    const auditRow = await AuditLog.findOne({ module: 'governance', action: 'retention.purge' }).lean();
    assert.ok(auditRow, 'the run is on the audit trail');
    assert.equal(auditRow.after.policies.accessLogs.deleted, 2);
  });

  test('a failing job keeps the counts it collected on the JobRun', async () => {
    const result = await runJob({
      name: 'retention-failure-probe',
      async handler() {
        const err = new Error('two policies failed');
        err.code = 'RETENTION_PARTIAL_FAILURE';
        err.counts = { accessLogs: 3, errors: 2 };
        throw err;
      },
    }, { instanceId: 'w-test' });
    assert.equal(result.status, 'failed');
    const jobRun = await JobRun.findById(result.runId).lean();
    assert.equal(jobRun.error.code, 'RETENTION_PARTIAL_FAILURE');
    assert.deepEqual(jobRun.counts, { accessLogs: 3, errors: 2 });
  });

  test('db:retention is a dry run unless --apply is given', async () => {
    assert.deepEqual(parseArgs(['--only', 'accessLogs', '--apply']), { apply: true, only: ['accessLogs'] });
    assert.deepEqual(parseArgs([]), { apply: false, only: [] });
    await insert(AccessLog, [{ tenantId: 't1', occurredAt: ago(40) }]);
    const lines = [];
    const dry = await runRetentionScript({ settings: SETTINGS, now: NOW, only: ['accessLogs'], log: (l) => lines.push(l) });
    assert.equal(dry.dryRun, true);
    assert.equal(await AccessLog.collection.countDocuments({}), 1);
    assert.ok(lines.some((l) => l.includes('Dry run only')));

    const applied = await runRetentionScript({ apply: true, settings: SETTINGS, now: NOW, only: ['accessLogs'], log: () => {} });
    assert.equal(applied.totals.deleted, 1);
    assert.equal(await AccessLog.collection.countDocuments({}), 0);
  });
});
