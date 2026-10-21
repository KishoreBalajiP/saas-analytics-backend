/**
 * Request signals for the security detection rules (roadmap 2.6): what the
 * global middleware counts, that no credential is ever stored, bounded
 * buffering, and the end-to-end path from a refused HTTP request to a
 * "revoked API key still in use" alert.
 */

import test, { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import { observe } from '../../src/middleware/securitySignals.middleware.js';
import { record, flush, resetSignals, getSignalStats, bucketOf } from '../../src/services/securityDetection/signals.js';
import { runDetection } from '../../src/services/securityDetection/engine.js';
import { getRule } from '../../src/services/securityDetection/rules/index.js';
import { SecuritySignal } from '../../src/models/SecuritySignal.js';
import { SecurityAlert } from '../../src/models/SecurityAlert.js';
import { Connector } from '../../src/models/Connector.js';
import { ApiKey } from '../../src/models/ApiKey.js';

function fakeReq({ path = '/api/v1/dashboards', ip = '203.0.113.7', headers = {}, user, admin, apiKey } = {}) {
  return { originalUrl: path, ip, headers, user, admin, apiKey };
}

async function rows() {
  await flush();
  return SecuritySignal.find({}).sort({ kind: 1, subject: 1 }).lean();
}

/** Wait until `fn()` is truthy (async webhook-token lookups). */
async function until(fn, { timeoutMs = 2000 } = {}) {
  const started = Date.now();
  while (!(await fn())) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

before(async () => { await startMongo(); await startHttp(); });
after(async () => { await stopHttp(); await stopMongo(); });
beforeEach(async () => {
  await flush();
  resetSignals();
  await resetMongo();
});

describe('signals middleware', () => {
  test('counts API-key calls per key with errors and client range, and tenant volume', async () => {
    const keyId = new mongoose.Types.ObjectId().toString();
    for (const status of [200, 200, 404, 503]) {
      observe(fakeReq({ path: '/api/v1/external/datasets', apiKey: { keyId, tenantId: 't1' } }), { statusCode: status });
    }
    const all = await rows();
    const key = all.find((r) => r.kind === 'api_key.request');
    assert.equal(key.subject, keyId);
    assert.equal(key.tenantId, 't1');
    assert.equal(key.count, 4);
    assert.equal(key.clientErrors, 1);
    assert.equal(key.serverErrors, 1);
    assert.deepEqual(key.ipRanges, ['203.0.113.0/24']);
    assert.deepEqual(key.bucket, bucketOf(new Date()));
    assert.ok(key.expiresAt > new Date(), 'signals expire (TTL)');
    const volume = all.find((r) => r.kind === 'tenant.request');
    assert.equal(volume.subject, 't1');
    assert.equal(volume.count, 4);
  });

  test('a refused API-key call keeps only the public prefix, never the secret', async () => {
    const secret = 'Zx9secretPart0123456789abcdef';
    observe(fakeReq({ path: '/api/v1/external/datasets', headers: { 'x-api-key': `sak_ab12cd34.${secret}` } }), { statusCode: 401 });
    observe(fakeReq({ headers: { 'x-api-key': '<script>.x' } }), { statusCode: 401 });
    observe(fakeReq({ headers: { 'x-api-key': `sak_ab12cd34.${secret}` } }), { statusCode: 200 });
    const all = await rows();
    assert.deepEqual(all.map((r) => [r.kind, r.subject, r.count]), [['api_key.auth_failed', 'sak_ab12cd34', 1]]);
    const raw = JSON.stringify(await mongoose.connection.db.collection('securitysignals').find({}).toArray());
    assert.ok(!raw.includes(secret), 'the key secret is never stored');
    assert.ok(!raw.includes('203.0.113.7'), 'full client addresses are never stored');
  });

  test('429s count per tenant when the caller is known, otherwise per client range', async () => {
    observe(fakeReq({ ip: '198.51.100.20' }), { statusCode: 429 });
    observe(fakeReq({ ip: '198.51.100.21' }), { statusCode: 429 });
    observe(fakeReq({ user: { id: 'u1', tenantId: 't9' } }), { statusCode: 429 });
    observe(fakeReq({ admin: { id: 'a1', tenantId: null } }), { statusCode: 200 });
    const all = await rows();
    const hits = all.filter((r) => r.kind === 'rate_limit.hit').map((r) => [r.subject, r.count]);
    assert.deepEqual(hits, [['ip:198.51.100.0/24', 2], ['tenant:t9', 1]]);
    // Admin traffic is not tenant volume.
    assert.deepEqual(all.filter((r) => r.kind === 'tenant.request').map((r) => r.subject), ['t9']);
  });

  test('refused webhook deliveries are attributed to the connector without storing the token', async () => {
    const token = 'whk_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123';
    const connector = await Connector.collection.insertOne({
      tenantId: 't1', type: 'webhook', name: 'Orders', webhookToken: token, status: 'active', deletedAt: null,
    });
    observe(fakeReq({ path: `/api/v1/webhooks/${token}` }), { statusCode: 401 });
    observe(fakeReq({ path: '/api/v1/webhooks/wrong-format' }), { statusCode: 401 });
    observe(fakeReq({ path: '/api/v1/webhooks/whk_unknownunknownunknownunknown01' }), { statusCode: 401 });
    observe(fakeReq({ path: `/api/v1/webhooks/${token}` }), { statusCode: 202 });
    await until(() => getSignalStats().recorded >= 3);
    const all = await rows();
    const failed = all.find((r) => r.kind === 'connector.auth_failed');
    assert.equal(failed.subject, String(connector.insertedId));
    assert.equal(failed.tenantId, 't1');
    assert.equal(failed.count, 1);
    const unknown = all.find((r) => r.kind === 'webhook.unknown_token');
    assert.equal(unknown.subject, 'ip:203.0.113.0/24');
    assert.equal(unknown.count, 2);
    const raw = JSON.stringify(await mongoose.connection.db.collection('securitysignals').find({}).toArray());
    assert.ok(!raw.includes(token), 'webhook tokens are never stored');
  });

  test('the buffer is bounded and invalid signals are refused', async () => {
    assert.equal(record({ kind: 'not.a.kind', subject: 'x' }), false);
    assert.equal(record({ kind: 'tenant.request', subject: 'has spaces' }), false);
    for (let i = 0; i < 10000; i += 1) record({ kind: 'tenant.request', subject: `t${i}` });
    assert.equal(record({ kind: 'tenant.request', subject: 'one-too-many' }), false);
    const stats = getSignalStats();
    assert.equal(stats.buffered, 10000);
    assert.equal(stats.dropped, 1);
    resetSignals();
  });
});

describe('end to end', () => {
  test('a revoked API key presented over HTTP raises a revoked-use alert', async () => {
    await ApiKey.collection.insertOne({
      prefix: 'sak_e2e00001', name: 'Old integration', tenantId: 't1', status: 'revoked',
      revokedAt: new Date(Date.now() - 60 * 60 * 1000), deletedAt: null, secretHash: 'x', scopes: [],
    });
    const res = await api('/api/v1/external/datasets', { headers: { 'x-api-key': 'sak_e2e00001.notTheRealSecret000000' } });
    assert.equal(res.status, 401);
    const webhook = await api('/api/v1/webhooks/whk_nobodyhomenobodyhomenobody01', {
      method: 'POST', body: { id: 1 },
    });
    assert.equal(webhook.status, 401);
    await until(async () => (await rows()).length >= 2);
    const kinds = (await SecuritySignal.find({}).lean()).map((r) => r.kind).sort();
    assert.deepEqual(kinds, ['api_key.auth_failed', 'webhook.unknown_token']);

    const summary = await runDetection({
      rules: [getRule('api_key.revoked_use')],
      now: new Date(Date.now() + 4 * 60 * 1000),
      settingOverrides: {},
      notify: false,
    });
    assert.equal(summary.raised, 1);
    const [alert] = await SecurityAlert.find({}).lean();
    assert.equal(alert.subject.display, 'Old integration (sak_e2e00001)');
    assert.equal(alert.tenantId, 't1');
  });
});
