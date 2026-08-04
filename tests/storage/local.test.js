/**
 * Tests for `storage/localStorage.js`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createLocalStorage, STORAGE_PROVIDERS } from '../../src/storage/index.js';
import * as storageService from '../../src/services/storage.service.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'saas-storage-'));
}

test('put + get round-trips a buffer', async () => {
  const dir = await tmpDir();
  const storage = createLocalStorage({ provider: STORAGE_PROVIDERS.LOCAL, baseDir: dir });
  await storage.put('csv/sample.csv', Buffer.from('a,b\n1,2\n'));
  const back = await storage.get('csv/sample.csv');
  assert.equal(back.toString('utf8'), 'a,b\n1,2\n');
  await storage.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('put + getJson round-trip via the service wrapper', async () => {
  const dir = await tmpDir();
  // Override the service's default baseDir by reconfiguring its singleton.
  process.env.STORAGE_BASE_DIR = dir;
  await storageService.close();
  await storageService.putJson('reports/1.json', { hello: 'world' });
  const data = await storageService.getJson('reports/1.json');
  assert.deepEqual(data, { hello: 'world' });
  await storageService.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('exists returns true after put, false otherwise', async () => {
  const dir = await tmpDir();
  const storage = createLocalStorage({ provider: STORAGE_PROVIDERS.LOCAL, baseDir: dir });
  await storage.put('a.txt', 'x');
  assert.equal(await storage.exists('a.txt'), true);
  assert.equal(await storage.exists('missing.txt'), false);
  await storage.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('delete is idempotent', async () => {
  const dir = await tmpDir();
  const storage = createLocalStorage({ provider: STORAGE_PROVIDERS.LOCAL, baseDir: dir });
  await storage.put('a.txt', 'x');
  await storage.delete('a.txt');
  await storage.delete('a.txt'); // no throw
  assert.equal(await storage.exists('a.txt'), false);
  await storage.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('list enumerates nested keys', async () => {
  const dir = await tmpDir();
  const storage = createLocalStorage({ provider: STORAGE_PROVIDERS.LOCAL, baseDir: dir });
  await storage.put('a/1.txt', '1');
  await storage.put('a/2.txt', '2');
  await storage.put('b/3.txt', '3');
  const keys = await storage.list('a');
  assert.deepEqual(keys.sort(), ['a/1.txt', 'a/2.txt']);
  await storage.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('rejects path traversal', async () => {
  const dir = await tmpDir();
  const storage = createLocalStorage({ provider: STORAGE_PROVIDERS.LOCAL, baseDir: dir });
  await assert.rejects(() => storage.put('../escape.txt', 'x'), /not allowed/);
  await assert.rejects(() => storage.put('/abs.txt', 'x'), /not allowed/);
  await storage.close();
  await fs.rm(dir, { recursive: true, force: true });
});
