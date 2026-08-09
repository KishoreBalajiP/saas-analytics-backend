import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { useMongo, resetMongo } from '../helpers/index.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import { queryRows } from '../../src/services/analytics.engine.js';

useMongo();
const { ObjectId } = mongoose.Types;
const TA = 'tenant-a';
const ca = new ObjectId();
const cb = new ObjectId();

const SAMPLES = [
  { t: TA, cid: ca, s: 'a-1', d: { region: 'EU', amount: 100, product: 'widget' }, ts: '2024-01-02T09:00:00Z' },
  { t: TA, cid: ca, s: 'a-2', d: { region: 'US', amount: 200, product: 'gadget' }, ts: '2024-01-03T09:00:00Z' },
  { t: TA, cid: cb, s: 'b-1', d: { region: 'EU', amount: 300, product: 'widget' }, ts: '2024-01-05T09:00:00Z' },
];

beforeEach(async () => {
  await resetMongo();
  await ConnectorRow.insertMany(
    SAMPLES.map((s) => ({ tenantId: s.t, connectorId: s.cid, sourceRowId: s.s, data: s.d, ingestedAt: new Date(s.ts) })),
  );
});

const Q = (e) => queryRows({ tenantId: TA, pagination: { page: 1, limit: 50 }, ...e });

test('connectorIds restricts to named connectors', async () => {
  assert.equal((await Q({ connectorIds: [String(ca)] })).total, 2);
});

test('filter eq on a data field', async () => {
  assert.equal((await Q({ filters: [{ field: 'region', op: 'eq', value: 'EU' }] })).total, 2);
});

test('filter neq', async () => {
  assert.equal((await Q({ filters: [{ field: 'region', op: 'neq', value: 'EU' }] })).total, 1);
});

test('filter range gte + lte on numeric data', async () => {
  const r = await Q({ filters: [{ field: 'amount', op: 'gte', value: 150 }, { field: 'amount', op: 'lte', value: 250 }] });
  assert.equal(r.total, 1);
});

test('filter in', async () => {
  const r = await Q({ filters: [{ field: 'product', op: 'in', value: ['widget', 'gadget'] }] });
  assert.equal(r.total, 3);
});

test('dateRange window', async () => {
  const r = await Q({ dateRange: { from: '2024-01-03', to: '2024-01-04' } });
  assert.equal(r.total, 1);
});

test('pagination honors page/limit', async () => {
  const r = await Q({ pagination: { page: 2, limit: 1 } });
  assert.equal(r.total, 3);
  assert.equal(r.rows.length, 1);
  assert.equal(r.page, 2);
  assert.equal(r.pages, 3);
});

test('filtersOp or', async () => {
  const r = await Q({
    filters: [{ field: 'region', op: 'eq', value: 'EU' }, { field: 'amount', op: 'eq', value: 200 }],
    filtersOp: 'or',
  });
  assert.equal(r.total, 3);
});

test('impossible filter returns empty', async () => {
  const r = await Q({ filters: [{ field: 'region', op: 'eq', value: 'NA' }] });
  assert.equal(r.total, 0);
  assert.equal(r.pages, 0);
});

test('unknown filter operator is ignored (not a crash)', async () => {
  const r = await Q({ filters: [{ field: 'region', op: 'bogus', value: 'EU' }] });
  assert.equal(r.total, 3); // no-op filter
});
