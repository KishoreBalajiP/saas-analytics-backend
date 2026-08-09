import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { useMongo, resetMongo } from '../helpers/index.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import analyticsController from '../../src/controllers/analytics.controller.js';
import * as cacheService from '../../src/services/cache.service.js';

useMongo();
const { ObjectId } = mongoose.Types;
const TA = 'tenant-a';
const ca = new ObjectId();

beforeEach(async () => { await resetMongo(); await cacheService.flushAll(); });

function mockRes() {
  const res = { statusCode: 0, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('queryRows parses query params and returns rows', async () => {
  await ConnectorRow.insertMany([
    { tenantId: TA, connectorId: ca, sourceRowId: 'r1', data: { region: 'EU', amount: 100 }, ingestedAt: new Date('2024-01-02') },
    { tenantId: TA, connectorId: ca, sourceRowId: 'r2', data: { region: 'US', amount: 200 }, ingestedAt: new Date('2024-01-03') },
  ]);
  const req = { tenant: { id: TA }, user: { id: 'u1' }, query: { page: '1', limit: '50' } };
  const res = mockRes();
  await analyticsController.queryRows(req, res, () => {});
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.length, 2);
  assert.equal(res.body.meta.total, 2);
  assert.equal(res.body.meta.limit, 50);
  assert.equal(res.body.meta.cached, false);
  assert.equal(res.body.meta.groupMode, false);
});

test('queryRows parses JSON-encoded complex params', async () => {
  await ConnectorRow.insertMany([
    { tenantId: TA, connectorId: ca, sourceRowId: 'r1', data: { region: 'EU', amount: 100 }, ingestedAt: new Date('2024-01-02') },
    { tenantId: TA, connectorId: ca, sourceRowId: 'r2', data: { region: 'US', amount: 200 }, ingestedAt: new Date('2024-01-03') },
  ]);
  const req = {
    tenant: { id: TA },
    user: { id: 'u1' },
    query: {
      page: '1', limit: '50',
      filters: JSON.stringify([{ field: 'region', op: 'eq', value: 'EU' }]),
      groupBy: JSON.stringify([{ field: 'region' }]),
      metrics: JSON.stringify([{ alias: 'count', op: 'count', field: 'amount' }]),
    },
  };
  const res = mockRes();
  await analyticsController.queryRows(req, res, () => {});
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.meta.groupMode, true);
  assert.deepEqual(res.body.meta.columns.slice().sort(), ['count', 'region']);
});

test('queryRows rejects malformed JSON params with 400', async () => {
  const req = { tenant: { id: TA }, query: { filters: '{bad json' } };
  const res = mockRes();
  let captured = null;
  await analyticsController.queryRows(req, res, (err) => { captured = err; });
  assert.ok(captured, 'expected next(err) to be called');
  assert.equal(captured.statusCode, 400);
});

test('queryRows fails closed without a tenant (400)', async () => {
  const req = { query: {} };
  const res = mockRes();
  let captured = null;
  await analyticsController.queryRows(req, res, (err) => { captured = err; });
  assert.ok(captured);
  assert.equal(captured.statusCode, 400);
});

test('exportAsync schedules and returns 202', async () => {
  const req = { tenant: { id: TA }, user: { id: 'u1' }, body: { connectorIds: [String(ca)] } };
  const res = mockRes();
  await analyticsController.exportAsync(req, res, () => {});
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.data.accepted, true);
  assert.ok(res.body.data.jobId);
});
