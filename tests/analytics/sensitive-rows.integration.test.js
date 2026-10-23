import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { useMongo, resetMongo } from '../helpers/index.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import { queryRows, openRowStream } from '../../src/services/analytics.engine.js';
import connectorRowRepository from '../../src/repositories/connectorRow.repository.js';
import { reportSensitiveRows } from '../../scripts/ci/report-sensitive-rows.js';

useMongo();
const { ObjectId } = mongoose.Types;
const T = 'tenant-s';
const cid = new ObjectId();

beforeEach(async () => {
  await resetMongo();
  // Legacy row ingested before the sanitizer existed.
  await ConnectorRow.create({ tenantId: T, connectorId: cid, sourceRowId: 'legacy', data: { region: 'EU', password: 'p', fcmToken: 'f' }, ingestedAt: new Date() });
});

test('query-time stripping hides legacy sensitive keys from raw rows, columns and streams', async () => {
  const r = await queryRows({ tenantId: T, pagination: { page: 1, limit: 10 } });
  assert.deepEqual(r.rows[0].data, { region: 'EU' });
  assert.deepEqual(r.columns, ['region']);
  const s = await openRowStream({ tenantId: T });
  assert.deepEqual(s.columns, ['region']);
  for await (const row of s.rows) assert.deepEqual(row.data, { region: 'EU' });
});

test('ingestion strips sensitive keys before persisting', async () => {
  await connectorRowRepository.upsertRows(cid, T, [{ sourceRowId: 'new', data: { region: 'US', otp: '1234', api_key: 'k', tokens_used: 5 } }]);
  const doc = await ConnectorRow.findOne({ sourceRowId: 'new' }).lean();
  assert.deepEqual(doc.data, { region: 'US', tokens_used: 5 });
});

test('raw row listing strips keys and caps the page size', async () => {
  const res = await connectorRowRepository.list({ connectorId: cid, tenantId: T, limit: 100000 });
  assert.equal(res.limit, 200);
  assert.deepEqual(res.docs[0].data, { region: 'EU' });
});

test('dry-run report counts legacy rows without modifying them', async () => {
  const rep = await reportSensitiveRows();
  assert.equal(rep.dryRun, true);
  assert.equal(rep.affectedRows, 1);
  assert.equal(rep.groups[0].tenantId, T);
  const raw = await ConnectorRow.findOne({ sourceRowId: 'legacy' }).lean();
  assert.equal(raw.data.password, 'p');
});
