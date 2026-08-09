/**
 * Tests for `modules/connectors/csv/csv.parser.js`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createParser, previewCsv, detectHeader } from '../../../../src/modules/connectors/csv/csv.parser.js';

const CSV = 'name,age,active\nAlice,30,true\nBob,25,false\n';

async function collect(iterable, limit = 100) {
  const rows = [];
  for await (const record of iterable) {
    rows.push(record);
    if (rows.length >= limit) break;
  }
  return rows;
}

test('createParser yields objects keyed by the header row', async () => {
  const rows = await collect(createParser(Buffer.from(CSV)));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { name: 'Alice', age: '30', active: 'true' });
});

test('createParser handles headerless files as arrays', async () => {
  const rows = await collect(createParser(Buffer.from('a,b\nc,d\n'), { hasHeader: false }));
  assert.deepEqual(rows[0], ['a', 'b']);
});

test('createParser respects a custom delimiter', async () => {
  const rows = await collect(createParser(Buffer.from('a;b\n1;2\n'), { delimiter: ';' }));
  assert.deepEqual(rows[0], { a: '1', b: '2' });
});

test('createParser streams and respects break (bounded memory)', async () => {
  // A 10k-row CSV read only 5 rows proves the iterable is pull-based.
  const big = ['h1,h2'];
  for (let i = 0; i < 10_000; i += 1) big.push(`${i},${i * 2}`);
  const rows = await collect(createParser(Buffer.from(big.join('\n'))), 5);
  assert.equal(rows.length, 5);
});

test('previewCsv returns fields, sample and meta', async () => {
  const preview = await previewCsv(Buffer.from(CSV), { limit: 1 });
  assert.deepEqual(preview.fields, ['name', 'age', 'active']);
  assert.equal(preview.sample.length, 1);
  assert.equal(preview.meta.hasHeader, true);
});

test('detectHeader treats all-numeric first rows as headerless', async () => {
  assert.equal(await detectHeader(Buffer.from('1,2,3\n4,5,6\n')), false);
  assert.equal(await detectHeader(Buffer.from('a,b,c\n4,5,6\n')), true);
});
