/**
 * Restore drill CLI (scripts/ci/restore-drill.js, roadmap 2.9).
 *
 * Exit criteria: the drill refuses the default URI and production-like
 * targets unless explicitly allowed, and succeeds against the in-memory
 * server (a separate scratch database), writing an evidence report. It never
 * touches the application database.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';

import { startMongo, stopMongo, resetMongo, getMongoUri } from '../helpers/mongo.js';
import queueService from '../../src/services/queue.service.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import { EXPORTED, collectionNameOf } from '../../src/services/tenantDataCatalogue.js';
import { extractTarGz } from '../../src/utils/tarArchive.js';
import {
  parseArgs,
  parseMongoUri,
  redactUri,
  assessTarget,
  run,
  DEFAULT_URI,
} from '../../scripts/ci/restore-drill.js';
import { seededTenant, exportToFile } from './helpers.js';

let workRoot;
const logs = [];
const log = (line) => logs.push(line);

before(async () => {
  await startMongo();
  workRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-drill-test-'));
});
beforeEach(async () => {
  await resetMongo();
  await rbacCache.clearAll();
  logs.length = 0;
});
after(async () => {
  await fsp.rm(workRoot, { recursive: true, force: true });
  await queueService.closeAll();
  await stopMongo();
});

function scratchUri(name) {
  return `${getMongoUri().replace(/\/$/, '')}/${name}`;
}

async function withScratch(uri, fn) {
  const conn = mongoose.createConnection(uri);
  await conn.asPromise();
  try {
    return await fn(conn);
  } finally {
    await conn.close();
  }
}

/* ---------------------------- target assessment --------------------------- */

test('the drill refuses the default, application and production-like targets unless explicitly allowed', () => {
  const unsafe = [
    DEFAULT_URI,
    'mongodb://localhost/saas_analytics',
    'mongodb://127.0.0.1:27017/saas_analytics?retryWrites=true',
    'mongodb+srv://user:pass@cluster0.abcde.mongodb.net/scratch',
    'mongodb://shard-00.abcde.mongodb.net:27017,shard-01.abcde.mongodb.net:27017/scratch',
    'mongodb://db.internal:27017/analytics_prod',
    'mongodb://db.internal:27017/production',
    'mongodb://db.internal:27017/live',
    'mongodb://db.internal:27017/saas_analytics',
  ];
  for (const uri of unsafe) {
    const verdict = assessTarget(uri);
    assert.equal(verdict.ok, false, uri);
    assert.equal(verdict.blocking.length, 0, `${uri} is overridable`);
    assert.ok(verdict.unsafe.length > 0, uri);
  }
  // The application's configured database, however it is spelled.
  const app = assessTarget('mongodb://u:p@app-db.internal:27017/analytics_x?authSource=admin', { appUri: 'mongodb://app-db.internal/analytics_x' });
  assert.ok(app.unsafe.some((p) => p.code === 'TARGET_IS_APP_DATABASE'));

  // Never overridable: not a MongoDB URI, or no database named.
  for (const uri of ['http://example.com/db', 'mongodb://scratch.internal:27017', 'mongodb://scratch.internal:27017/', '']) {
    const verdict = assessTarget(uri);
    assert.equal(verdict.ok, false, uri);
    assert.ok(verdict.blocking.length > 0, `${uri} is blocking`);
  }

  // Scratch databases are fine, including a non-default database on a local server.
  for (const uri of ['mongodb://127.0.0.1:55001/restore_drill_scratch', 'mongodb://127.0.0.1:27017/restore_drill_2026q4', 'mongodb://scratch.internal:27017/drill']) {
    assert.equal(assessTarget(uri, { appUri: DEFAULT_URI }).ok, true, uri);
  }
});

test('URI parsing keeps hosts and database and the report never shows credentials', () => {
  assert.deepEqual(parseMongoUri('mongodb://u:p%40ss@h1:27018,h2/db_x?replicaSet=rs0'), {
    scheme: 'mongodb',
    hosts: [{ host: 'h1', port: 27018 }, { host: 'h2', port: 27017 }],
    database: 'db_x',
  });
  assert.equal(redactUri('mongodb+srv://admin:hunter2@c.mongodb.net/scratch?w=majority'), 'mongodb+srv://c.mongodb.net:27017/scratch');
  assert.ok(!redactUri('mongodb://admin:hunter2@h/x').includes('hunter2'));
});

test('argument parsing', () => {
  const parsed = parseArgs(['--source', 'a.tar.gz', '--target', 'mongodb://h/x', '--mode', 'preserve', '--expect-sha256', 'ABC', '--cleanup', '--allow-unsafe-target', '--operator', 'jane']);
  assert.equal(parsed.source, 'a.tar.gz');
  assert.equal(parsed.target, 'mongodb://h/x');
  assert.equal(parsed.mode, 'preserve');
  assert.equal(parsed.expectSha256, 'abc');
  assert.equal(parsed.cleanup, true);
  assert.equal(parsed.allowUnsafeTarget, true);
  assert.equal(parsed.operator, 'jane');
  assert.equal(parseArgs([]).allowUnsafeTarget, false, 'safe by default');
  assert.throws(() => parseArgs(['--force']), /Unknown option/);
});

