/**
 * Unit tests for timestamp-bound webhook signing (roadmap 1.8):
 * `${timestamp}.${body}` HMAC, required timestamp window, secret-free
 * pre-checks, and the per-connector key cache.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeTimestampedSignature,
  computeSignature,
  precheckWebhookHeaders,
  verifyPrechecked,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  SIGNATURE_VERSIONS,
} from '../../../../src/modules/connectors/webhook/webhook.verify.js';
import webhookKeyCache from '../../../../src/modules/connectors/webhook/webhook.keyCache.js';
import { WebhookSignatureError } from '../../../../src/modules/connectors/shared/errors.js';

const SECRET = 'a-very-long-signing-secret-0001';
const body = Buffer.from(JSON.stringify({ event: 'order.created', id: 1 }));
const now = () => Math.floor(Date.now() / 1000);

function headersFor({ timestamp = now(), signature } = {}) {
  return {
    [TIMESTAMP_HEADER]: String(timestamp),
    [SIGNATURE_HEADER]: signature ?? computeTimestampedSignature({ timestamp, rawBody: body, secret: SECRET }),
  };
}

function expectCode(fn, code) {
  assert.throws(fn, (err) => err instanceof WebhookSignatureError && err.code === code && err.statusCode === 401);
}

test('v2 signature covers timestamp + body and verifies', () => {
  const headers = headersFor();
  assert.match(headers[SIGNATURE_HEADER], /^v2=[0-9a-f]{64}$/);
  const pre = precheckWebhookHeaders({ headers, connectorVersion: 2 });
  assert.equal(pre.version, SIGNATURE_VERSIONS.TIMESTAMPED);
  const sig = verifyPrechecked({ precheck: pre, rawBody: body, secret: SECRET });
  assert.equal(`v2=${sig}`, headers[SIGNATURE_HEADER]);
});

test('changing the timestamp (fresh replay of a captured body) invalidates the signature', () => {
  const ts = now() - 30;
  const captured = headersFor({ timestamp: ts });
  const replay = { ...captured, [TIMESTAMP_HEADER]: String(now()) };
  const pre = precheckWebhookHeaders({ headers: replay, connectorVersion: 2 });
  expectCode(() => verifyPrechecked({ precheck: pre, rawBody: body, secret: SECRET }), 'WEBHOOK_SIGNATURE_INVALID');
});

test('changing the body invalidates the signature', () => {
  const pre = precheckWebhookHeaders({ headers: headersFor(), connectorVersion: 2 });
  expectCode(() => verifyPrechecked({ precheck: pre, rawBody: Buffer.from('{"event":"x"}'), secret: SECRET }), 'WEBHOOK_SIGNATURE_INVALID');
});

test('missing, malformed, stale and future timestamps are rejected before any secret is used', () => {
  const sig = computeTimestampedSignature({ timestamp: now(), rawBody: body, secret: SECRET });
  expectCode(() => precheckWebhookHeaders({ headers: { [SIGNATURE_HEADER]: sig }, connectorVersion: 2 }), 'WEBHOOK_TIMESTAMP_MISSING');
  expectCode(() => precheckWebhookHeaders({ headers: { ...headersFor(), [TIMESTAMP_HEADER]: 'yesterday' }, connectorVersion: 2 }), 'WEBHOOK_TIMESTAMP_INVALID');
  expectCode(() => precheckWebhookHeaders({ headers: { ...headersFor(), [TIMESTAMP_HEADER]: String(Date.now()) }, connectorVersion: 2 }), 'WEBHOOK_TIMESTAMP_INVALID');
  expectCode(() => precheckWebhookHeaders({ headers: headersFor({ timestamp: now() - 301 }), connectorVersion: 2, toleranceSeconds: 300 }), 'WEBHOOK_TIMESTAMP_OUT_OF_WINDOW');
  expectCode(() => precheckWebhookHeaders({ headers: headersFor({ timestamp: now() + 3600 }), connectorVersion: 2 }), 'WEBHOOK_TIMESTAMP_OUT_OF_WINDOW');
  // Inside a custom window.
  assert.doesNotThrow(() => precheckWebhookHeaders({ headers: headersFor({ timestamp: now() - 500 }), connectorVersion: 2, toleranceSeconds: 600 }));
});

test('signature header format is checked before the secret: missing / malformed / unknown scheme', () => {
  const ts = { [TIMESTAMP_HEADER]: String(now()) };
  expectCode(() => precheckWebhookHeaders({ headers: ts, connectorVersion: 2 }), 'WEBHOOK_SIGNATURE_MISSING');
  expectCode(() => precheckWebhookHeaders({ headers: { ...ts, [SIGNATURE_HEADER]: 'v2=deadbeef' }, connectorVersion: 2 }), 'WEBHOOK_SIGNATURE_MALFORMED');
  expectCode(() => precheckWebhookHeaders({ headers: { ...ts, [SIGNATURE_HEADER]: `md5=${'a'.repeat(64)}` }, connectorVersion: 2 }), 'WEBHOOK_SIGNATURE_MALFORMED');
  expectCode(() => precheckWebhookHeaders({ headers: { ...ts, [SIGNATURE_HEADER]: 'x'.repeat(2000) }, connectorVersion: 2 }), 'WEBHOOK_SIGNATURE_MALFORMED');
});

test('legacy body-only signatures: refused on v2 connectors and when disabled; accepted on v1 connectors', () => {
  const legacy = { [SIGNATURE_HEADER]: computeSignature(body, SECRET) };
  expectCode(() => precheckWebhookHeaders({ headers: legacy, connectorVersion: 2 }), 'WEBHOOK_LEGACY_SIGNATURE_REJECTED');
  expectCode(() => precheckWebhookHeaders({ headers: legacy, connectorVersion: 1, legacyEnabled: false }), 'WEBHOOK_LEGACY_SIGNATURE_REJECTED');
  const pre = precheckWebhookHeaders({ headers: legacy, connectorVersion: 1, legacyEnabled: true });
  assert.equal(pre.version, SIGNATURE_VERSIONS.LEGACY);
  assert.equal(pre.timestamp, null);
  assert.doesNotThrow(() => verifyPrechecked({ precheck: pre, rawBody: body, secret: SECRET }));
});

test('a v1 connector also accepts v2 signatures (senders can migrate first)', () => {
  const pre = precheckWebhookHeaders({ headers: headersFor(), connectorVersion: 1, legacyEnabled: false });
  assert.equal(pre.version, SIGNATURE_VERSIONS.TIMESTAMPED);
  assert.doesNotThrow(() => verifyPrechecked({ precheck: pre, rawBody: body, secret: SECRET }));
});

test('key cache: one derivation per connector per TTL; config change or invalidate re-derives; concurrent misses share one load', async () => {
  webhookKeyCache.clear();
  let loads = 0;
  const load = async () => {
    loads += 1;
    await new Promise((r) => setTimeout(r, 5));
    return { signingSecret: SECRET };
  };
  const connector = { _id: 'c1', config: 'enc:v1:aaa' };
  const before = webhookKeyCache.stats().derivations;

  const results = await Promise.all([1, 2, 3, 4].map(() => webhookKeyCache.getWebhookConfig(connector, load)));
  assert.equal(loads, 1, 'concurrent misses share one derivation');
  assert.ok(results.every((r) => r.signingSecret === SECRET));
  for (let i = 0; i < 50; i += 1) await webhookKeyCache.getWebhookConfig(connector, load);
  assert.equal(loads, 1, 'cached for the TTL');
  assert.equal(webhookKeyCache.stats().derivations - before, 1);

  await webhookKeyCache.getWebhookConfig({ ...connector, config: 'enc:v1:rotated' }, load);
  assert.equal(loads, 2, 'a rotated secret (new envelope) is re-derived');

  webhookKeyCache.invalidate('c1');
  await webhookKeyCache.getWebhookConfig({ ...connector, config: 'enc:v1:rotated' }, load);
  assert.equal(loads, 3, 'invalidate drops the entry');
  assert.equal(Object.isFrozen(results[0]), true, 'cached config is immutable');
});
