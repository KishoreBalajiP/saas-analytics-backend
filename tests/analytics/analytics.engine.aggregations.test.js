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
  { t: TA, cid: ca, s: 'a-3', d: { region: 'EU', amount: 50, product: 'widget' }, ts: '2024-01-04T09:00:00Z' },
  { t: TA, cid: cb, s: 'b-1', d: { region: 'EU', amount: 300, product: 'widget' }, ts: '2024-01-05T09:00:00Z' },
];

beforeEach(async () => {
  await resetMongo();
  await ConnectorRow.insertMany(
    SAMPLES.map((s) => ({ tenantId: s.t, connectorId: s.cid, sourceRowId: s.s, data: s.d, ingestedAt: new Date(s.ts) })),
  );
});

const Q = (e) => queryRows({ tenantId: TA, pagination: { page: 1, limit: 50 }, ...e });

const byRegion = (rows, key) => Object.fromEntries(rows.map((x) => [x.region, x[key]]));

test('groupBy region + default count', async () => {
  const r = await Q({ groupBy: [{ field: 'region' }] });
  assert.equal(r.groupMode, true);
  assert.equal(r.total, 2);
  assert.deepEqual(byRegion(r.rows, 'count'), { EU: 3, US: 1 });
  assert.deepEqual(r.columns.slice().sort(), ['count', 'region']);
});

test('groupBy + sum/avg/min/max (aliased)', async () => {
  const r = await Q({
    groupBy: [{ field: 'region' }],
    metrics: [
      { alias: 'sum', op: 'sum', field: 'amount' },
      { alias: 'avg', op: 'avg', field: 'amount' },
      { alias: 'min', op: 'min', field: 'amount' },
      { alias: 'max', op: 'max', field: 'amount' },
    ],
  });
  const m = Object.fromEntries(r.rows.map((x) => [x.region, { sum: x.sum, avg: x.avg, min: x.min, max: x.max }]));
  assert.deepEqual(m, {
    EU: { sum: 450, avg: 150, min: 50, max: 300 },
    US: { sum: 200, avg: 200, min: 200, max: 200 },
  });
});

test('orderBy desc by metric', async () => {
  const r = await Q({
    groupBy: [{ field: 'region' }],
    metrics: [{ alias: 'total', op: 'sum', field: 'amount' }],
    orderBy: [{ field: 'total', direction: 'desc' }],
  });
  assert.equal(r.rows[0].region, 'EU');
  assert.equal(r.rows[1].region, 'US');
});

test('groupBy multiple fields', async () => {
  const r = await Q({ groupBy: [{ field: 'region' }, { field: 'product' }] });
  assert.equal(r.total, 2);
  assert.deepEqual(r.columns.slice().sort(), ['count', 'product', 'region']);
  const rows = r.rows.sort((a, b) => a.region.localeCompare(b.region));
  assert.deepEqual(rows[0], { region: 'EU', product: 'widget', count: 3 });
  assert.deepEqual(rows[1], { region: 'US', product: 'gadget', count: 1 });
});

test('grouping respects connectorIds', async () => {
  const r = await Q({ connectorIds: [String(ca)], groupBy: [{ field: 'region' }] });
  assert.deepEqual(byRegion(r.rows, 'count'), { EU: 2, US: 1 });
});

test('numeric-string data coerces via $toDouble', async () => {
  await ConnectorRow.insertMany([
    { tenantId: TA, connectorId: ca, sourceRowId: 's-1', data: { region: 'EU', amount: '400' }, ingestedAt: new Date('2024-01-07T09:00:00Z') },
  ]);
  const r = await Q({ groupBy: [{ field: 'region' }], metrics: [{ alias: 'sum', op: 'sum', field: 'amount' }] });
  assert.equal(byRegion(r.rows, 'sum').EU, 850);
});
