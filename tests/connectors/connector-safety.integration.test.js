/**
 * Integration tests for the connector package of the Phase 1 roadmap
 * (1.6 connector side, 1.7 connector safety, 1.8 webhook integrity), over
 * real HTTP against an in-memory MongoDB:
 *
 *   - uploads: oversize -> 413 FILE_TOO_LARGE, wrong type -> 415 with typed codes
 *   - webhooks: timestamp-bound signatures, replay refused, stale / missing
 *     timestamps refused, cheap pre-checks run BEFORE key derivation, legacy
 *     transition, paused connector, storedRows metering
 *   - suspended tenant: webhook ingest and manual syncs refused
 *   - connector errors never echo hosts or credentials
 *   - delete cascade: dependants marked broken, schedules stopped, the
 *     tenant's analytics cache cleared; tenant isolation
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto, { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import env from '../../src/config/env.js';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import { buildXlsx, sheetXml } from '../helpers/zip.js';
import * as emailService from '../../src/services/email.service.js';
import tenantService from '../../src/services/tenant.service.js';
import tenantLifecycle from '../../src/services/tenantLifecycle.service.js';
import invitationService from '../../src/services/tenantInvitation.service.js';
import connectorService from '../../src/services/connector.service.js';
import * as analyticsService from '../../src/services/analytics.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import { buildCacheKey } from '../../src/services/analytics.cache.js';
import usageCounterRepository from '../../src/repositories/usageCounter.repository.js';
import usageReservationRepository from '../../src/repositories/usageReservation.repository.js';
import { UsageReservation } from '../../src/models/UsageReservation.js';
import tenantRepository from '../../src/repositories/tenant.repository.js';
import actorStatus from '../../src/modules/iam/auth/actorStatus.service.js';
import { Connector } from '../../src/models/Connector.js';
import { Report } from '../../src/models/Report.js';
import { AlertRule } from '../../src/models/AlertRule.js';
import { Widget } from '../../src/models/Widget.js';
import { Tenant } from '../../src/models/Tenant.js';
import { SyncRun } from '../../src/models/SyncRun.js';
import { recoverStaleConnectors } from '../../src/jobs/stale-job-recovery.job.js';
import syncRunRepository from '../../src/repositories/syncRun.repository.js';
import { connectorQueue } from '../../src/queues/connector.queue.js';
import webhookKeyCache from '../../src/modules/connectors/webhook/webhook.keyCache.js';
import { computeTimestampedSignature, computeSignature } from '../../src/modules/connectors/webhook/webhook.verify.js';
// billing: tenants exercising paid features need a plan that includes them.
import { entitleTenant } from '../helpers/billing.js';

const PASSWORD = 'ConnectorSafety123!';
const SECRET = 'connector-safety-signing-secret-01';
let baseUrl = '';
let captured = [];

before(async () => {
  await startMongo();
  baseUrl = await startHttp();
  // Capture connector jobs instead of running them; tests run the worker
  // explicitly with `processSyncMessage`.
  connectorQueue.getQueue().consume((job) => { captured.push(job); });
});
beforeEach(async () => {
  await resetMongo();
  await cacheService.flushAll();
  webhookKeyCache.clear();
  captured = [];
});
after(async () => { await emailService.close(); await stopHttp(); await stopMongo(); });

/* -------------------------------- helpers --------------------------------- */

async function captureInviteToken(fn) {
  const sink = [];
  emailService.captureInto(sink);
  try {
    await fn();
  } finally {
    emailService.stopCapture();
  }
  const link = sink.map((m) => m.text).join('\n').match(/https?:\/\/[^\s]+/u)?.[0];
  return link ? new URL(link).searchParams.get('token') : null;
}

