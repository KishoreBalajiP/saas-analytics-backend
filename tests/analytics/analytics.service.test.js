import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useMongo, resetMongo } from '../helpers/index.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import * as cacheService from '../../src/services/cache.service.js';
import * as analyticsService from '../../src/services/analytics.service.js';

useMongo();
beforeEach(async () => { await resetMongo(); await cacheService.flushAll(); });

const mongoose = (await import('mongoose')).default;
const { ObjectId } = mongoose.Types;
const TA = 'tenant-a';
const ca = new ObjectId();

test('query runs the engine and caches the result', async () => {
  await ConnectorRow.insertMany([
    { tenantId: TA, connectorId: ca, sourceRowId: 'r1', data: { region: 'EU', amount: 100 }, ingestedAt: new Date('2024-01-02') },
    { tenantId: TA, connectorId: ca, sourceRowId: 'r2', data: { region: 'US', amount: 200 }, ingestedAt: new Date('2024-01-03') },
  ]);
  const params = { tenantId: TA, pagination: { page: 1, limit: 50 }, groupBy: [{ field: 'region' }], metrics: [{ alias: 'count', op: 'count', field: 'amount' }] };
  const first = await analyticsService.query(params);
  assert.equal(first.cached, false);
  assert.equal(first.total, 2);
  assert.ok(first.cacheKey);
  assert.ok(first.queryId, 'a fresh run persists a history record');

  const second = await analyticsService.query(params);
  assert.equal(second.cached, true);
  assert.deepEqual(second.rows, first.rows);

  const list = await analyticsService.listQueries({ tenantId: TA, page: 1, limit: 10 });
  assert.equal(list.total, 1, 'a cached hit does not create another history record');
});

test('query requires tenantId', async () => {
  await assert.rejects(() => analyticsService.query({}), (e) => e.statusCode === 400);
});

test('query with no rows returns empty', async () => {
  const r = await analyticsService.query({ tenantId: TA, pagination: { page: 1, limit: 50 } });
  assert.equal(r.total, 0);
  assert.equal(r.rows.length, 0);
});

test('getQuery 404s on an unknown id', async () => {
  await assert.rejects(
    () => analyticsService.getQuery({ tenantId: TA, id: new ObjectId().toString() }),
    (e) => e.statusCode === 404,
  );
});

test('getQuery round-trips a persisted run', async () => {
  await ConnectorRow.insertMany([
    { tenantId: TA, connectorId: ca, sourceRowId: 'r1', data: { region: 'EU', amount: 100 }, ingestedAt: new Date('2024-01-02') },
  ]);
  const run = await analyticsService.query({ tenantId: TA, pagination: { page: 1, limit: 50 }, filters: [{ field: 'region', op: 'eq', value: 'EU' }] });
  assert.ok(run.queryId);
  const got = await analyticsService.getQuery({ tenantId: TA, id: run.queryId });
  assert.equal(got.status, 'ready');
  assert.equal(got.resultMeta.rowCount, 1);
  assert.equal(got.resultMeta.cached, false);
});

test('different tenants get isolated caches', async () => {
  await ConnectorRow.insertMany([
    { tenantId: TA, connectorId: ca, sourceRowId: 'r1', data: { amount: 1 }, ingestedAt: new Date() },
    { tenantId: 'tenant-b', connectorId: ca, sourceRowId: 'r2', data: { amount: 2 }, ingestedAt: new Date() },
  ]);
  const a = await analyticsService.query({ tenantId: TA, pagination: { page: 1, limit: 50 } });
  const b = await analyticsService.query({ tenantId: 'tenant-b', pagination: { page: 1, limit: 50 } });
  assert.equal(a.total, 1);
  assert.equal(b.total, 1);
  assert.notEqual(a.cacheKey, b.cacheKey);
});
