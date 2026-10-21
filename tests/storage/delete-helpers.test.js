/**
 * Storage delete helpers used by retention (roadmap 2.7): `delMany` and
 * `delPrefix` on the local driver (the test runner forces it).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as storageService from '../../src/services/storage.service.js';

test('delMany deletes every key, tolerates missing ones and reports the count', async () => {
  const base = `retention-test/${randomUUID()}`;
  await storageService.put(`${base}/a.txt`, 'a');
  await storageService.put(`${base}/b.txt`, 'b');
  const r = await storageService.delMany([`${base}/a.txt`, `${base}/b.txt`, `${base}/missing.txt`, `${base}/a.txt`, '', null]);
  assert.equal(r.failed.length, 0);
  assert.equal(r.deleted, 3, 'unique, non-empty keys only (a missing key is not an error)');
  assert.equal(await storageService.exists(`${base}/a.txt`), false);
  assert.equal(await storageService.exists(`${base}/b.txt`), false);
});

test('delPrefix removes only objects under the prefix, honours dry run and the limit', async () => {
  const base = `retention-test/${randomUUID()}`;
  await storageService.put(`${base}/t1/x.csv`, 'x');
  await storageService.put(`${base}/t1/y.csv`, 'y');
  await storageService.put(`${base}/t2/z.csv`, 'z');

  const dry = await storageService.delPrefix(`${base}/t1/`, { dryRun: true });
  assert.deepEqual(dry, { matched: 2, deleted: 0, failed: 0 });
  assert.equal(await storageService.exists(`${base}/t1/x.csv`), true);

  const limited = await storageService.delPrefix(`${base}/t1/`, { limit: 1 });
  assert.equal(limited.deleted, 1);
  const rest = await storageService.delPrefix(`${base}/t1/`);
  assert.equal(rest.deleted, 1);
  assert.equal(await storageService.exists(`${base}/t2/z.csv`), true, 'other prefixes untouched');
  await storageService.del(`${base}/t2/z.csv`);
});

test('delPrefix refuses an empty prefix (it would match the whole bucket)', async () => {
  for (const prefix of ['', '/', '//', null]) {
    await assert.rejects(() => storageService.delPrefix(prefix), (err) => err.code === 'INVALID_INPUT');
  }
});
