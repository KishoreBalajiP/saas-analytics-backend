/**
 * Audit tamper evidence and append-only guards (roadmap 2.5; finding gov.13).
 *
 *   - every row is sealed into a gap-free hash chain, also under concurrent
 *     writers and when another process appended first;
 *   - `verifyAuditChain` (and `scripts/ci/verify-audit-chain.js`) passes on
 *     an intact chain and pinpoints an edited, deleted or inserted row, a
 *     missing recorded head, and HMAC rows without their key;
 *   - every mutation family is refused on AuditLog, AccessLog and
 *     LoginAttempt except the retention purge.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import auditLogService from '../../src/services/auditLog.service.js';
import auditLogRepository from '../../src/repositories/auditLog.repository.js';
import accessLogRepository from '../../src/repositories/accessLog.repository.js';
import loginAttemptRepository from '../../src/repositories/loginAttempt.repository.js';
import { verifyAuditChain } from '../../src/services/auditChain.service.js';
import { GENESIS_HASH, seal, checkRow, chainContent, hashContent, keyIdFor } from '../../src/utils/auditChain.js';
import { run as runVerifyScript, parseArgs, formatReport } from '../../scripts/ci/verify-audit-chain.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { AccessLog } from '../../src/models/AccessLog.js';
import { LoginAttempt } from '../../src/models/LoginAttempt.js';

before(async () => { await startMongo(); });
beforeEach(async () => {
  await resetMongo();
  // Each test starts a fresh chain.
  auditLogRepository.resetChainCache();
});
after(async () => { await stopMongo(); });

const emit = (i, extra = {}) => auditLogService.emit({
  actor: { type: 'admin', id: `adm-${i}`, display: 'ops' },
  action: 'demo.changed',
  module: 'demo',
  tenantId: 't1',
  after: { n: i, at: new Date(Date.UTC(2026, 9, 20, 10, 0, i)) },
  ...extra,
});

async function chainRows() {
  return AuditLog.find({}).sort({ seq: 1 }).lean();
}

/* --------------------------------- sealing --------------------------------- */

test('rows form a gap-free chain starting at the genesis hash and the chain verifies', async () => {
  for (let i = 0; i < 5; i += 1) await emit(i);
  const rows = await chainRows();
  assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3, 4, 5]);
  assert.equal(rows[0].prevHash, GENESIS_HASH);
  for (let i = 1; i < rows.length; i += 1) assert.equal(rows[i].prevHash, rows[i - 1].hash);
  for (const row of rows) {
    assert.match(row.hash, /^[0-9a-f]{64}$/);
    assert.equal(row.hashAlg, 'sha256');
    assert.equal(checkRow(row).status, 'ok');
  }

  const report = await verifyAuditChain();
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.checked, 5);
  assert.deepEqual(report.head, { seq: 5, hash: rows[4].hash });
  assert.equal(report.anchored, false);
});

test('concurrent writers in one process still produce one linear chain', async () => {
  await Promise.all(Array.from({ length: 25 }, (_, i) => emit(i)));
  const rows = await chainRows();
  assert.deepEqual(rows.map((r) => r.seq), Array.from({ length: 25 }, (_, i) => i + 1));
  assert.equal((await verifyAuditChain()).ok, true);
});

test('a writer whose cached head is stale (another process appended) retries and keeps the chain linear', async () => {
  await emit(1);
  // Another instance appends seq 2 behind this process's back.
  const head = await auditLogRepository.findChainHead();
  const foreign = new AuditLog({ actorType: 'system', module: 'demo', action: 'other.process', occurredAt: new Date() });
  seal(foreign, head);
  await AuditLog.collection.insertOne(foreign.toObject({ depopulate: true }));

  const row = await emit(2); // cached head still says seq 1
  assert.equal(row.seq, 3);
  assert.equal(row.prevHash, foreign.hash);
  assert.equal((await verifyAuditChain()).ok, true);
});

/* ------------------------------ tamper detection --------------------------- */

test('an edited row is reported as hash_mismatch at its sequence number', async () => {
  for (let i = 0; i < 4; i += 1) await emit(i);
  // Someone with database access rewrites history (bypassing the app).
  await AuditLog.collection.updateOne({ seq: 2 }, { $set: { 'after.n': 999, actorId: 'someone-else' } });
  const report = await verifyAuditChain();
  assert.equal(report.ok, false);
  assert.deepEqual(report.errors.map((e) => [e.type, e.seq]), [['hash_mismatch', 2]]);
});

