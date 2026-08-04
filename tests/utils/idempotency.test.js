/**
 * Tests for `utils/idempotency.js`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeKey, keyFromRaw } from '../../src/utils/idempotency.js';

function makeReq({ headers = {}, method = 'POST', body, url = '/api/v1/foo' } = {}) {
  return {
    method,
    headers,
    body,
    originalUrl: url,
  };
}

test('computeKey returns a stable 64-char hex digest', () => {
  const req = makeReq({ body: { a: 1, b: 2 } });
  const k1 = computeKey(req);
  const k2 = computeKey(req);
  assert.equal(k1, k2);
  assert.equal(k1.length, 64);
  assert.match(k1, /^[0-9a-f]{64}$/);
});

test('computeKey uses the X-Idempotency-Key header when present', () => {
  const headerKey = computeKey(makeReq({ headers: { 'x-idempotency-key': 'order:42' } }));
  const fallback = computeKey(makeReq({ body: { x: 1 } }));
  assert.notEqual(headerKey, fallback);
});

test('key order does not affect body-based fingerprint', () => {
  const a = computeKey(makeReq({ body: { a: 1, b: 2 } }));
  const b = computeKey(makeReq({ body: { b: 2, a: 1 } }));
  assert.equal(a, b);
});

test('header-based keys differ when the header differs', () => {
  const a = computeKey(makeReq({ headers: { 'x-idempotency-key': 'k1' } }));
  const b = computeKey(makeReq({ headers: { 'x-idempotency-key': 'k2' } }));
  assert.notEqual(a, b);
});

test('rejects oversized header values', () => {
  const huge = 'x'.repeat(300);
  const k = computeKey(makeReq({ headers: { 'x-idempotency-key': huge }, body: { y: 1 } }));
  // Falls back to body fingerprint.
  assert.equal(k, computeKey(makeReq({ headers: {}, body: { y: 1 } })));
});

test('keyFromRaw rejects empty input', () => {
  assert.throws(() => keyFromRaw(''), /non-empty string/);
  assert.throws(() => keyFromRaw(null), /non-empty string/);
});

test('keyFromRaw is deterministic', () => {
  assert.equal(keyFromRaw('foo'), keyFromRaw('foo'));
  assert.notEqual(keyFromRaw('foo'), keyFromRaw('bar'));
});