test('a refused target is never connected to and leaves no report', async () => {
  const reportDir = path.join(workRoot, 'refused');
  for (const target of [DEFAULT_URI, 'mongodb+srv://x:y@cluster0.abcde.mongodb.net/scratch']) {
    const report = await run({ source: 'missing.tar.gz', target, reportDir, log });
    assert.equal(report.result, 'refused');
    assert.ok(report.errors.length > 0);
  }
  const noArgs = await run({ log });
  assert.equal(noArgs.result, 'refused');
  await assert.rejects(() => fsp.access(reportDir));
  assert.ok(logs.some((l) => /--allow-unsafe-target/.test(l)));
});

/* --------------------------------- drills -------------------------------- */

test('a drill restores an export into a scratch database, verifies it and writes evidence', async () => {
  const source = await seededTenant('DR');
  const { file, row } = await exportToFile(source.tenantId, path.join(workRoot, 'archives'));
  const tenantsBefore = await mongoose.model('Tenant').collection.countDocuments({});
  const reportDir = path.join(workRoot, 'reports');
  const target = scratchUri(`restore_drill_${Date.now()}`);

  const report = await run({ source: file, target, reportDir, operator: 'drill-test', expectSha256: row.sha256, appUri: DEFAULT_URI, log });
  assert.equal(report.result, 'passed', JSON.stringify(report.errors));
  assert.equal(report.source.sha256, row.sha256);
  assert.equal(report.archive.ok, true);
  assert.equal(report.verification.ok, true);
  assert.equal(report.verification.collections.length, EXPORTED.length);
  assert.ok(report.timings.totalMs >= 0 && report.timings.importMs >= 0);
  assert.ok(report.restoredTenantId && report.restoredTenantId !== source.tenantId, 'clone mode by default');

  // Evidence files.
  assert.equal(report.reportFiles.length, 2);
  const json = JSON.parse(await fsp.readFile(report.reportFiles[0], 'utf8'));
  assert.equal(json.result, 'passed');
  assert.equal(json.operator, 'drill-test');
  assert.ok(!JSON.stringify(json).includes('idMap'), 'the report carries no id map');
  const md = await fsp.readFile(report.reportFiles[1], 'utf8');
  assert.match(md, /Result: \*\*PASSED\*\*/);
  assert.match(md, /\| users \| \d+ \| \d+ \| match \|/);

  // Restored data lives in the scratch database only.
  await withScratch(target, async (conn) => {
    assert.equal(await conn.collection(collectionNameOf('Tenant')).countDocuments({}), 1);
    assert.equal(await conn.collection(collectionNameOf('ConnectorRow')).countDocuments({ tenantId: report.restoredTenantId }), 6);
    await conn.dropDatabase();
  });
  assert.equal(await mongoose.model('Tenant').collection.countDocuments({}), tenantsBefore, 'the application database is untouched');
});

test('preserve mode with --cleanup, and an archive checksum mismatch fails the drill', async () => {
  const source = await seededTenant('PC');
  const { file } = await exportToFile(source.tenantId, path.join(workRoot, 'archives-pc'));
  const target = scratchUri(`restore_drill_pc_${Date.now()}`);

  const preserved = await run({ source: file, target, mode: 'preserve', cleanup: true, reportDir: path.join(workRoot, 'reports-pc'), log });
  assert.equal(preserved.result, 'passed', JSON.stringify(preserved.errors));
  assert.equal(preserved.restoredTenantId, source.tenantId);
  assert.equal(preserved.cleanedUp, true);
  await withScratch(target, async (conn) => {
    assert.equal(await conn.collection(collectionNameOf('Tenant')).countDocuments({}), 0, 'cleanup removed the restored tenant');
    await conn.dropDatabase();
  });

  // Wrong expected archive hash.
  const wrongHash = await run({ source: file, target, expectSha256: '0'.repeat(64), reportDir: null, log });
  assert.equal(wrongHash.result, 'failed');
  assert.equal(wrongHash.errors[0].code, 'ARCHIVE_SHA256_MISMATCH');

  // A tampered extracted archive.
  const dir = path.join(workRoot, 'tampered');
  await extractTarGz({ file, destDir: dir });
  await fsp.appendFile(path.join(dir, 'collections', `${collectionNameOf('Dashboard')}.jsonl`), '{"_id":{"$oid":"0123456789abcdef01234567"}}\n');
  const tampered = await run({ source: dir, target, reportDir: null, log });
  assert.equal(tampered.result, 'failed');
  assert.equal(tampered.errors[0].code, 'ARCHIVE_CHECKSUM_MISMATCH');
  await withScratch(target, async (conn) => {
    assert.equal(await conn.collection(collectionNameOf('Tenant')).countDocuments({}), 0, 'nothing was restored from a bad archive');
  });
});

test('--allow-unsafe-target overrides the production-like heuristics', async () => {
  const source = await seededTenant('UN');
  const { file } = await exportToFile(source.tenantId, path.join(workRoot, 'archives-un'));
  // A database name that looks like production, on the in-memory server.
  const target = scratchUri('analytics_prod');
  const refused = await run({ source: file, target, reportDir: null, log });
  assert.equal(refused.result, 'refused');
  const allowed = await run({ source: file, target, reportDir: null, allowUnsafeTarget: true, log });
  assert.equal(allowed.result, 'passed', JSON.stringify(allowed.errors));
  assert.ok(logs.some((l) => /overridden by --allow-unsafe-target/.test(l)));
  await withScratch(target, (conn) => conn.dropDatabase());
});
