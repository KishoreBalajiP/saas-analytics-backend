/**
 * Storage for artefacts (roadmap 1.5):
 *   - signed download URLs: local tokens bind one key, file name and
 *     content type, expire, and refuse tampering; S3 URLs are presigned with
 *     the response content type and attachment disposition;
 *   - streaming writes report completion (`stream.completed`) on the local
 *     driver and on the S3 driver (managed upload to an S3-compatible
 *     endpoint, exercised against an in-process loopback stub).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createLocalStorage, createS3Storage, STORAGE_PROVIDERS } from '../../src/storage/index.js';
import * as storageService from '../../src/services/storage.service.js';
import clock from '../../src/utils/clock.js';

test('local signed download tokens bind the key, file name and type, and expire', async () => {
  clock.set(new Date('2026-03-01T12:00:00Z'));
  try {
    const { url, expiresAt } = await storageService.signedDownloadUrl('reports/t1/r1/run1.csv', {
      ttlSec: 60, fileName: '../../etc/passwd "x".csv', contentType: 'text/csv; charset=utf-8',
    });
    assert.equal(expiresAt, '2026-03-01T12:01:00.000Z');
    assert.match(url, /^\/api\/v1\/files\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const token = url.split('/').pop();
    const grant = storageService.verifyDownloadToken(token);
    assert.deepEqual(grant, { key: 'reports/t1/r1/run1.csv', fileName: 'etc-passwd-x-.csv', contentType: 'text/csv; charset=utf-8' });

    assert.equal(storageService.verifyDownloadToken(token, new Date('2026-03-01T12:01:01Z')), null, 'expired');
    const [payload, signature] = token.split('.');
    const other = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), k: 'reports/t2/secret.csv' })).toString('base64url');
    assert.equal(storageService.verifyDownloadToken(`${other}.${signature}`), null, 'another key');
    assert.equal(storageService.verifyDownloadToken(`${payload}.${signature.slice(1)}`), null, 'truncated signature');
    for (const bad of ['', 'abc', '.', 'a.b.c', null, 42, 'x'.repeat(5000)]) {
      assert.equal(storageService.verifyDownloadToken(bad), null, String(bad).slice(0, 10));
    }
    await assert.rejects(() => storageService.signedDownloadUrl('', { ttlSec: 60 }));
  } finally {
    clock.reset();
  }
});

test('file names are reduced to header- and filesystem-safe characters', () => {
  assert.equal(storageService.safeFileName('Q3 sales/EU (final).xlsx'), 'Q3-sales-EU-final-.xlsx');
  assert.equal(storageService.safeFileName('..'), 'download');
  assert.equal(storageService.safeFileName(''), 'download');
  assert.equal(storageService.attachmentDisposition('a"b\r\nc.csv'), 'attachment; filename="a-b-c.csv"');
});

test('the local driver streams writes and reports completion with the size', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'saas-stream-'));
  const storage = createLocalStorage({ provider: STORAGE_PROVIDERS.LOCAL, baseDir: dir });
  const stream = await storage.createWriteStream('exports/a/b.csv', { contentType: 'text/csv' });
  stream.write('a,b\n');
  stream.end('1,2\n');
  assert.deepEqual(await stream.completed, { key: 'exports/a/b.csv', size: 8 });
  const read = await storage.createReadStream('exports/a/b.csv');
  const chunks = [];
  for await (const chunk of read) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'a,b\n1,2\n');
  await assert.rejects(() => storage.createReadStream('exports/missing.csv'));
  await fs.rm(dir, { recursive: true, force: true });
});

/** A loopback S3-compatible stub: PUT stores, GET returns. */
async function s3Stub() {
  const objects = new Map();
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = Buffer.concat(chunks);
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    if (req.method === 'PUT') {
      if (String(req.headers['content-encoding'] || '').includes('aws-chunked')) {
        // aws-chunked framing: "<hex size>\r\n<data>\r\n ... 0\r\n<trailers>"
        const out = [];
        let text = body;
        for (;;) {
          const lineEnd = text.indexOf('\r\n');
          const size = parseInt(text.subarray(0, lineEnd).toString().split(';')[0], 16);
          if (!size) break;
          out.push(text.subarray(lineEnd + 2, lineEnd + 2 + size));
          text = text.subarray(lineEnd + 2 + size + 2);
        }
        body = Buffer.concat(out);
      }
      objects.set(req.url.split('?')[0], { body, type: req.headers['content-type'] });
      res.writeHead(200, { ETag: '"etag"' });
      res.end();
      return;
    }
    const found = objects.get(req.url.split('?')[0]);
    if (!found) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': found.type ?? 'application/octet-stream', 'Content-Length': found.body.length });
    res.end(found.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, objects, requests, endpoint: `http://127.0.0.1:${server.address().port}` };
}

test('the S3 driver streams a managed upload, reports completion, reads back, and presigns downloads', async () => {
  const stub = await s3Stub();
  const storage = createS3Storage({
    bucket: 'artefacts', region: 'us-east-1', endpoint: stub.endpoint, forcePathStyle: true,
    accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key',
  });
  try {
    const stream = await storage.createWriteStream('reports/t1/run.csv', { contentType: 'text/csv; charset=utf-8' });
    stream.write('a,b\n');
    stream.end('1,2\n');
    assert.deepEqual(await stream.completed, { key: 'reports/t1/run.csv', size: 8 });
    const stored = stub.objects.get('/artefacts/reports/t1/run.csv');
    assert.ok(stored, `uploaded: ${JSON.stringify(stub.requests.map((r) => `${r.method} ${r.url}`))}`);
    assert.equal(stored.body.toString(), 'a,b\n1,2\n');
    assert.equal(stored.type, 'text/csv; charset=utf-8');

    const read = await storage.createReadStream('reports/t1/run.csv');
    const chunks = [];
    for await (const chunk of read) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString(), 'a,b\n1,2\n');

    const url = new URL(await storage.presignedUrl('reports/t1/run.csv', {
      ttlSec: 120, contentType: 'text/csv', contentDisposition: 'attachment; filename="run.csv"',
    }));
    assert.equal(url.pathname, '/artefacts/reports/t1/run.csv');
    assert.equal(url.searchParams.get('response-content-disposition'), 'attachment; filename="run.csv"');
    assert.equal(url.searchParams.get('response-content-type'), 'text/csv');
    assert.equal(url.searchParams.get('X-Amz-Expires'), '120');
  } finally {
    await storage.close();
    await new Promise((resolve) => stub.server.close(resolve));
  }
});
