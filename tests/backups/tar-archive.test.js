/**
 * Streaming tar.gz writer / extractor (src/utils/tarArchive.js).
 *
 * The extractor reads untrusted archives (restore drills): path traversal,
 * links, device entries, corrupt headers, truncation and inflation bombs
 * must all be refused without writing outside the destination.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

import { writeTarGz, extractTarGz, buildHeader, assertSafeName } from '../../src/utils/tarArchive.js';

let root;
before(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tar-test-')); });
after(async () => { await fsp.rm(root, { recursive: true, force: true }); });

async function sandbox() {
  return fsp.mkdtemp(path.join(root, 'case-'));
}

/** A raw ustar header with any name / type (bypasses the writer's checks). */
function rawHeader({ name, size = 0, type = '0', linkName = '' }) {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1);
  header.write(linkName, 157, 100);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}

function pad(size) {
  return Buffer.alloc((512 - (size % 512)) % 512, 0);
}

async function rawArchive(dir, entries) {
  const parts = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '');
    parts.push(entry.header ?? rawHeader({ ...entry, size: data.length }), data, pad(data.length));
  }
  parts.push(Buffer.alloc(1024, 0));
  const file = path.join(dir, 'hostile.tar.gz');
  await fsp.writeFile(file, zlib.gzipSync(Buffer.concat(parts)));
  return file;
}

test('round trip of text, binary, empty and block-aligned files', async () => {
  const dir = await sandbox();
  const files = {
    'manifest.json': '{"a":1}\n',
    'collections/users.jsonl': 'x'.repeat(512),
    'collections/empty.jsonl': '',
    'datasets/blob.bin': crypto.randomBytes(70000),
  };
  const entries = [];
  for (const [name, data] of Object.entries(files)) {
    const source = path.join(dir, 'src', name);
    await fsp.mkdir(path.dirname(source), { recursive: true });
    await fsp.writeFile(source, data);
    entries.push({ name, path: source });
  }
  const outFile = path.join(dir, 'a.tar.gz');
  await writeTarGz({ entries, outFile });
  const names = await extractTarGz({ file: outFile, destDir: path.join(dir, 'out') });
  assert.deepEqual(names, Object.keys(files));
  for (const [name, data] of Object.entries(files)) {
    assert.deepEqual(await fsp.readFile(path.join(dir, 'out', name)), Buffer.from(data), name);
  }
});

