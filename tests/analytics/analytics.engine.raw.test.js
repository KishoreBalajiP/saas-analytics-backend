import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { useMongo, resetMongo } from '../helpers/index.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import { queryRows } from '../../src/services/analytics.engine.js';

useMongo();
const { ObjectId } = mongoose.Types;
const TA = 'tenant-a';
const TB = 'tenant-b';
const ca = new ObjectId();

const SAMPLES = [
  { t: TA, cid: ca, s: 'a-1', d: { region: 'EU', amount: 100 }, ts: '2024-01-02T09:00:00Z' },
  { t: TA, cid: ca, s: 'a-2', d: { region: 'US', amount: 200 }, ts: '2024-01-03T09:00:00Z' },
  { t: TB, cid: ca, s: 'b-1', d: { region: 'US', amount: 999 }, ts: '2024-01-06T09:00:00Z' },
];

beforeEach(async () => {
  await resetMongo();
  await ConnectorRow.insertMany(
    SAMPLES.map((s) => ({ tenantId: s.t, connectorId: s.cid, sourceRowId: s.s, data: s.d, ingestedAt: new Date(s.ts) })),
  );
});

test('tenant scoping + raw columns', async () => {
  const r = await queryRows({ tenantId: TA, pagination: { page: 1, limit: 50 } });
  assert.equal(r.groupMode, false);
  assert.equal(r.total, 2);
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.columns.slice().sort(), ['amount', 'region']);
});

test('no leakage across tenants', async () => {
  const r = await queryRows({ tenantId: TB, pagination: { page: 1, limit: 50 } });
  assert.equal(r.total, 1);
  assert.equal(r.rows[0].data.amount, 999);
});
