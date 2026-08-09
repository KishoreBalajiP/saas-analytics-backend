/**
 * Integration tests for `services/connector.service.js`.
 *
 * Covers tenant-scoped CRUD, config encryption at rest, CSV sync via the
 * queue worker pipeline, webhook signature verification + ingest, and
 * idempotent row persistence.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { useMongo } from '../helpers/index.js';
import connectorService from '../../src/services/connector.service.js';
import connectorRepository from '../../src/repositories/connector.repository.js';
import connectorRowRepository from '../../src/repositories/connectorRow.repository.js';
import { computeSignature } from '../../src/modules/connectors/webhook/webhook.verify.js';
import { WebhookSignatureError } from '../../src/modules/connectors/shared/errors.js';

useMongo();

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const SECRET = 'integration-test-signing-secret-0001';

/** Poll until `predicate()` is truthy or the timeout elapses. */
async function waitFor(predicate, { timeout = 2000, interval = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

test('CRUD: create, list, get, update, validate, delete', async () => {
  const created = await connectorService.createConnectorRecord({
    tenantId: TENANT_A,
    actorId: 'u1',
    type: 'csv',
    name: 'Orders CSV',
    config: { delimiter: ',' },
    fieldMapping: { customerId: 'cust_id' },
  });
  assert.equal(created.type, 'csv');
  assert.equal(created.configSummary.delimiter, ',');
  // The encrypted envelope must never be returned to clients.
  assert.equal('config' in created, false);

  const listed = await connectorService.listConnectorRecords({ tenantId: TENANT_A });
  assert.equal(listed.total, 1);

  // Tenant isolation: tenant B sees nothing.
  const other = await connectorService.listConnectorRecords({ tenantId: TENANT_B });
  assert.equal(other.total, 0);

  const got = await connectorService.getConnectorRecord({ tenantId: TENANT_A, connectorId: String(created._id) });
  assert.equal(got.name, 'Orders CSV');

  const updated = await connectorService.updateConnectorRecord({
    tenantId: TENANT_A,
    connectorId: String(created._id),
    actorId: 'u2',
    patch: { name: 'Orders v2', config: { delimiter: ';' } },
  });
  assert.equal(updated.name, 'Orders v2');
  assert.equal(updated.configSummary.delimiter, ';');

  const verdict = await connectorService.validateConnectorRecord({ tenantId: TENANT_A, connectorId: String(created._id) });
  assert.equal(verdict.valid, true);

  await connectorService.deleteConnectorRecord({ tenantId: TENANT_A, connectorId: String(created._id), actorId: 'u1' });
  const after = await connectorService.listConnectorRecords({ tenantId: TENANT_A });
  assert.equal(after.total, 0);
});

test('create rejects invalid configs and unknown types', async () => {
  await assert.rejects(
    () => connectorService.createConnectorRecord({ tenantId: TENANT_A, type: 'csv', name: 'x', config: { delimiter: '::' } }),
    (err) => err.code === 'CONFIG_INVALID',
  );
  await assert.rejects(
    () => connectorService.createConnectorRecord({ tenantId: TENANT_A, type: 'postgres', name: 'x', config: {} }),
    (err) => err.code === 'CONFIG_INVALID',
  );
});

test('config is encrypted at rest (raw envelope is not JSON config)', async () => {
  const created = await connectorService.createConnectorRecord({
    tenantId: TENANT_A,
    type: 'webhook',
    name: 'Inbound',
    config: { signingSecret: SECRET, requireTimestamp: true },
  });
  const raw = await connectorRepository.findById(String(created._id), { tenantId: TENANT_A });
  assert.equal(typeof raw.config, 'string');
  assert.ok(raw.config.startsWith('enc:v1:'), 'config should be an encrypted envelope');
  // Decrypted config matches the original secret.
  const get = await connectorService.getConnectorRecord({ tenantId: TENANT_A, connectorId: String(created._id) });
  assert.equal(get.configSummary.signingSecretConfigured, true);
  assert.equal(get.configSummary.requireTimestamp, true);
});

test('webhook: valid HMAC enqueues + persists rows; bad signature fails closed', async () => {
  const created = await connectorService.createConnectorRecord({
    tenantId: TENANT_A,
    type: 'webhook',
    name: 'Stripe',
    config: { signingSecret: SECRET },
  });

  // Capture the enqueued job instead of letting the worker run it.
  const captured = [];

  // Register a capture consumer on the module queue handle.
  const { connectorQueue } = await import('../../src/queues/connector.queue.js');
  const q = connectorQueue.getQueue();
  const unregister = q.consume((job) => { captured.push(job); });

  const body = Buffer.from(JSON.stringify({ events: [{ id: 'evt_1', amount: 1200 }] }));
  const sig = computeSignature(body, SECRET);
  const result = await connectorService.handleWebhook({
    webhookToken: created.webhookToken,
    rawBody: body,
    headers: { 'x-saas-signature': sig, 'x-saas-timestamp': String(Math.floor(Date.now() / 1000)) },
  });
  assert.equal(result.accepted, true);
  assert.equal(result.received, 1);

  const got = await waitFor(() => captured.length === 1);
  assert.equal(got, true, 'webhook job should be enqueued');
  const job = captured[0];
  assert.equal(job.data.jobType, 'ingest');
  assert.deepEqual(job.data.payload.records, [{ id: 'evt_1', amount: 1200 }]);

  // Process the captured job through the worker pipeline.
  const sync = await connectorService.processSyncMessage(job);
  assert.equal(sync.processed, 1);
  assert.equal(sync.upserted, 1);

  const rows = await connectorService.listConnectorRows({ tenantId: TENANT_A, connectorId: String(created._id) });
  assert.equal(rows.total, 1);
  assert.deepEqual(rows.docs[0].data, { id: 'evt_1', amount: 1200 });

  // Bad signature -> 401-shaped error, nothing enqueued.
  const capturedBefore = captured.length;
  await assert.rejects(
    () => connectorService.handleWebhook({
      webhookToken: created.webhookToken,
      rawBody: body,
      headers: { 'x-saas-signature': 'sha256=0000000000000000000000000000000000000000000000000000000000000000' },
    }),
    WebhookSignatureError,
  );
  assert.equal(captured.length, capturedBefore, 'invalid signature must not enqueue');
});

test('webhook: unknown token fails closed like a bad signature', async () => {
  const body = Buffer.from('{}');
  await assert.rejects(
    () => connectorService.handleWebhook({ webhookToken: 'nope', rawBody: body, headers: {} }),
    WebhookSignatureError,
  );
});

test('csv: enqueued sync streams, maps and persists rows idempotently', async () => {
  const created = await connectorService.createConnectorRecord({
    tenantId: TENANT_A,
    type: 'csv',
    name: 'Customers',
    config: {},
    fieldMapping: { customerId: 'id', name: { source: 'name', type: 'string' } },
  });

  const csv = Buffer.from('id,name\n1,Alice\n2,Bob\n');
  const enqueued = await connectorService.syncCsvUpload({
    tenantId: TENANT_A,
    connectorId: String(created._id),
    buffer: csv,
    filename: 'customers.csv',
  });
  assert.equal(enqueued.accepted, true);

  // Preview first (no ingest).
  const preview = await connectorService.previewCsvUpload({
    tenantId: TENANT_A,
    connectorId: String(created._id),
    buffer: csv,
    limit: 1,
  });
  assert.deepEqual(preview.fields, ['id', 'name']);

  // Run the worker pipeline directly.
  const job = {
    data: {
      connectorId: String(created._id),
      tenantId: TENANT_A,
      jobType: 'ingest',
      payload: { buffer: csv.toString('base64'), filename: 'customers.csv' },
    },
  };
  const sync = await connectorService.processSyncMessage(job);
  assert.equal(sync.processed, 2);
  assert.equal(sync.upserted, 2);

  const rows = await connectorService.listConnectorRows({ tenantId: TENANT_A, connectorId: String(created._id) });
  assert.equal(rows.total, 2);
  const dataSet = rows.docs.map((r) => r.data).sort((a, b) => a.customerId.localeCompare(b.customerId));
  assert.deepEqual(dataSet, [
    { customerId: '1', name: 'Alice' },
    { customerId: '2', name: 'Bob' },
  ]);

  // Replay: same source rows -> no new rows, only matches.
  const replay = await connectorService.processSyncMessage(job);
  assert.equal(replay.upserted, 0);
  assert.equal(replay.matched, 2);
  const rowsAfter = await connectorService.listConnectorRows({ tenantId: TENANT_A, connectorId: String(created._id) });
  assert.equal(rowsAfter.total, 2);

  // lastSyncedAt updated after a successful sync.
  const updated = await connectorRepository.findById(String(created._id), { tenantId: TENANT_A });
  assert.ok(updated.lastSyncedAt instanceof Date);
});