/** An initialised, active workspace whose owner is logged in. */
async function workspace() {
  const email = `owner-${randomBytes(4).toString('hex')}@example.com`;
  let result;
  const token = await captureInviteToken(async () => {
    result = await tenantService.create({
      tenant: { name: `Conn ${randomBytes(3).toString('hex')}` },
      owner: { email, name: 'Owner' },
      initialize: true,
      by: 'platform-admin',
    });
  });
  await invitationService.accept({ token, name: 'Owner', password: PASSWORD });
  await entitleTenant(result.tenant._id, 'starter');
  const res = await api('/api/v1/auth/login', {
    method: 'POST', headers: { 'X-Tenant-Id': result.tenant.slug }, body: { email, password: PASSWORD },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return { tenantId: String(result.tenant._id), auth: { authorization: `Bearer ${res.json.data.accessToken}` } };
}

async function createConnector(ws, body) {
  const res = await api('/api/v1/connectors', { method: 'POST', headers: ws.auth, body });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.data;
}

async function upload(ws, connectorId, action, buffer, filename, type = 'application/octet-stream') {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), filename);
  const res = await fetch(`${baseUrl}/api/v1/connectors/${connectorId}/${action}`, {
    method: 'POST', headers: ws.auth, body: form,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function postWebhook(token, body, headers = {}) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const res = await fetch(`${baseUrl}/api/v1/webhooks/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: raw,
  });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
}

function signed(body, { timestamp = Math.floor(Date.now() / 1000), secret = SECRET } = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  return {
    raw,
    headers: {
      'x-saas-timestamp': String(timestamp),
      'x-saas-signature': computeTimestampedSignature({ timestamp, rawBody: raw, secret }),
    },
  };
}

const derivations = () => webhookKeyCache.stats().derivations;

/** Count real scrypt key derivations (utils/encryption.js) while `fn` runs. */
async function countScrypt(fn) {
  const original = nodeCrypto.scryptSync;
  let calls = 0;
  nodeCrypto.scryptSync = function counted(...args) {
    calls += 1;
    return original.apply(this, args);
  };
  try {
    await fn();
  } finally {
    nodeCrypto.scryptSync = original;
  }
  return calls;
}
const storedRows = async (tenantId) => (await usageCounterRepository.findOne(tenantId, 'storedRows'))?.value ?? 0;
const settle = () => new Promise((r) => setTimeout(r, 30));

async function webhookConnector(ws, extra = {}) {
  return createConnector(ws, { type: 'webhook', name: 'Events', config: { signingSecret: SECRET, ...extra } });
}

/* --------------------------------- uploads -------------------------------- */

test('uploads: wrong type -> 415 UNSUPPORTED_FILE_TYPE, xlsx into a CSV connector -> 415 FILE_TYPE_MISMATCH, legacy .xls -> 415', async () => {
  const ws = await workspace();
  const csv = await createConnector(ws, { type: 'csv', name: 'Orders', config: {} });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

  const byExtension = await upload(ws, csv._id, 'preview', png, 'photo.png', 'image/png');
  assert.equal(byExtension.status, 415);
  assert.equal(byExtension.json.code, 'UNSUPPORTED_FILE_TYPE');

  const disguised = await upload(ws, csv._id, 'sync', png, 'orders.csv', 'text/csv');
  assert.equal(disguised.status, 415);
  assert.equal(disguised.json.code, 'UNSUPPORTED_FILE_TYPE');

  const xlsx = buildXlsx([{ name: 'S', xml: sheetXml([['id'], [1]]) }]);
  const mismatch = await upload(ws, csv._id, 'preview', xlsx, 'orders.xlsx');
  assert.equal(mismatch.status, 415);
  assert.equal(mismatch.json.code, 'FILE_TYPE_MISMATCH');

  const legacy = await upload(ws, csv._id, 'preview', Buffer.from('anything'), 'old.xls');
  assert.equal(legacy.status, 415);
  assert.equal(legacy.json.code, 'UNSUPPORTED_FILE_TYPE');

  assert.equal(captured.length, 0, 'nothing was queued');
});

test('uploads: oversize -> 413 FILE_TOO_LARGE (multer cap and per-type cap); valid CSV and XLSX previews work', async () => {
  const ws = await workspace();
  const csv = await createConnector(ws, { type: 'csv', name: 'Orders', config: {} });
  const xl = await createConnector(ws, { type: 'xlsx', name: 'Book', config: { sheet: 0 } });
  const original = { csv: env.connectors.csvMaxUploadBytes, xlsx: env.connectors.xlsxMaxUploadBytes };
  try {
    env.connectors.csvMaxUploadBytes = 512;
    env.connectors.xlsxMaxUploadBytes = 512;
    const big = Buffer.from(`id,name\n${'1,abcdefgh\n'.repeat(200)}`);
    const capped = await upload(ws, csv._id, 'sync', big, 'big.csv', 'text/csv');
    assert.equal(capped.status, 413);
    assert.equal(capped.json.code, 'FILE_TOO_LARGE');

    env.connectors.xlsxMaxUploadBytes = 1024 * 1024; // multer now buffers it; the CSV cap still applies
    const perType = await upload(ws, csv._id, 'sync', big, 'big.csv', 'text/csv');
    assert.equal(perType.status, 413);
    assert.equal(perType.json.code, 'FILE_TOO_LARGE');
    assert.match(perType.json.message, /CSV/);
  } finally {
    env.connectors.csvMaxUploadBytes = original.csv;
    env.connectors.xlsxMaxUploadBytes = original.xlsx;
  }
  assert.equal(captured.length, 0);

  const ok = await upload(ws, csv._id, 'preview', Buffer.from('id,name\n1,Ada\n'), 'people.csv', 'text/csv');
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(ok.json.data.fields, ['id', 'name']);

  const book = buildXlsx([{ name: 'Data', xml: sheetXml([['id', 'name'], [1, 'Ada']]) }]);
  const xlPreview = await upload(ws, xl._id, 'preview', book, 'book.xlsx');
  assert.equal(xlPreview.status, 200, JSON.stringify(xlPreview.json));
  assert.deepEqual(xlPreview.json.data.sample, [{ id: 1, name: 'Ada' }]);
});

test('uploads: an XLSX zip bomb (tiny upload, huge sharedStrings) is refused with 413 before any XML is parsed', async () => {
  const ws = await workspace();
  const xl = await createConnector(ws, { type: 'xlsx', name: 'Book', config: {} });
  const previous = env.connectors.xlsxMaxUncompressedBytes;
  env.connectors.xlsxMaxUncompressedBytes = 2 * 1024 * 1024;
  try {
    const sst = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>${' '.repeat(24 * 1024 * 1024)}</t></si></sst>`;
    const bomb = buildXlsx([{ name: 'S', xml: sheetXml([['a'], [1]]) }], { extraEntries: [{ name: 'xl/sharedStrings.xml', data: sst }] });
    assert.ok(bomb.length < 256 * 1024, `upload is small (${bomb.length} bytes)`);
    const started = Date.now();
    for (const action of ['preview', 'sync']) {
      const res = await upload(ws, xl._id, action, bomb, 'bomb.xlsx');
      if (action === 'preview') {
        assert.equal(res.status, 413, JSON.stringify(res.json));
        assert.equal(res.json.code, 'FILE_TOO_LARGE');
        assert.equal(res.json.errors[0].field, 'file');
        assert.equal(res.json.errors[0].maxBytes, 2 * 1024 * 1024);
      } else {
        // Sync is accepted (parsing happens in the worker), where the same guard fails the job once.
        assert.equal(res.status, 202, JSON.stringify(res.json));
        await settle();
        const result = await connectorService.processSyncMessage(captured.shift());
        assert.equal(result.failed?.code, 'FILE_TOO_LARGE');
      }
    }
    assert.ok(Date.now() - started < 10_000);
  } finally {
    env.connectors.xlsxMaxUncompressedBytes = previous;
  }
});

test('file sync: XLSX and CSV over the row cap fail once with ROW_LIMIT_EXCEEDED (streamed, not retried); within the cap rows land', async () => {
  const ws = await workspace();
  const xl = await createConnector(ws, { type: 'xlsx', name: 'Book', config: {} });
  const csv = await createConnector(ws, { type: 'csv', name: 'Orders', config: {} });
  const previous = env.connectors.maxRowsPerSync;
  env.connectors.maxRowsPerSync = 5;
  try {
    const rows = [['id', 'amount'], ...Array.from({ length: 50 }, (_, i) => [i + 1, (i + 1) * 10])];
    const bigBook = buildXlsx([{ name: 'Data', xml: sheetXml(rows) }]);
    assert.equal((await upload(ws, xl._id, 'sync', bigBook, 'big.xlsx')).status, 202);
    await settle();
    const xlResult = await connectorService.processSyncMessage(captured.shift());
    assert.equal(xlResult.failed?.code, 'ROW_LIMIT_EXCEEDED', JSON.stringify(xlResult));
    const xlDoc = (await api(`/api/v1/connectors/${xl._id}`, { headers: ws.auth })).json.data;
    assert.equal(xlDoc.syncStatus, 'failed');
    assert.match(xlDoc.lastError, /more than 5 rows/);

    const bigCsv = Buffer.from(`id,amount\n${Array.from({ length: 50 }, (_, i) => `${i + 1},${i}`).join('\n')}\n`);
    assert.equal((await upload(ws, csv._id, 'sync', bigCsv, 'big.csv', 'text/csv')).status, 202);
    await settle();
    const csvResult = await connectorService.processSyncMessage(captured.shift());
    assert.equal(csvResult.failed?.code, 'ROW_LIMIT_EXCEEDED');

    const smallBook = buildXlsx([{ name: 'Data', xml: sheetXml([['id', 'amount'], [1, 10], [2, 20]]) }]);
    assert.equal((await upload(ws, xl._id, 'sync', smallBook, 'small.xlsx')).status, 202);
    await settle();
    const ok = await connectorService.processSyncMessage(captured.shift());
    assert.equal(ok.failed, undefined);
    assert.equal(ok.upserted, 2);
    const listed = await api(`/api/v1/connectors/${xl._id}/rows`, { headers: ws.auth });
    assert.ok(listed.json.data.some((r) => r.data?.amount === 20), JSON.stringify(listed.json.data));
  } finally {
    env.connectors.maxRowsPerSync = previous;
  }
});

/* --------------------------------- webhooks ------------------------------- */

test('webhook: valid v2 delivery is accepted; the same delivery replayed is refused (409 WEBHOOK_REPLAYED)', async () => {
  const ws = await workspace();
  const hook = await webhookConnector(ws);
  assert.equal(hook.webhookSignatureVersion, 2, 'new connectors use timestamp-bound signatures');
  assert.equal(hook.configSummary.requireTimestamp, true, 'v2 always requires the timestamp header');
  assert.equal(hook.configSummary.signingSecretConfigured, true);
  assert.equal(JSON.stringify(hook).includes(SECRET), false, 'the signing secret never leaves the server');

  const { raw, headers } = signed({ events: [{ id: 'evt_1', amount: 10 }] });
  const first = await postWebhook(hook.webhookToken, raw, headers);
  assert.equal(first.status, 202, JSON.stringify(first.json));
  assert.equal(first.json.data.received, 1);
  assert.equal(first.headers.get('deprecation'), null);

  const replay = await postWebhook(hook.webhookToken, raw, headers);
  assert.equal(replay.status, 409);
  assert.equal(replay.json.code, 'WEBHOOK_REPLAYED');

  await settle();
  assert.equal(captured.length, 1, 'the replay was not queued');
  const sync = await connectorService.processSyncMessage(captured[0]);
  assert.equal(sync.upserted, 1);
});

test('webhook: stale, future, missing and re-stamped timestamps are refused', async () => {
  const ws = await workspace();
  const hook = await webhookConnector(ws);
  const body = { id: 'evt_2' };

  const stale = signed(body, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
  const r1 = await postWebhook(hook.webhookToken, stale.raw, stale.headers);
  assert.equal(r1.status, 401);
  assert.equal(r1.json.code, 'WEBHOOK_TIMESTAMP_OUT_OF_WINDOW');

  const future = signed(body, { timestamp: Math.floor(Date.now() / 1000) + 900 });
  const r2 = await postWebhook(hook.webhookToken, future.raw, future.headers);
  assert.equal(r2.json.code, 'WEBHOOK_TIMESTAMP_OUT_OF_WINDOW');

  const fresh = signed(body);
  const r3 = await postWebhook(hook.webhookToken, fresh.raw, { 'x-saas-signature': fresh.headers['x-saas-signature'] });
  assert.equal(r3.status, 401);
  assert.equal(r3.json.code, 'WEBHOOK_TIMESTAMP_MISSING');

  // A captured (old) signature with a fresh timestamp does not verify.
  const old = signed(body, { timestamp: Math.floor(Date.now() / 1000) - 60 });
  const restamped = { ...old.headers, 'x-saas-timestamp': String(Math.floor(Date.now() / 1000)) };
  const r4 = await postWebhook(hook.webhookToken, old.raw, restamped);
  assert.equal(r4.status, 401);
  assert.equal(r4.json.code, 'WEBHOOK_SIGNATURE_INVALID');
  await settle();
  assert.equal(captured.length, 0);
});

test('webhook: cheap pre-checks reject bad requests WITHOUT key derivation; bad signatures cost at most one cached derivation', async () => {
  const ws = await workspace();
  const hook = await webhookConnector(ws);
  const body = { id: 'evt_3' };
  const start = derivations();

  const precheckScrypt = await countScrypt(async () => {
    for (let i = 0; i < 10; i += 1) {
      const malformed = await postWebhook(hook.webhookToken, JSON.stringify(body), {
        'x-saas-timestamp': String(Math.floor(Date.now() / 1000)), 'x-saas-signature': 'v2=not-hex',
      });
      assert.equal(malformed.status, 401);
      assert.equal(malformed.json.code, 'WEBHOOK_SIGNATURE_MALFORMED');
    }
    const stale = signed(body, { timestamp: 1000 });
    assert.equal((await postWebhook(hook.webhookToken, stale.raw, stale.headers)).json.code, 'WEBHOOK_TIMESTAMP_OUT_OF_WINDOW');
    const noTs = signed(body);
    const missingTs = await postWebhook(hook.webhookToken, noTs.raw, { 'x-saas-signature': noTs.headers['x-saas-signature'] });
    assert.equal(missingTs.json.code, 'WEBHOOK_TIMESTAMP_MISSING');
    const noSig = await postWebhook(hook.webhookToken, JSON.stringify(body), { 'x-saas-timestamp': String(Math.floor(Date.now() / 1000)) });
    assert.equal(noSig.json.code, 'WEBHOOK_SIGNATURE_MISSING');
    const fresh = signed(body);
    const textPlain = await postWebhook(hook.webhookToken, fresh.raw, { ...fresh.headers, 'content-type': 'text/plain' });
    assert.equal(textPlain.status, 415);
    assert.equal(textPlain.json.code, 'WEBHOOK_UNSUPPORTED_MEDIA_TYPE');
    const unknown = await postWebhook('x'.repeat(32), fresh.raw, fresh.headers);
    assert.equal(unknown.status, 401);
    const badToken = await postWebhook('not a token', fresh.raw, fresh.headers);
    assert.equal(badToken.status, 401);
  });
  assert.equal(precheckScrypt, 0, 'no scrypt key derivation for any pre-check failure');
  assert.equal(derivations(), start, 'the key cache loader never ran either');

  // Well-formed but wrong signatures need the key - derived once, then cached.
  const forgedScrypt = await countScrypt(async () => {
    for (let i = 0; i < 10; i += 1) {
      const forged = signed({ id: `forged_${i}` }, { secret: 'attacker-guess-secret-000000' });
      const res = await postWebhook(hook.webhookToken, forged.raw, forged.headers);
      assert.equal(res.status, 401);
      assert.equal(res.json.code, 'WEBHOOK_SIGNATURE_INVALID');
    }
  });
  assert.equal(derivations() - start, 1, 'ten forged deliveries cost a single derivation');
  assert.equal(forgedScrypt, 1, 'one real scrypt run for ten forged deliveries');
});

test('webhook: an oversize body is refused while it is read (413 WEBHOOK_PAYLOAD_TOO_LARGE), before any key derivation', async () => {
  const ws = await workspace();
  const hook = await webhookConnector(ws);
  const previous = env.connectors.webhook.maxBodyBytes;
  env.connectors.webhook.maxBodyBytes = 1024;
  try {
    const big = signed({ events: Array.from({ length: 100 }, (_, i) => ({ id: `big_${i}`, note: 'x'.repeat(20) })) });
    assert.ok(big.raw.length > 1024);
    const scrypt = await countScrypt(async () => {
      const res = await postWebhook(hook.webhookToken, big.raw, big.headers);
      assert.equal(res.status, 413);
      assert.equal(res.json.code, 'WEBHOOK_PAYLOAD_TOO_LARGE');
    });
    assert.equal(scrypt, 0);
    const small = signed({ id: 'small' });
    assert.equal((await postWebhook(hook.webhookToken, small.raw, small.headers)).status, 202);
  } finally {
    env.connectors.webhook.maxBodyBytes = previous;
  }
});

test('webhook: legacy transition - v2 connectors refuse body-only signatures; legacy connectors work (deprecated) and upgrade one-way', async () => {
  const ws = await workspace();
  const hook = await webhookConnector(ws);
  const raw = Buffer.from(JSON.stringify({ id: 'legacy_1' }));
  const legacyHeaders = { 'x-saas-signature': computeSignature(raw, SECRET) };

  const refused = await postWebhook(hook.webhookToken, raw, legacyHeaders);
  assert.equal(refused.status, 401);
  assert.equal(refused.json.code, 'WEBHOOK_LEGACY_SIGNATURE_REJECTED');

  // A connector created before v2 has no signature version.
  await Connector.updateOne({ _id: hook._id }, { $unset: { webhookSignatureVersion: 1 } });
  webhookKeyCache.clear();
  const accepted = await postWebhook(hook.webhookToken, raw, legacyHeaders);
  assert.equal(accepted.status, 202, JSON.stringify(accepted.json));
  assert.equal(accepted.headers.get('deprecation'), 'true');
  assert.equal(accepted.json.data.signatureVersion, 1);

  const previous = env.connectors.webhook.legacySignaturesEnabled;
  env.connectors.webhook.legacySignaturesEnabled = false;
  try {
    const raw2 = Buffer.from(JSON.stringify({ id: 'legacy_2' }));
    const off = await postWebhook(hook.webhookToken, raw2, { 'x-saas-signature': computeSignature(raw2, SECRET) });
    assert.equal(off.json.code, 'WEBHOOK_LEGACY_SIGNATURE_REJECTED', 'legacy can be switched off globally');
  } finally {
    env.connectors.webhook.legacySignaturesEnabled = previous;
  }

  // A legacy connector keeps its configured window (here 600 s, stored only
  // in the encrypted config) for v2 deliveries too - the window the UI shows.
  const custom = await webhookConnector(ws, { toleranceSeconds: 600 });
  await Connector.updateOne({ _id: custom._id }, { $unset: { webhookSignatureVersion: 1, webhookToleranceSeconds: 1 } });
  const now = Math.floor(Date.now() / 1000);
  const inWindow = signed({ id: 'custom_1' }, { timestamp: now - 450 });
  assert.equal((await postWebhook(custom.webhookToken, inWindow.raw, inWindow.headers)).status, 202);
  const outside = signed({ id: 'custom_2' }, { timestamp: now - 700 });
  const late = await postWebhook(custom.webhookToken, outside.raw, outside.headers);
  assert.equal(late.status, 401);
  assert.equal(late.json.code, 'WEBHOOK_TIMESTAMP_OUT_OF_WINDOW');

  const upgraded = await api(`/api/v1/connectors/${hook._id}`, { method: 'PATCH', headers: ws.auth, body: { webhookSignatureVersion: 2 } });
  assert.equal(upgraded.status, 200, JSON.stringify(upgraded.json));
  assert.equal(upgraded.json.data.webhookSignatureVersion, 2);
  const raw3 = Buffer.from(JSON.stringify({ id: 'legacy_3' }));
  const after = await postWebhook(hook.webhookToken, raw3, { 'x-saas-signature': computeSignature(raw3, SECRET) });
  assert.equal(after.json.code, 'WEBHOOK_LEGACY_SIGNATURE_REJECTED');
  const downgrade = await api(`/api/v1/connectors/${hook._id}`, { method: 'PATCH', headers: ws.auth, body: { webhookSignatureVersion: 1 } });
  assert.equal(downgrade.status, 400);
});

test('webhook: paused connector -> 409 CONNECTOR_PAUSED; too many records -> 413; body size and content checks', async () => {
  const ws = await workspace();
  const hook = await webhookConnector(ws);
  const previous = env.connectors.webhook.maxRecords;
  env.connectors.webhook.maxRecords = 3;
  try {
    const many = signed([{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }]);
    const res = await postWebhook(hook.webhookToken, many.raw, many.headers);
    assert.equal(res.status, 413);
    assert.equal(res.json.code, 'WEBHOOK_TOO_MANY_RECORDS');
    assert.equal(res.json.errors[0].maxRecords, 3, 'errors is a field-error array');
  } finally {
    env.connectors.webhook.maxRecords = previous;
  }

  const notJson = Buffer.from('{oops');
  const ts = Math.floor(Date.now() / 1000);
  const bad = await postWebhook(hook.webhookToken, notJson, {
    'x-saas-timestamp': String(ts), 'x-saas-signature': computeTimestampedSignature({ timestamp: ts, rawBody: notJson, secret: SECRET }),
  });
  assert.equal(bad.status, 422);

  await api(`/api/v1/connectors/${hook._id}`, { method: 'PATCH', headers: ws.auth, body: { status: 'paused' } });
  const ok = signed({ id: 'p1' });
  const paused = await postWebhook(hook.webhookToken, ok.raw, ok.headers);
  assert.equal(paused.status, 409);
  assert.equal(paused.json.code, 'CONNECTOR_PAUSED');
  await settle();
  assert.equal(captured.length, 0);
});

test('webhook ingest counts storedRows; the worker gives back rows that only updated existing ones', async () => {
  const ws = await workspace();
  const hook = await webhookConnector(ws);
  const before0 = await storedRows(ws.tenantId);

  const d1 = signed({ events: [{ id: 1 }, { id: 2 }, { id: 3 }] });
  assert.equal((await postWebhook(hook.webhookToken, d1.raw, d1.headers)).status, 202);
  assert.equal(await storedRows(ws.tenantId), before0 + 3, 'reserved at request time');
  await settle();
  await connectorService.processSyncMessage(captured.shift());
  assert.equal(await storedRows(ws.tenantId), before0 + 3);

  // Two of these already exist (identical records upsert in place).
  const d2 = signed({ events: [{ id: 1 }, { id: 2 }, { id: 4 }] });
  assert.equal((await postWebhook(hook.webhookToken, d2.raw, d2.headers)).status, 202);
  assert.equal(await storedRows(ws.tenantId), before0 + 6);
  await settle();
  const result = await connectorService.processSyncMessage(captured.shift());
  assert.equal(result.upserted, 1);
  assert.equal(await storedRows(ws.tenantId), before0 + 4, 'only the new row stays counted');

  // Over quota: refused with 409 and the claim is released so a retry is not a replay.
  await usageCounterRepository.incrementOrCreate({ tenantId: ws.tenantId, metric: 'storedRows', period: 'current', delta: 50_000_000, kind: 'current' });
  const d3 = signed({ id: 'over' });
  const over = await postWebhook(hook.webhookToken, d3.raw, d3.headers);
  assert.equal(over.status, 409, JSON.stringify(over.json));
  assert.equal(over.json.code, 'QUOTA_EXCEEDED');
  await usageCounterRepository.incrementOrCreate({ tenantId: ws.tenantId, metric: 'storedRows', period: 'current', delta: -50_000_000, kind: 'current' });
  const retry = await postWebhook(hook.webhookToken, d3.raw, d3.headers);
  assert.equal(retry.status, 202, 'retry after a quota refusal is not treated as a replay');
});

test('a webhook delivery reserves its rows in the usage ledger under its own job id; a refused enqueue gives them back', async () => {
  const ws = await workspace();
  const hook = await webhookConnector(ws);
  const base = await storedRows(ws.tenantId);
  const now = Math.floor(Date.now() / 1000);
  const a = signed({ events: [{ id: 'u1' }, { id: 'u2' }] }, { timestamp: now });
  const b = signed({ events: [{ id: 'u3' }] }, { timestamp: now - 1 });
  const statuses = await Promise.all([
    postWebhook(hook.webhookToken, a.raw, a.headers),
    postWebhook(hook.webhookToken, b.raw, b.headers),
  ]);
  assert.deepEqual(statuses.map((r) => r.status), [202, 202]);
  await settle();
  assert.equal(captured.length, 2);
  assert.notEqual(String(captured[0].id), String(captured[1].id), 'every delivery gets its own job id');
  for (const job of captured) {
    assert.equal(job.data.payload.reservationKey, String(job.id));
    const entry = await usageReservationRepository.findOne({ tenantId: ws.tenantId, metric: 'storedRows', key: String(job.id) });
    assert.equal(entry.remaining, job.data.payload.records.length);
    assert.equal(entry.connectorId, String(hook._id));
  }
  for (const job of captured.splice(0)) await connectorService.processSyncMessage(job);
  assert.equal(await storedRows(ws.tenantId), base + 3);

  const original = connectorQueue.enqueue;
  connectorQueue.enqueue = async () => {
    throw Object.assign(new Error('queue down'), { statusCode: 503, code: 'QUEUE_UNAVAILABLE' });
  };
  try {
    const c = signed({ events: [{ id: 'u4' }, { id: 'u5' }] });
    const refused = await postWebhook(hook.webhookToken, c.raw, c.headers);
    assert.notEqual(refused.status, 202);
  } finally {
    connectorQueue.enqueue = original;
  }
  assert.equal(await storedRows(ws.tenantId), base + 3, 'the refused delivery holds nothing');
  const open = await UsageReservation.countDocuments({ tenantId: ws.tenantId, settledAt: null });
  assert.equal(open, 0, 'no reservation is left open');
});

/* ---------------------------- tenant not active --------------------------- */

test('suspended tenant: webhook ingest and manual syncs are refused at request time', async (t) => {
  const ws = await workspace();
  const hook = await webhookConnector(ws);
  const csv = await createConnector(ws, { type: 'csv', name: 'Orders', config: {} });
  const mongo = await createConnector(ws, {
    type: 'mongodb', name: 'Ext', config: { uri: 'mongodb://db.example.com:27017/app', database: 'app', collection: 'orders' },
  });

  // Status changed without the lifecycle cascade (sessions still valid).
  await Tenant.updateOne({ _id: ws.tenantId }, { $set: { status: 'suspended' } });

  // Connector layer: `authenticate` also re-checks the account and tenant
  // status (actorStatus, cached for AUTH_STATUS_CACHE_TTL_MS and dropped only
  // by audit events, which a raw updateOne does not fire). Stub it to answer
  // "still active", as an instance whose status cache has not yet seen the
  // change would, so these requests reach the connector service: its
  // request-time check alone must refuse ingestion with 403.
  const staleStatus = t.mock.method(actorStatus, 'assertActorActive', async () => ({ tenantId: ws.tenantId }));
  const sync = await upload(ws, csv._id, 'sync', Buffer.from('id\n1\n'), 'a.csv', 'text/csv');
  assert.equal(sync.status, 403, JSON.stringify(sync.json));
  assert.equal(sync.json.code, 'TENANT_NOT_ACTIVE');
  const pull = await api(`/api/v1/connectors/${mongo._id}/sync-mongodb`, { method: 'POST', headers: ws.auth, body: {} });
  assert.equal(pull.status, 403);
  assert.equal(pull.json.code, 'TENANT_NOT_ACTIVE');
  assert.equal(staleStatus.mock.callCount(), 2, 'both requests passed authenticate through the stub');
  staleStatus.mock.restore();

  // Authentication layer: with a fresh status lookup, `authenticate` refuses
  // first (401 TENANT_NOT_ACTIVE) before any connector code runs.
  actorStatus.clear();
  const syncAuth = await upload(ws, csv._id, 'sync', Buffer.from('id\n1\n'), 'a.csv', 'text/csv');
  assert.equal(syncAuth.status, 401, JSON.stringify(syncAuth.json));
  assert.equal(syncAuth.json.code, 'TENANT_NOT_ACTIVE');
  const pullAuth = await api(`/api/v1/connectors/${mongo._id}/sync-mongodb`, { method: 'POST', headers: ws.auth, body: {} });
  assert.equal(pullAuth.status, 401, JSON.stringify(pullAuth.json));
  assert.equal(pullAuth.json.code, 'TENANT_NOT_ACTIVE');

  const start = derivations();
  const delivery = signed({ id: 'suspended' });
  const res = await postWebhook(hook.webhookToken, delivery.raw, delivery.headers);
  assert.equal(res.status, 403);
  assert.equal(res.json.code, 'TENANT_NOT_ACTIVE');
  assert.equal(derivations(), start, 'refused before key derivation');

  // Lifecycle suspension (sessions revoked) refuses the webhook too.
  await Tenant.updateOne({ _id: ws.tenantId }, { $set: { status: 'active' } });
  await tenantLifecycle.suspend({ tenantId: ws.tenantId, reason: 'test', by: 'platform-admin' });
  const again = signed({ id: 'suspended-2' });
  assert.equal((await postWebhook(hook.webhookToken, again.raw, again.headers)).json.code, 'TENANT_NOT_ACTIVE');
  await assert.rejects(
    () => connectorService.syncFileUpload({ tenantId: ws.tenantId, connectorId: csv._id, buffer: Buffer.from('id\n1\n') }),
    (e) => e.code === 'TENANT_NOT_ACTIVE' && e.statusCode === 403,
  );
  await settle();
  assert.equal(captured.length, 0, 'nothing was queued');
});

test('worker skips jobs for an inactive tenant and releases their storedRows reservation', async () => {
  const ws = await workspace();
  const hook = await webhookConnector(ws);
  const base = await storedRows(ws.tenantId);
  const d = signed({ events: [{ id: 'w1' }, { id: 'w2' }] });
  assert.equal((await postWebhook(hook.webhookToken, d.raw, d.headers)).status, 202);
  await settle();
  assert.equal(await storedRows(ws.tenantId), base + 2);
  await Tenant.updateOne({ _id: ws.tenantId }, { $set: { status: 'suspended' } });
  const result = await connectorService.processSyncMessage(captured.shift());
  assert.equal(result.skippedReason, 'TENANT_NOT_ACTIVE');
  assert.equal(result.upserted, 0);
  assert.equal(await storedRows(ws.tenantId), base);
});

test('a failing tenant lookup is an error (retried), not an inactive workspace (skipped)', async () => {
  const ws = await workspace();
  const csv = await createConnector(ws, { type: 'csv', name: 'Orders', config: {} });
  const original = tenantRepository.findById;
  tenantRepository.findById = async () => {
    throw Object.assign(new Error('database unavailable'), { name: 'MongoNetworkError' });
  };
  try {
    await assert.rejects(
      () => connectorService.syncFileUpload({ tenantId: ws.tenantId, connectorId: csv._id, buffer: Buffer.from('id\n1\n') }),
      (e) => e.message === 'database unavailable',
    );
    const job = { data: { connectorId: csv._id, tenantId: ws.tenantId, jobType: 'ingest', payload: { buffer: Buffer.from('id\n1\n').toString('base64') } } };
    await assert.rejects(() => connectorService.processSyncMessage(job), (e) => e.message === 'database unavailable');
  } finally {
    tenantRepository.findById = original;
  }
  const doc = (await api(`/api/v1/connectors/${csv._id}`, { headers: ws.auth })).json.data;
  assert.notEqual(doc.lastError, 'Skipped: the workspace is not active.');
});

test('a tenant lookup failing on the last attempt closes the run, frees the slot and gives the reservation back', async () => {
  const ws = await workspace();
  const csv = await createConnector(ws, { type: 'csv', name: 'Orders', config: {} });
  const hook = await webhookConnector(ws);
  const accepted = await connectorService.syncFileUpload({ tenantId: ws.tenantId, connectorId: csv._id, buffer: Buffer.from('id\n1\n') });
  const d = signed({ events: [{ id: 'l1' }, { id: 'l2' }] });
  assert.equal((await postWebhook(hook.webhookToken, d.raw, d.headers)).status, 202);
  await settle();
  const fileJob = captured.find((j) => j.data.syncRunId === accepted.syncRunId);
  const hookJob = captured.find((j) => Array.isArray(j.data.payload?.records));
  assert.ok(fileJob && hookJob);
  const base = await storedRows(ws.tenantId);

  const original = tenantRepository.findById;
  tenantRepository.findById = async () => {
    throw Object.assign(new Error('database unavailable'), { name: 'MongoNetworkError' });
  };
  try {
    // Attempts left: the error propagates for the queue to retry; nothing is closed.
    await assert.rejects(
      () => connectorService.processSyncMessage({ ...fileJob, attemptsMade: 0, attempts: 3 }),
      (e) => e.message === 'database unavailable',
    );
    assert.equal((await SyncRun.findById(accepted.syncRunId).lean()).status, 'queued');
    assert.equal((await Connector.findById(csv._id).lean()).syncStatus, 'queued');

    // Last attempt: nothing will retry, so the run and the slot are closed now.
    await assert.rejects(
      () => connectorService.processSyncMessage({ ...fileJob, attemptsMade: 2, attempts: 3 }),
      (e) => e.message === 'database unavailable',
    );
    await assert.rejects(
      () => connectorService.processSyncMessage({ ...hookJob, attemptsMade: 2, attempts: 3 }),
      (e) => e.message === 'database unavailable',
    );
  } finally {
    tenantRepository.findById = original;
  }
  const run = await SyncRun.findById(accepted.syncRunId).lean();
  assert.equal(run.status, 'failed');
  assert.equal(run.error.code, 'CONNECTOR_SYNC_FAILED');
  assert.doesNotMatch(run.error.message, /database unavailable/);
  const slot = await Connector.findById(csv._id).lean();
  assert.equal(slot.syncStatus, 'failed');
  assert.equal(slot.currentSyncRunId, null);
  assert.equal(slot.syncLeaseUntil, null);
  const hookRun = await SyncRun.findOne({ tenantId: ws.tenantId, connectorId: String(hook._id) }).lean();
  assert.equal(hookRun.status, 'failed');
  assert.equal(await storedRows(ws.tenantId), base - 2, 'the webhook reservation was given back');
});

test('a webhook delivery whose run the reaper abandoned is replayed on redelivery: rows stored, reservation settled', async () => {
  const ws = await workspace();
  const hook = await webhookConnector(ws);
  const connectorId = String(hook._id);
  const base = await storedRows(ws.tenantId);

  const d1 = signed({ events: [{ id: 'r1' }] });
  assert.equal((await postWebhook(hook.webhookToken, d1.raw, d1.headers)).status, 202);
  await settle();
  await connectorService.processSyncMessage(captured.shift());
  assert.equal(await storedRows(ws.tenantId), base + 1);

  // r1 exists already, r2 is new: 2 rows reserved at request time.
  const d2 = signed({ events: [{ id: 'r1' }, { id: 'r2' }] });
  assert.equal((await postWebhook(hook.webhookToken, d2.raw, d2.headers)).status, 202);
  await settle();
  const job = captured.shift();
  assert.ok(job?.id, 'the delivery has a queue job id');
  assert.equal(await storedRows(ws.tenantId), base + 3);

  // A worker picked it up and died: its run and the connector lease expire,
  // and the reaper abandons the run (nothing stored, nothing settled).
  const expired = new Date(Date.now() - 60_000);
  const dead = await SyncRun.create({
    tenantId: ws.tenantId, connectorId, trigger: 'webhook', jobType: 'ingest', status: 'running',
    jobId: String(job.id), attempts: 1, startedAt: new Date(Date.now() - 20 * 60_000), leaseUntil: expired,
  });
  await Connector.updateOne({ _id: connectorId }, { $set: { syncStatus: 'running', syncLeaseUntil: expired, currentSyncRunId: null } });
  assert.equal((await recoverStaleConnectors()).recovered, 1);
  assert.equal((await SyncRun.findById(dead._id).lean()).status, 'abandoned');

  // The durable queue redelivers the message: replayed under a fresh run.
  const result = await connectorService.processSyncMessage(job);
  assert.equal(result.upserted, 1);
  assert.equal(result.matched, 1);
  assert.equal((await connectorService.listConnectorRows({ tenantId: ws.tenantId, connectorId })).total, 2);
  assert.equal(await storedRows(ws.tenantId), base + 2, 'only the new row stays counted');
  const runs = await SyncRun.find({ tenantId: ws.tenantId, connectorId, jobId: String(job.id) }).sort({ createdAt: 1 }).lean();
  assert.deepEqual(runs.map((r) => r.status), ['abandoned', 'succeeded']);
  assert.equal((await Connector.findById(connectorId).lean()).syncStatus, 'succeeded');

  // A further redelivery finds the finished replay: a no-op that settles nothing.
  const again = await connectorService.processSyncMessage(job);
  assert.equal(again.reason, 'run_closed');
  assert.equal(await storedRows(ws.tenantId), base + 2);
});

test('a webhook run abandoned between lookup and start is replayed under a fresh run', async () => {
  const ws = await workspace();
  const hook = await webhookConnector(ws);
  const connectorId = String(hook._id);
  const base = await storedRows(ws.tenantId);
  const d = signed({ events: [{ id: 's1' }, { id: 's2' }] });
  assert.equal((await postWebhook(hook.webhookToken, d.raw, d.headers)).status, 202);
  await settle();
  const job = captured.shift();

  // A slot takeover closes the run just before the worker starts it.
  const original = syncRunRepository.markRunning;
  let calls = 0;
  syncRunRepository.markRunning = async (id, options) => {
    calls += 1;
    if (calls === 1) {
      await syncRunRepository.finish(id, { status: 'abandoned', error: { code: 'LEASE_EXPIRED', message: 'taken over' } });
    }
    return original(id, options);
  };
  let result;
  try {
    result = await connectorService.processSyncMessage(job);
  } finally {
    syncRunRepository.markRunning = original;
  }
  assert.equal(calls, 2);
  assert.equal(result.upserted, 2);
  assert.equal(await storedRows(ws.tenantId), base + 2, 'the reservation became the stored rows');
  const runs = await SyncRun.find({ tenantId: ws.tenantId, connectorId }).sort({ createdAt: 1 }).lean();
  assert.deepEqual(runs.map((r) => r.status), ['abandoned', 'succeeded']);
});

/* ------------------------------ generic errors ---------------------------- */

test('connector errors never echo hosts or credentials (create, worker egress block, driver failure)', async () => {
  const ws = await workspace();
  const leaks = ['10.1.2.3', '127.0.0.1', 'hunter2', 'admin', 'ECONNREFUSED'];
  const assertClean = (text) => {
    for (const leak of leaks) assert.equal(String(text ?? '').includes(leak), false, `leaked ${leak}: ${text}`);
  };
  const previous = {
    allow: env.connectors.allowPrivateNetworks,
    connect: env.connectors.mongodb.connectTimeoutMs,
    selection: env.connectors.mongodb.serverSelectionTimeoutMs,
  };
  try {
    env.connectors.allowPrivateNetworks = false;
    const refused = await api('/api/v1/connectors', {
      method: 'POST', headers: ws.auth,
      body: { type: 'mongodb', name: 'Internal', config: { uri: 'mongodb://admin:hunter2@10.1.2.3:27017/app', database: 'app', collection: 'x' } },
    });
    assert.equal(refused.status, 400);
    assertClean(JSON.stringify(refused.json));

    const optionRefused = await api('/api/v1/connectors', {
      method: 'POST', headers: ws.auth,
      body: { type: 'mongodb', name: 'Proxy', config: { uri: 'mongodb://u:hunter2@db.example.com/app?proxyHost=evil.example.com', database: 'app', collection: 'x' } },
    });
    assert.equal(optionRefused.status, 400);
    assert.match(JSON.stringify(optionRefused.json), /proxyHost/);
    assertClean(JSON.stringify(optionRefused.json));

    // A connector stored while private networks were allowed is blocked at
    // sync time by the worker's egress check, with a generic message.
    env.connectors.allowPrivateNetworks = true;
    const internal = await createConnector(ws, {
      type: 'mongodb', name: 'Was allowed', config: { uri: 'mongodb://admin:hunter2@127.0.0.1:1/app', database: 'app', collection: 'x' },
    });
    env.connectors.allowPrivateNetworks = false;
    const job = { data: { connectorId: internal._id, tenantId: ws.tenantId, jobType: 'ingest', payload: {} } };
    // A policy refusal is deterministic: recorded once, returned (not thrown) so the queue does not retry it.
    const refusedSync = await connectorService.processSyncMessage(job);
    assert.equal(refusedSync.failed?.code, 'CONNECTOR_EGRESS_BLOCKED');
    assertClean(refusedSync.failed.message);
    const blocked = await api(`/api/v1/connectors/${internal._id}`, { headers: ws.auth });
    assert.equal(blocked.json.data.syncStatus, 'failed');
    assert.ok(blocked.json.data.lastError);
    assertClean(blocked.json.data.lastError);

    // Driver failure (closed local port): the raw driver message is never stored.
    env.connectors.allowPrivateNetworks = true;
    env.connectors.mongodb.connectTimeoutMs = 300;
    env.connectors.mongodb.serverSelectionTimeoutMs = 300;
    await assert.rejects(() => connectorService.processSyncMessage(job), (e) => e.code === 'CONNECTOR_SOURCE_UNAVAILABLE');
    const failed = await api(`/api/v1/connectors/${internal._id}`, { headers: ws.auth });
    assert.match(failed.json.data.lastError, /Could not (connect to|read from) the MongoDB source|MongoDB host is unreachable|Timed out connecting to MongoDB/);
    assertClean(failed.json.data.lastError);
  } finally {
    env.connectors.allowPrivateNetworks = previous.allow;
    env.connectors.mongodb.connectTimeoutMs = previous.connect;
    env.connectors.mongodb.serverSelectionTimeoutMs = previous.selection;
  }
});

/* ------------------------------ delete cascade ---------------------------- */

test('deleting a connector marks dependants broken, stops their schedules and clears the tenant\'s analytics cache (tenant-isolated)', async () => {
  const ws = await workspace();
  const other = await workspace();
  const doomed = await createConnector(ws, { type: 'csv', name: 'Doomed', config: {} });
  const kept = await createConnector(ws, { type: 'csv', name: 'Kept', config: {} });
  for (const c of [doomed, kept]) {
    await connectorService.processSyncMessage({
      data: { connectorId: c._id, tenantId: ws.tenantId, jobType: 'ingest', payload: { buffer: Buffer.from('id,amount\n1,10\n2,20\n').toString('base64') } },
    });
  }

  const dash = (await api('/api/v1/dashboards', { method: 'POST', headers: ws.auth, body: { name: 'Ops' } })).json.data;
  const widget = async (name, datasetId) => {
    const res = await api(`/api/v1/dashboards/${dash._id}/widgets`, {
      method: 'POST', headers: ws.auth,
      body: { name, type: 'kpi', datasetId, query: { metrics: [{ alias: 'n', op: 'count', field: 'amount' }] } },
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    return res.json.data;
  };
  const w1 = await widget('Doomed KPI', doomed._id);
  const w2 = await widget('Kept KPI', kept._id);

  const report = async (body) => {
    const res = await api('/api/v1/reports', { method: 'POST', headers: ws.auth, body: { format: 'csv', ...body } });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    return res.json.data;
  };
  const r1 = await report({ name: 'Q doomed', source: 'query', query: { datasetId: doomed._id }, schedule: { enabled: true, cron: '0 * * * *' } });
  const r2 = await report({ name: 'W doomed', source: 'widget', dashboardId: dash._id, widgetId: w1._id, schedule: { enabled: true, cron: '0 * * * *' } });
  const r3 = await report({ name: 'Q kept', source: 'query', query: { datasetId: kept._id }, schedule: { enabled: true, cron: '0 * * * *' } });

  const alert = async (body) => {
    const res = await api('/api/v1/alerts', {
      method: 'POST', headers: ws.auth,
      body: { metric: 'count', condition: 'gt', threshold: 1, notification: { channels: ['in_app'] }, enabled: true, ...body },
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    return res.json.data;
  };
  const a1 = await alert({ name: 'Q doomed', source: 'query', query: { datasetId: doomed._id } });
  // The widget's query outputs `n` (roadmap 1.5: the metric must be one of its outputs).
  const a2 = await alert({ name: 'W doomed', source: 'widget', dashboardId: dash._id, widgetId: w1._id, metric: 'n' });
  const a3 = await alert({ name: 'Q kept', source: 'query', query: { datasetId: kept._id } });

  // Another tenant's documents that happen to carry the same id are untouched.
  const foreign = await Report.create({ tenantId: other.tenantId, name: 'Foreign', source: 'query', query: { datasetId: doomed._id }, schedule: { enabled: true } });

  // Warm the caches: dashboard widgets + a tenant-wide analytics query, and
  // an entry of the other tenant.
  const view = await api(`/api/v1/dashboards/${dash._id}/execute`, { headers: ws.auth });
  assert.equal(view.status, 200, JSON.stringify(view.json));
  // The real key also carries the prepared query and the dataset versions,
  // so take it from the response rather than rebuilding it.
  const tenantWideKey = (await analyticsService.query({ tenantId: ws.tenantId })).cacheKey;
  assert.ok(tenantWideKey.startsWith(buildCacheKey({ tenantId: ws.tenantId }).split(':').slice(0, -1).join(':')));
  assert.notEqual(await cacheService.get(tenantWideKey), null, 'cache warmed');
  const otherKey = buildCacheKey({ tenantId: other.tenantId });
  await cacheService.set(otherKey, { rows: [] }, 300);

  const removed = await api(`/api/v1/connectors/${doomed._id}`, { method: 'DELETE', headers: ws.auth });
  assert.equal(removed.status, 204);

  // Widgets
  const widgets = (await api(`/api/v1/dashboards/${dash._id}/widgets`, { headers: ws.auth })).json.data;
  const byId = Object.fromEntries(widgets.map((w) => [w._id, w]));
  assert.ok(byId[w1._id].brokenAt, 'widget on the deleted dataset is broken');
  assert.equal(byId[w1._id].brokenReason, 'CONNECTOR_DELETED');
  assert.equal(byId[w2._id].brokenAt, null);

  // Reports: broken + schedule stopped; the unrelated one untouched.
  const rep = async (id) => (await api(`/api/v1/reports/${id}`, { headers: ws.auth })).json.data;
  for (const r of [r1, r2]) {
    const doc = await rep(r._id);
    assert.equal(doc.brokenReason, 'CONNECTOR_DELETED', r.name);
    assert.equal(doc.schedule.enabled, false, r.name);
    assert.equal(doc.nextRunAt, null, r.name);
  }
  assert.equal((await rep(r2._id)).brokenRef, `widget:${w1._id}`);
  const r3doc = await rep(r3._id);
  assert.equal(r3doc.brokenAt, null);
  assert.equal(r3doc.schedule.enabled, true);

  // Alerts: broken + disabled.
  const al = async (id) => (await api(`/api/v1/alerts/${id}`, { headers: ws.auth })).json.data;
  for (const a of [a1, a2]) {
    const doc = await al(a._id);
    assert.equal(doc.brokenReason, 'CONNECTOR_DELETED', a.name);
    assert.equal(doc.enabled, false, a.name);
  }
  assert.equal((await al(a3._id)).enabled, true);

  // Isolation.
  const foreignAfter = await Report.findById(foreign._id).lean();
  assert.equal(foreignAfter.brokenAt, null);
  assert.equal(foreignAfter.schedule.enabled, true);

  // Cache: the tenant's entries are gone, the other tenant's remain.
  assert.equal(await cacheService.get(tenantWideKey), null);
  assert.deepEqual(await cacheService.get(otherKey), { rows: [] });

  // The dashboard keeps rendering: the broken widget reports an error entry.
  const after = await api(`/api/v1/dashboards/${dash._id}/execute`, { headers: ws.auth });
  assert.equal(after.status, 200);
  const entry = after.json.data.find((w) => w.widgetId === w1._id);
  assert.equal(entry.status, 'error');

  // Repair: pointing the widget at another dataset clears the marker, and
  // the widget-sourced report / alert that broke through it.
  const repaired = await api(`/api/v1/dashboards/${dash._id}/widgets/${w1._id}`, { method: 'PATCH', headers: ws.auth, body: { datasetId: kept._id } });
  assert.equal(repaired.status, 200, JSON.stringify(repaired.json));
  assert.equal(repaired.json.data.brokenAt, null);
  assert.equal((await Widget.findById(w1._id).lean()).brokenAt, null);
  assert.equal((await rep(r2._id)).brokenAt, null);
  const a2doc = await al(a2._id);
  assert.equal(a2doc.brokenAt, null);
  assert.equal(a2doc.enabled, false, 'schedules stay off until the user re-enables them');
  assert.ok((await rep(r1._id)).brokenAt, 'the query-sourced report still points at the deleted dataset');

  // A broken alert / report schedule cannot be switched back on while it
  // still points at the deleted dataset (it would fail on every tick).
  const reEnable = await api(`/api/v1/alerts/${a1._id}`, { method: 'PATCH', headers: ws.auth, body: { enabled: true } });
  assert.equal(reEnable.status, 409, JSON.stringify(reEnable.json));
  assert.equal(reEnable.json.code, 'DEPENDENCY_BROKEN');
  const samePointer = await api(`/api/v1/alerts/${a1._id}`, {
    method: 'PATCH', headers: ws.auth, body: { enabled: true, query: { datasetId: doomed._id } },
  });
  assert.equal(samePointer.status, 409, 'resending the deleted dataset does not count as a fix');
  assert.equal((await AlertRule.findById(a1._id).lean()).enabled, false);
  const reSchedule = await api(`/api/v1/reports/${r1._id}`, {
    method: 'PATCH', headers: ws.auth, body: { schedule: { enabled: true, cron: '0 * * * *' } },
  });
  assert.equal(reSchedule.status, 409, JSON.stringify(reSchedule.json));
  assert.equal(reSchedule.json.code, 'DEPENDENCY_BROKEN');
  assert.equal((await rep(r1._id)).schedule.enabled, false);
  // Repaired through its widget: the widget-sourced alert may be enabled again.
  const a2On = await api(`/api/v1/alerts/${a2._id}`, { method: 'PATCH', headers: ws.auth, body: { enabled: true } });
  assert.equal(a2On.status, 200, JSON.stringify(a2On.json));
  assert.equal(a2On.json.data.enabled, true);

  // Editing a query-sourced alert to another dataset repairs it, and it can
  // be enabled in the same request.
  const fixed = await api(`/api/v1/alerts/${a1._id}`, {
    method: 'PATCH', headers: ws.auth, body: { query: { datasetId: kept._id }, enabled: true },
  });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.json));
  const a1doc = await AlertRule.findById(a1._id).lean();
  assert.equal(a1doc.brokenAt, null);
  assert.equal(a1doc.enabled, true);
});

test('deleting a connector of another tenant is a 404 and cascades nothing', async () => {
  const ws = await workspace();
  const other = await workspace();
  const c = await createConnector(ws, { type: 'csv', name: 'Mine', config: {} });
  await AlertRule.create({ tenantId: ws.tenantId, name: 'Mine', source: 'query', query: { datasetId: c._id }, condition: 'gt', threshold: 1 });
  const res = await api(`/api/v1/connectors/${c._id}`, { method: 'DELETE', headers: other.auth });
  assert.equal(res.status, 404);
  const alertDoc = await AlertRule.findOne({ tenantId: ws.tenantId }).lean();
  assert.equal(alertDoc.brokenAt, null);
  assert.equal(alertDoc.enabled, true);
  assert.equal(await mongoose.model('Connector').countDocuments({ _id: c._id, deletedAt: null }), 1);
});