test('a deleted row breaks the sequence and the next link', async () => {
  for (let i = 0; i < 4; i += 1) await emit(i);
  await AuditLog.collection.deleteOne({ seq: 3 });
  const report = await verifyAuditChain();
  assert.equal(report.ok, false);
  const types = report.errors.map((e) => `${e.type}@${e.seq}`);
  assert.ok(types.includes('seq_gap@4'));
  assert.ok(types.includes('prev_hash_mismatch@4'));
});

test('a row inserted around the chain is reported; rehashing one row is not enough to hide an edit', async () => {
  for (let i = 0; i < 3; i += 1) await emit(i);
  await AuditLog.collection.insertOne({ actorType: 'admin', actorId: 'forger', module: 'iam.admins', action: 'create', result: 'success', occurredAt: new Date() });
  let report = await verifyAuditChain();
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => e.type === 'unchained_record'));

  await AuditLog.collection.deleteOne({ actorId: 'forger' });
  // Edit row 2 and recompute ITS hash: row 3 still points at the old hash.
  const row2 = await AuditLog.findOne({ seq: 2 }).lean();
  const forged = { ...row2, after: { n: 42 } };
  forged.hash = hashContent(chainContent(forged));
  await AuditLog.collection.replaceOne({ _id: row2._id }, forged);
  report = await verifyAuditChain();
  assert.deepEqual(report.errors.map((e) => `${e.type}@${e.seq}`), ['prev_hash_mismatch@3']);
});

test('a recorded head detects truncation of the newest rows', async () => {
  for (let i = 0; i < 4; i += 1) await emit(i);
  const { head } = await verifyAuditChain();
  assert.equal((await verifyAuditChain({ expectHead: head })).ok, true);
  await AuditLog.collection.deleteOne({ seq: 4 });
  const report = await verifyAuditChain({ expectHead: head });
  assert.equal(report.ok, false);
  assert.equal(report.errors[0].type, 'expected_head_missing');
});

test('after a retention purge the chain is verified from the first remaining row', async () => {
  for (let i = 0; i < 4; i += 1) {
    await emit(i);
    await new Promise((resolve) => setTimeout(resolve, 5)); // distinct timestamps
  }
  const cutoff = (await AuditLog.findOne({ seq: 3 }).lean()).occurredAt;
  await auditLogRepository.retentionPurge({ before: cutoff });
  const report = await verifyAuditChain();
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.anchored, true);
  assert.equal(report.firstSeq, 3);
});

test('rows written before the chain existed are reported as legacy, not as errors', async () => {
  await AuditLog.collection.insertOne({ actorType: 'system', module: 'legacy', action: 'old', result: 'success', occurredAt: new Date(Date.now() - 86_400_000) });
  await emit(1);
  const report = await verifyAuditChain();
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.legacyUnchained, 1);
});

test('HMAC-sealed rows verify with their key, are unverifiable without it, and detect edits', () => {
  const key = 'k'.repeat(40);
  const signingKey = { id: keyIdFor(key), key };
  const row = {
    _id: new mongoose.Types.ObjectId(), occurredAt: new Date(), actorType: 'admin', actorId: 'a1', module: 'demo', action: 'x', result: 'success',
  };
  seal(row, { seq: 0, hash: GENESIS_HASH }, { signingKey });
  assert.equal(row.hashAlg, 'hmac-sha256');
  assert.equal(row.keyId, signingKey.id);
  assert.equal(checkRow(row, new Map([[signingKey.id, key]])).status, 'ok');
  assert.equal(checkRow(row, new Map()).status, 'unverifiable');
  assert.equal(checkRow({ ...row, actorId: 'a2' }, new Map([[signingKey.id, key]])).status, 'mismatch');
  // Without the key nobody can produce a matching hash for edited content.
  const naive = { ...row, actorId: 'a2' };
  naive.hash = hashContent(chainContent(naive));
  assert.equal(checkRow(naive, new Map([[signingKey.id, key]])).status, 'mismatch');
});

/* ---------------------------- verification script --------------------------- */

