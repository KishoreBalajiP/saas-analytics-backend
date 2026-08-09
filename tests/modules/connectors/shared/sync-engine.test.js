/**
 * Tests for `modules/connectors/shared/sync-engine.js`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestRecords } from '../../../../src/modules/connectors/shared/sync-engine.js';

/** Collect persisted batches into an in-memory sink. */
function makeSink() {
  const batches = [];
  const persist = async (batch) => {
    batches.push(batch);
    return { upserted: batch.length, matched: 0 };
  };
  return { batches, persist };
}

test('ingestRecords maps + persists an array of records', async () => {
  const { batches, persist } = makeSink();
  const result = await ingestRecords({
    records: [{ cust_id: 'C1', total: 5 }, { cust_id: 'C2', total: 9 }],
    fieldMapping: { customerId: 'cust_id', amount: { source: 'total', type: 'number' } },
    persist,
    batchSize: 10,
  });
  assert.equal(result.processed, 2);
  assert.equal(result.skipped, 0);
  assert.equal(result.upserted, 2);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0][0].data, { customerId: 'C1', amount: 5 });
  assert.equal(typeof batches[0][0].sourceRowId, 'string');
});

test('ingestRecords streams an async iterable and flushes by batch size', async () => {
  const { batches, persist } = makeSink();
  async function* gen() {
    for (let i = 1; i <= 12; i += 1) yield { id: `r${i}`, v: i };
  }
  const result = await ingestRecords({ records: gen(), persist, batchSize: 5 });
  assert.equal(result.processed, 12);
  assert.equal(batches.length, 3); // 5 + 5 + 2
});

test('ingestRecords skips non-object records and reports errors', async () => {
  const { batches, persist } = makeSink();
  const result = await ingestRecords({
    records: [{ id: 'ok' }, null, 42, 'str', { id: 'ok2' }],
    persist,
    batchSize: 10,
  });
  assert.equal(result.processed, 2);
  assert.equal(result.skipped, 3);
  assert.equal(result.errors.length, 3);
  assert.equal(batches[0].length, 2);
});

test('ingestRecords rejects rows via validateRow', async () => {
  const { batches, persist } = makeSink();
  const result = await ingestRecords({
    records: [{ id: 'a' }, { id: 'b' }],
    persist,
    validateRow: async ({ data }) => ({ valid: data.id === 'a' }),
  });
  assert.equal(result.skipped, 1);
  assert.equal(result.processed, 2);
  assert.equal(batches[0].length, 1);
});

test('ingestRecords works without a persist function (dry run)', async () => {
  const result = await ingestRecords({ records: [{ a: 1 }] });
  assert.equal(result.processed, 1);
  assert.equal(result.upserted, 0);
});

test('ingestRecords throws for non-iterable records', async () => {
  await assert.rejects(
    () => ingestRecords({ records: 42 }),
    /records must be an array or/,
  );
});
