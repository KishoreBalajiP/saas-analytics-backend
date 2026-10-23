/**
 * Delivery pipeline (roadmap 3.4): scheduled report runs fan out to every
 * recipient and destination, retries with backoff, dead-letters, HMAC
 * signing, SSRF refusal, unsubscribe, and alerts via the same pipeline.
 * Fake HTTP transport only; the outbox records but does not send.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { factories } from '../helpers/factories.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import { User } from '../../src/models/User.js';
import { DeliveryRun } from '../../src/models/DeliveryRun.js';
import { DeliveryDestination } from '../../src/models/DeliveryDestination.js';
import connectorRepository from '../../src/repositories/connector.repository.js';
import * as reportService from '../../src/services/report.service.js';
import * as alertService from '../../src/services/alert.service.js';
import * as outboxService from '../../src/services/outbox.service.js';
import delivery from '../../src/services/delivery/index.js';
import { setHttpTransport, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '../../src/services/delivery/transports.js';
import { entitleTenant } from '../helpers/billing.js';

const PUBLIC_URL = 'https://93.184.216.34/hook/abc-secret-path';
let tenantId;
let datasetId;
let calls;
let responder;

before(async () => { await startMongo(); outboxService.setDispatchOnEnqueue(false); });
after(async () => { setHttpTransport(null); await stopMongo(); });
beforeEach(async () => {
  await resetMongo();
  calls = [];
  responder = () => ({ status: 200 });
  setHttpTransport(async (req) => { calls.push(req); return responder(req); });
  tenantId = String((await factories.tenant.create({ status: 'active' }))._id);
  await entitleTenant(tenantId);
  datasetId = String((await connectorRepository.create({ tenantId, type: 'csv', name: 'Orders', status: 'active' }))._id);
  await ConnectorRow.collection.insertMany([{ tenantId, connectorId: new mongoose.Types.ObjectId(datasetId), sourceRowId: 'r1', data: { a: 1 } }]);
});

async function member(tid = tenantId) {
  return User.create({ tenantId: tid, email: `m-${crypto.randomBytes(4).toString('hex')}@example.com`, status: 'active', passwordHash: 'x', profile: { name: 'M' } });
}

test('a scheduled run creates one delivery per recipient and destination', async () => {
  const user = await member();
  const dest = await delivery.createDestination({ tenantId, type: 'slack', name: 'Ops', url: PUBLIC_URL });
  const report = await reportService.create({
    tenantId, name: 'Daily', source: 'query', format: 'csv', query: { datasetId },
    schedule: { enabled: false, recipients: [{ type: 'user', value: String(user._id) }, { type: 'external', value: 'Client@Example.org' }], destinationIds: [dest._id] },
  });
  const { runId } = await reportService.run({ tenantId, reportId: String(report._id), triggeredBy: 'schedule' });
  await reportService.processRun({ tenantId, reportId: String(report._id), runId, triggeredBy: 'schedule' });
  const runs = await DeliveryRun.find({ tenantId, reportRunId: runId });
  assert.equal(runs.length, 3);
  assert.ok(runs.every((r) => r.status === 'sent'), JSON.stringify(runs.map((r) => [r.status, r.lastError])));
  assert.deepEqual(runs.map((r) => r.destinationType).sort(), ['email', 'email', 'slack']);
  assert.equal(calls.length, 1);
  assert.match(JSON.parse(calls[0].body).text, /Daily/);
});

test('recipient validation: non-member users and other-tenant destinations are refused', async () => {
  const other = String((await factories.tenant.create({ status: 'active' }))._id);
  const stranger = await member(other);
  await assert.rejects(reportService.create({ tenantId, name: 'X', source: 'query', query: { datasetId }, schedule: { recipients: [{ type: 'user', value: String(stranger._id) }] } }), /recipient/i);
  const foreign = await delivery.createDestination({ tenantId: other, type: 'webhook', name: 'W', url: PUBLIC_URL });
  await assert.rejects(reportService.create({ tenantId, name: 'X', source: 'query', query: { datasetId }, schedule: { destinationIds: [foreign._id] } }), /destinations/i);
});

test('transient failure retries with backoff then succeeds', async () => {
  const dest = await delivery.createDestination({ tenantId, type: 'webhook', name: 'W', url: PUBLIC_URL });
  responder = () => ({ status: 503 });
  const first = await delivery.deliver({ tenantId, kind: 'test', destination: { type: 'webhook', destinationId: dest._id }, payload: { text: 'hi' }, idempotencyKey: 'k1' });
  assert.equal(first.status, 'retrying');
  responder = () => ({ status: 200 });
  const out = await delivery.retryDue({ now: new Date(Date.now() + 24 * 3600e3) });
  assert.equal(out.retried, 1);
  const row = await DeliveryRun.findById(first.id);
  assert.equal(row.status, 'sent');
  assert.equal(row.attempts, 2);
  // idempotent: same key never sends again
  const again = await delivery.deliver({ tenantId, kind: 'test', destination: { type: 'webhook', destinationId: dest._id }, payload: {}, idempotencyKey: 'k1' });
  assert.equal(again.duplicate, true);
  assert.equal(calls.length, 2);
});

test('permanent failure dead-letters with history; manual retry works', async () => {
  const dest = await delivery.createDestination({ tenantId, type: 'teams', name: 'T', url: PUBLIC_URL });
  responder = () => ({ status: 404 });
  const res = await delivery.deliver({ tenantId, kind: 'test', destination: { type: 'teams', destinationId: dest._id }, payload: { text: 'x' }, idempotencyKey: 'k2' });
  assert.equal(res.status, 'dead');
  const { docs } = await delivery.listDeliveries({ tenantId });
  assert.equal(docs[0].status, 'dead');
  assert.match(docs[0].lastError, /HTTP_404/);
  assert.ok(docs[0].deadAt);
  assert.equal((await delivery.listDeliveries({ tenantId: 'other-tenant' })).total, 0);
  responder = () => ({ status: 200 });
  const retried = await delivery.retryDelivery({ tenantId, deliveryId: res.id });
  assert.equal(retried.status, 'sent');
  await assert.rejects(delivery.retryDelivery({ tenantId: 'other-tenant', deliveryId: res.id }), /not found/i);
});

test('webhook destination signs body with timestamp', async () => {
  const dest = await delivery.createDestination({ tenantId, type: 'webhook', name: 'W', url: PUBLIC_URL });
  assert.ok(dest.signingSecret);
  await delivery.deliver({ tenantId, kind: 'test', destination: { type: 'webhook', destinationId: dest._id }, payload: { text: 'x' }, idempotencyKey: 'k3' });
  const { headers, body } = calls[0];
  const ts = headers[TIMESTAMP_HEADER];
  assert.ok(Math.abs(Number(ts) - Date.now() / 1000) < 60);
  const expected = `v2=${crypto.createHmac('sha256', dest.signingSecret).update(`${ts}.${body}`).digest('hex')}`;
  assert.equal(headers[SIGNATURE_HEADER], expected);
});

test('private-network and non-https destination URLs are rejected', async () => {
  for (const url of ['https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://169.254.169.254/latest', 'http://93.184.216.34/x', 'https://[::1]/x']) {
    await assert.rejects(delivery.createDestination({ tenantId, type: 'webhook', name: 'W', url }), /URL/, url);
  }
});

test('secrets are encrypted at rest and never echoed', async () => {
  const dest = await delivery.createDestination({ tenantId, type: 'slack', name: 'S', url: PUBLIC_URL });
  assert.equal(JSON.stringify(dest).includes('abc-secret-path'), false);
  const raw = await DeliveryDestination.collection.findOne({});
  assert.equal(JSON.stringify(raw).includes('abc-secret-path'), false);
  const listed = await delivery.listDestinations({ tenantId });
  assert.equal(JSON.stringify(listed).includes('abc-secret-path'), false);
  assert.equal(listed[0].urlHint, '93.184.216.34');
});

test('unsubscribe stops external deliveries', async () => {
  const token = delivery.unsubscribeToken(tenantId, 'ext@example.org');
  await assert.rejects(delivery.unsubscribe({ token: `${token}x` }), /Invalid/);
  await delivery.unsubscribe({ token });
  const res = await delivery.deliver({ tenantId, kind: 'report', destination: { type: 'email', to: 'ext@example.org', external: true }, payload: { template: 'report.delivered', variables: { reportName: 'R' } }, idempotencyKey: 'k4' });
  assert.equal(res.status, 'skipped');
  const ok = await delivery.deliver({ tenantId, kind: 'report', destination: { type: 'email', to: 'other@example.org', external: true }, payload: { template: 'report.delivered', variables: { reportName: 'R' } }, idempotencyKey: 'k5' });
  assert.equal(ok.status, 'sent');
});

test('alerts deliver through the pipeline (email + destination)', async () => {
  const dest = await delivery.createDestination({ tenantId, type: 'webhook', name: 'W', url: PUBLIC_URL });
  const alert = await alertService.createRule({
    tenantId, name: 'Any rows', source: 'query', query: { datasetId }, metric: 'count', condition: 'gt', threshold: 0,
    notification: { channels: ['email'], recipients: [{ type: 'email', value: 'oncall@example.org' }], destinationIds: [dest._id] },
  }).catch((err) => { throw new Error(`createRule: ${err.message} ${JSON.stringify(err.errors ?? '')}`); });
  const out = await alertService.evaluate({ tenantId, alertId: String(alert._id) });
  assert.equal(out.triggered, true, JSON.stringify(out));
  const runs = await DeliveryRun.find({ tenantId, kind: 'alert' });
  assert.deepEqual(runs.map((r) => r.destinationType).sort(), ['email', 'webhook']);
  assert.ok(runs.every((r) => r.status === 'sent'));
});