test('scripts/ci/verify-audit-chain.js reports OK, then BROKEN, and parses its flags', async () => {
  for (let i = 0; i < 3; i += 1) await emit(i);
  const lines = [];
  const ok = await runVerifyScript({ log: (line) => lines.push(line) });
  assert.equal(ok.ok, true);
  assert.ok(lines.some((l) => l === 'audit chain OK'));
  assert.ok(lines.some((l) => l.startsWith('head 3:')));

  await AuditLog.collection.updateOne({ seq: 1 }, { $set: { action: 'edited' } });
  const broken = await runVerifyScript({ log: () => {} });
  assert.equal(broken.ok, false);
  assert.ok(formatReport(broken).some((l) => l.startsWith('ERROR hash_mismatch seq=1')));

  const json = [];
  await runVerifyScript({ json: true, log: (line) => json.push(line) });
  assert.equal(JSON.parse(json[0]).ok, false);

  assert.deepEqual(parseArgs(['--expect-head', `7:${'a'.repeat(64)}`]).expectHead, { seq: 7, hash: 'a'.repeat(64) });
  assert.ok(parseArgs(['--expect-head', 'nope']).error);
  assert.equal(parseArgs(['--json']).json, true);
});

/* ------------------------------ append-only ------------------------------- */

test('every AuditLog mutation family is refused; only the retention purge may delete', async () => {
  const row = await emit(1);
  const id = row._id;
  const refused = (err) => err?.code === 'APPEND_ONLY';
  await assert.rejects(() => AuditLog.updateOne({ _id: id }, { $set: { action: 'x' } }), refused);
  await assert.rejects(() => AuditLog.updateMany({}, { $set: { action: 'x' } }), refused);
  await assert.rejects(() => AuditLog.findOneAndUpdate({ _id: id }, { $set: { action: 'x' } }), refused);
  await assert.rejects(() => AuditLog.replaceOne({ _id: id }, { action: 'x', module: 'm', actorType: 'system' }), refused);
  await assert.rejects(() => AuditLog.findOneAndReplace({ _id: id }, { action: 'x', module: 'm', actorType: 'system' }), refused);
  await assert.rejects(() => AuditLog.deleteOne({ _id: id }), refused);
  await assert.rejects(() => AuditLog.deleteMany({}), refused);
  await assert.rejects(() => AuditLog.findOneAndDelete({ _id: id }), refused);
  await assert.rejects(() => AuditLog.bulkWrite([{ deleteOne: { filter: { _id: id } } }]), refused);
  const doc = await AuditLog.findById(id);
  await assert.rejects(() => doc.deleteOne(), refused);
  doc.action = 'changed';
  await assert.rejects(() => doc.save(), refused);
  assert.equal(await AuditLog.countDocuments({}), 1);

  const purge = await auditLogRepository.retentionPurge({ before: new Date(Date.now() + 1000) });
  assert.equal(purge.deletedCount, 1);
});

test('AccessLog and LoginAttempt are append-only too (retention purge allowed)', async () => {
  const access = await AccessLog.create({ actorType: 'user', actorId: 'u1', method: 'GET', path: '/x', statusCode: 200 });
  const attempt = await LoginAttempt.create({ email: 'a@example.com', success: false, reason: 'invalid_credentials' });
  const refused = (err) => err?.code === 'APPEND_ONLY';
  for (const [Model, id] of [[AccessLog, access._id], [LoginAttempt, attempt._id]]) {
    await assert.rejects(() => Model.updateOne({ _id: id }, { $set: { ip: '1.2.3.4' } }), refused);
    await assert.rejects(() => Model.updateMany({}, { $set: { ip: '1.2.3.4' } }), refused);
    await assert.rejects(() => Model.findOneAndUpdate({ _id: id }, { $set: { ip: '1.2.3.4' } }), refused);
    await assert.rejects(() => Model.deleteOne({ _id: id }), refused);
    await assert.rejects(() => Model.deleteMany({}), refused);
    await assert.rejects(() => Model.findOneAndDelete({ _id: id }), refused);
    await assert.rejects(() => Model.bulkWrite([{ deleteOne: { filter: { _id: id } } }]), refused);
  }
  // Inserts through bulkWrite stay possible (batched writers).
  await AccessLog.bulkWrite([{ insertOne: { document: { actorType: 'user', method: 'GET', path: '/y', statusCode: 200 } } }]);
  assert.equal(await AccessLog.countDocuments({}), 2);
  const purged = await accessLogRepository.retentionPurge({ before: new Date(Date.now() + 1000) });
  assert.equal(purged.deletedCount, 2);
  const attempts = await loginAttemptRepository.retentionPurge({ before: new Date(Date.now() + 1000) });
  assert.equal(attempts.deletedCount, 1);
});
