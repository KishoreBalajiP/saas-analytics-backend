/**
 * Supporting pieces of the tenant export (roadmap 2.9):
 *   - streaming storage primitives (`putFile`, `createReadStream`) used for
 *     archives that must never be buffered whole;
 *   - the expiry job is registered with the scheduler, runs under its lock
 *     and records a JobRun with counts;
 *   - the workspace Owner role (only) is granted the export permissions.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { text } from 'node:stream/consumers';

import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import * as storageService from '../../src/services/storage.service.js';
import { createLocalStorage } from '../../src/storage/localStorage.js';
import { runJob, getRegisteredJobs, resetSchedulerForTests } from '../../src/jobs/scheduler.js';
import tenantExportExpiryJob from '../../src/jobs/tenantExportExpiry.job.js';
import { JobRun } from '../../src/models/JobRun.js';
import tenantInitialization from '../../src/services/tenantInitialization.service.js';
import { BUILTIN_MODULES } from '../../src/models/Module.js';

let dir;
before(async () => {
  await startMongo();
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'export-storage-test-'));
});
beforeEach(async () => { await resetMongo(); resetSchedulerForTests(); });
after(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
  await stopMongo();
});

test('local storage streams files in and out without buffering', async () => {
  const driver = createLocalStorage({ baseDir: path.join(dir, 'store') });
  const source = path.join(dir, 'archive.bin');
  const payload = crypto.randomBytes(256 * 1024);
  await fsp.writeFile(source, payload);
  const put = await driver.putFile('tenant-exports/t/a.tar.gz', source);
  assert.deepEqual(put, { key: 'tenant-exports/t/a.tar.gz', size: payload.length });
  const chunks = [];
  for await (const chunk of await driver.createReadStream('tenant-exports/t/a.tar.gz')) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), payload);
  await assert.rejects(() => driver.createReadStream('tenant-exports/t/missing.tar.gz'), (err) => err.code === 'ENOENT');
  await assert.rejects(() => driver.putFile('../escape', source));
});

test('the storage service exposes the streaming primitives with typed errors', async () => {
  const source = path.join(dir, 'note.txt');
  await fsp.writeFile(source, 'hello export');
  const key = `tests/stream-${crypto.randomUUID()}.txt`;
  await storageService.putFile(key, source, { contentType: 'text/plain' });
  assert.equal(await text(await storageService.createReadStream(key)), 'hello export');
  await storageService.del(key);
  await assert.rejects(() => storageService.createReadStream(key), (err) => err.name === 'StorageError' && err.code === 'STORAGE_OPERATION_FAILED');
});

test('the expiry job is registered, enabled by default and records a run', async () => {
  const registered = getRegisteredJobs().find((j) => j.name === 'tenant-export-expiry');
  assert.deepEqual(registered, { name: 'tenant-export-expiry', cronExpression: '20 * * * *', enabled: true });
  const outcome = await runJob(tenantExportExpiryJob, { instanceId: 'test', trigger: 'manual' });
  assert.equal(outcome.status, 'succeeded');
  assert.deepEqual(outcome.counts, { expired: 0, abandoned: 0, errors: 0 });
  const run = await JobRun.findOne({ job: 'tenant-export-expiry' }).lean();
  assert.equal(run.status, 'succeeded');
});

test('export permissions are part of the catalogue and granted to the Owner role only', () => {
  assert.ok(BUILTIN_MODULES.includes('data_exports'));
  assert.deepEqual(tenantInitialization.TENANT_PERMISSION_ACTIONS.data_exports, ['view', 'export']);
  const roles = tenantInitialization.DEFAULT_ROLES;
  assert.ok(roles.Owner.permissions.includes('data_exports.view'));
  assert.ok(roles.Owner.permissions.includes('data_exports.export'));
  for (const name of ['Admin', 'Manager', 'Viewer']) {
    assert.ok(!roles[name].permissions.some((key) => key.startsWith('data_exports.')), `${name} cannot export by default`);
  }
});
