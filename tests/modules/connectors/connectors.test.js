/**
 * Tests for the csv + webhook connectors and their registration.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { CsvConnector } from '../../../src/modules/connectors/csv/csv.connector.js';
import { WebhookConnector } from '../../../src/modules/connectors/webhook/webhook.connector.js';
import { listConnectors, createConnector, getConnector } from '../../../src/connectors/index.js';
import './_registration.js';

const CSV = 'id,name\n1,Alice\n2,Bob\n';

test('CsvConnector validates its config via the shared validator', async () => {
  const ok = new CsvConnector({ config: { delimiter: ',' } });
  assert.deepEqual(await ok.validate(), { valid: true, errors: [] });

  const bad = new CsvConnector({ config: { delimiter: '::' } });
  const verdict = await bad.validate();
  assert.equal(verdict.valid, false);
});

test('CsvConnector.preview returns fields + sample without ingesting', async () => {
  const connector = new CsvConnector({ config: {} });
  const preview = await connector.preview({ buffer: Buffer.from(CSV), limit: 1 });
  assert.deepEqual(preview.fields, ['id', 'name']);
  assert.equal(preview.sample.length, 1);
});

test('CsvConnector.ingest streams parsed records', async () => {
  const connector = new CsvConnector({ config: {} });
  const rows = [];
  for await (const record of connector.ingest({ buffer: Buffer.from(CSV) })) {
    rows.push(record);
  }
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { id: '1', name: 'Alice' });
});

test('CsvConnector preview/ingest fail closed without a buffer', async () => {
  const connector = new CsvConnector({ config: {} });
  await assert.rejects(() => connector.preview({}), /requires a file buffer/);
  await assert.rejects(async () => {
    for await (const _r of connector.ingest({})) { /* drain */ }
  }, /requires a file buffer/);
});

test('WebhookConnector validates its config (signingSecret required)', async () => {
  const ok = new WebhookConnector({ config: { signingSecret: 'at-least-16-characters' } });
  assert.deepEqual(await ok.validate(), { valid: true, errors: [] });

  const bad = new WebhookConnector({ config: {} });
  assert.equal((await bad.validate()).valid, false);
});

test('WebhookConnector.ingest normalises payload shapes', async () => {
  const connector = new WebhookConnector({ config: { signingSecret: 'at-least-16-characters' } });
  assert.deepEqual(await connector.ingest({ payload: [{ a: 1 }, { a: 2 }] }), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(await connector.ingest({ payload: { events: [{ e: 1 }] } }), [{ e: 1 }]);
  assert.deepEqual(await connector.ingest({ payload: { data: [{ d: 1 }] } }), [{ d: 1 }]);
  assert.deepEqual(await connector.ingest({ payload: { id: 7 } }), [{ id: 7 }]);
  assert.deepEqual(await connector.ingest({ payload: null }), []);
});

test('csv and webhook connectors are registered and discoverable', () => {
  assert.ok(getConnector('csv'));
  assert.ok(getConnector('webhook'));
  const types = listConnectors().map((c) => c.type);
  assert.ok(types.includes('csv'));
  assert.ok(types.includes('webhook'));
});

test('createConnector returns a typed instance with the given context', () => {
  const instance = createConnector('webhook', { id: 'abc', config: { signingSecret: 'x'.repeat(20) }, tenantId: 't1' });
  assert.ok(instance instanceof WebhookConnector);
  assert.equal(instance.id, 'abc');
  assert.equal(instance.tenantId, 't1');
});
