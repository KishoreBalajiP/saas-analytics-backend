/**
 * Tests for `modules/connectors/webhook/webhook.verify.js`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSignature,
  verifySignature,
  verifyTimestamp,
  verifyWebhook,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from '../../../../src/modules/connectors/webhook/webhook.verify.js';
import { WebhookSignatureError } from '../../../../src/modules/connectors/shared/errors.js';

const SECRET = 'a-very-long-signing-secret-0001';

test('computeSignature produces a sha256=<hex> value', () => {
  const sig = computeSignature('{"a":1}', SECRET);
  assert.ok(sig.startsWith('sha256='));
  assert.equal(sig.split('=')[1].length, 64);
});

test('verifySignature accepts the correct signature', () => {
  const rawBody = Buffer.from('{"a":1}');
  const sig = computeSignature(rawBody, SECRET);
  assert.equal(verifySignature({ rawBody, signatureHeader: sig, secret: SECRET }).valid, true);
});

test('verifySignature fails closed on missing, malformed or wrong signatures', () => {
  const rawBody = Buffer.from('{"a":1}');
  const sig = computeSignature(rawBody, SECRET);
  assert.equal(verifySignature({ rawBody, signatureHeader: undefined, secret: SECRET }).valid, false);
  assert.equal(verifySignature({ rawBody, signatureHeader: '', secret: SECRET }).valid, false);
  assert.equal(verifySignature({ rawBody, signatureHeader: 'md5=abc', secret: SECRET }).valid, false);
  assert.equal(verifySignature({ rawBody, signatureHeader: sig, secret: 'wrong-secret' }).valid, false);
  assert.equal(verifySignature({ rawBody, signatureHeader: sig.slice(0, -4) + '0000', secret: SECRET }).valid, false);
});

test('verifyTimestamp accepts fresh timestamps and rejects stale ones', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(verifyTimestamp({ timestampHeader: String(now) }).valid, true);
  assert.equal(verifyTimestamp({ timestampHeader: String(now - 10_000) }).valid, false);
  assert.equal(verifyTimestamp({ timestampHeader: 'not-a-number' }).valid, false);
  assert.equal(verifyTimestamp({ timestampHeader: undefined }).valid, true);
});

test('verifyTimestamp requires the header when requireTimestamp is set', () => {
  assert.equal(verifyTimestamp({ timestampHeader: undefined, rule: { requireTimestamp: true } }).valid, false);
  const now = Math.floor(Date.now() / 1000);
  assert.equal(verifyTimestamp({ timestampHeader: String(now), rule: { requireTimestamp: true } }).valid, true);
});

test('verifyWebhook accepts a fully valid request', () => {
  const rawBody = Buffer.from(JSON.stringify({ event: 'x' }));
  const sig = computeSignature(rawBody, SECRET);
  assert.doesNotThrow(() =>
    verifyWebhook({
      rawBody,
      headers: {
        [SIGNATURE_HEADER]: sig,
        [TIMESTAMP_HEADER]: String(Math.floor(Date.now() / 1000)),
      },
      secret: SECRET,
    }),
  );
});

test('verifyWebhook throws WebhookSignatureError on a bad signature', () => {
  const rawBody = Buffer.from(JSON.stringify({ event: 'x' }));
  assert.throws(
    () => verifyWebhook({ rawBody, headers: { [SIGNATURE_HEADER]: 'sha256=deadbeef' }, secret: SECRET }),
    WebhookSignatureError,
  );
});

test('verifyWebhook throws WebhookSignatureError on a stale timestamp', () => {
  const rawBody = Buffer.from(JSON.stringify({ event: 'x' }));
  const sig = computeSignature(rawBody, SECRET);
  assert.throws(
    () =>
      verifyWebhook({
        rawBody,
        headers: { [SIGNATURE_HEADER]: sig, [TIMESTAMP_HEADER]: '1' },
        secret: SECRET,
      }),
    WebhookSignatureError,
  );
});