test('archives interoperate with the system tar', async (t) => {
  const probe = spawnSync('tar', ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    t.skip('tar is not installed');
    return;
  }
  const dir = await sandbox();
  const source = path.join(dir, 'collections');
  await fsp.mkdir(source, { recursive: true });
  await fsp.writeFile(path.join(source, 'a.jsonl'), 'hello\n');
  await writeTarGz({ entries: [{ name: 'collections/a.jsonl', path: path.join(source, 'a.jsonl') }], outFile: path.join(dir, 'ours.tar.gz') });
  const listed = spawnSync('tar', ['-tzf', path.join(dir, 'ours.tar.gz')], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.stdout.trim().split('\n'), ['collections/a.jsonl']);

  // An archive re-packed by the system tar (directory entries, possibly pax
  // headers) is readable by the extractor.
  const repacked = path.join(dir, 'theirs.tar.gz');
  const packed = spawnSync('tar', ['-czf', repacked, '-C', dir, 'collections'], { encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' } });
  assert.equal(packed.status, 0, packed.stderr);
  const names = await extractTarGz({ file: repacked, destDir: path.join(dir, 'out') });
  assert.ok(names.includes('collections/a.jsonl'));
  assert.equal(await fsp.readFile(path.join(dir, 'out', 'collections', 'a.jsonl'), 'utf8'), 'hello\n');
});

test('unsafe member names are refused by the writer and the extractor', async () => {
  for (const name of ['../evil', '/etc/passwd', 'a/../../b', 'a//b', 'sp ace', 'a/./b', '', 'x'.repeat(101)]) {
    assert.throws(() => assertSafeName(name), (err) => err.code === 'ARCHIVE_ENTRY_UNSAFE', JSON.stringify(name));
  }
  assert.throws(() => buildHeader({ name: '../x', size: 1 }), (err) => err.code === 'ARCHIVE_ENTRY_UNSAFE');

  const dir = await sandbox();
  for (const name of ['../escaped.txt', '/abs.txt', 'ok/../../escaped.txt']) {
    const file = await rawArchive(dir, [{ name, data: 'pwned' }]);
    const dest = path.join(dir, 'dest');
    await assert.rejects(() => extractTarGz({ file, destDir: dest }), (err) => err.code === 'ARCHIVE_ENTRY_UNSAFE', name);
    await assert.rejects(() => fsp.access(path.join(dir, 'escaped.txt')));
    await fsp.rm(dest, { recursive: true, force: true });
  }
});

test('links and device entries are refused', async () => {
  const dir = await sandbox();
  for (const type of ['1', '2', '3', '4', '6']) {
    const file = await rawArchive(dir, [{ name: 'link', type, linkName: '/etc/passwd' }]);
    await assert.rejects(() => extractTarGz({ file, destDir: path.join(dir, `d${type}`) }), (err) => err.code === 'ARCHIVE_ENTRY_UNSAFE', `type ${type}`);
  }
});

test('corrupt, truncated and oversized archives are refused', async () => {
  const dir = await sandbox();
  // Bad header checksum.
  const header = rawHeader({ name: 'a.txt', size: 1 });
  header[0] = 'b'.charCodeAt(0);
  const corrupt = await rawArchive(dir, [{ name: 'a.txt', data: 'x', header }]);
  await assert.rejects(() => extractTarGz({ file: corrupt, destDir: path.join(dir, 'c') }), (err) => err.code === 'ARCHIVE_CORRUPT');

  // Missing end-of-archive blocks.
  const truncated = path.join(dir, 'truncated.tar.gz');
  await fsp.writeFile(truncated, zlib.gzipSync(Buffer.concat([rawHeader({ name: 'a.txt', size: 1000 }), Buffer.alloc(100)])));
  await assert.rejects(() => extractTarGz({ file: truncated, destDir: path.join(dir, 't') }), (err) => err.code === 'ARCHIVE_CORRUPT');

  // Inflation bomb and entry-count caps.
  const big = await rawArchive(dir, [{ name: 'big.bin', data: Buffer.alloc(2 * 1024 * 1024) }]);
  await assert.rejects(() => extractTarGz({ file: big, destDir: path.join(dir, 'b'), maxTotalBytes: 1024 * 1024 }), (err) => err.code === 'ARCHIVE_TOO_LARGE');
  const many = await rawArchive(dir, [{ name: 'a', data: '1' }, { name: 'b', data: '2' }, { name: 'c', data: '3' }]);
  await assert.rejects(() => extractTarGz({ file: many, destDir: path.join(dir, 'm'), maxEntries: 2 }), (err) => err.code === 'ARCHIVE_TOO_LARGE');

  // Not gzip at all.
  const garbage = path.join(dir, 'garbage.tar.gz');
  await fsp.writeFile(garbage, 'definitely not gzip');
  await assert.rejects(() => extractTarGz({ file: garbage, destDir: path.join(dir, 'g') }));
});

test('existing files are never overwritten and duplicate members are refused', async () => {
  const dir = await sandbox();
  const dup = await rawArchive(dir, [{ name: 'a.txt', data: 'one' }, { name: 'a.txt', data: 'two' }]);
  await assert.rejects(() => extractTarGz({ file: dup, destDir: path.join(dir, 'd') }));
  assert.equal(await fsp.readFile(path.join(dir, 'd', 'a.txt'), 'utf8'), 'one');

  const source = path.join(dir, 's.txt');
  await fsp.writeFile(source, 's');
  await assert.rejects(() => writeTarGz({ entries: [{ name: 'a', path: source }, { name: 'a', path: source }], outFile: path.join(dir, 'x.tar.gz') }), (err) => err.code === 'ARCHIVE_ENTRY_DUPLICATE');
  await assert.rejects(() => writeTarGz({ entries: [], outFile: path.join(dir, 'y.tar.gz') }), (err) => err.code === 'ARCHIVE_EMPTY');
});
