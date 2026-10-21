/**
 * Tests for `utils/idempotency.js`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeKey,
  keyFromRaw,
  readIdempotencyHeader,
  scopedKey,
  fingerprintRequest,
} from '../../src/utils/idempotency.js';

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

/* ------------------------ scoped keys (roadmap 1.12) ----------------------- */

const SCOPE = { actorType: 'user', actorId: 'u1', tenantId: 't1' };
const base = { scope: SCOPE, method: 'POST', path: '/api/v1/api-keys', clientKey: 'k1' };

test('scopedKey is deterministic for the same actor, tenant, method, path and key', () => {
  assert.equal(scopedKey(base), scopedKey({ ...base, method: 'post' }));
  assert.match(scopedKey(base), /^[0-9a-f]{64}$/);
});

test('scopedKey differs per actor, actor type, tenant, targeted tenant, method, path and client key', () => {
  const variants = [
    { ...base, scope: { ...SCOPE, actorId: 'u2' } },
    { ...base, scope: { ...SCOPE, actorType: 'admin' } },
    { ...base, scope: { ...SCOPE, tenantId: 't2' } },
    { ...base, scope: { ...SCOPE, tenantId: null } },
    { ...base, scope: { ...SCOPE, targetTenantId: 't2' } },
    { ...base, method: 'PATCH' },
    { ...base, path: '/api/v1/connectors' },
    { ...base, clientKey: 'k2' },
  ];
  const keys = new Set([scopedKey(base), ...variants.map(scopedKey)]);
  assert.equal(keys.size, variants.length + 1);
});

test('scopedKey cannot be confused by separators inside its parts', () => {
  const a = scopedKey({ ...base, scope: { ...SCOPE, actorId: 'u1|tenant:t9' } });
  const b = scopedKey({ ...base, scope: { ...SCOPE, tenantId: 't9' } });
  assert.notEqual(a, b);
});

test('scopedKey requires an actor scope', () => {
  assert.throws(() => scopedKey({ ...base, scope: null }), /actor scope/);
});

test('readIdempotencyHeader accepts printable keys and flags unusable ones', () => {
  assert.deepEqual(readIdempotencyHeader({ headers: {} }), { key: null, invalid: false });
  assert.deepEqual(readIdempotencyHeader({ headers: { 'x-idempotency-key': ' order:42 ' } }), {
    key: 'order:42',
    invalid: false,
  });
  for (const bad of ['', '   ', 'x'.repeat(256), 'has space', 'tab\there', 'emoji-\u{1F600}']) {
    assert.equal(readIdempotencyHeader({ headers: { 'x-idempotency-key': bad } }).invalid, true, bad);
  }
});

test('fingerprintRequest ignores key order and detects body changes', () => {
  assert.equal(fingerprintRequest({ body: { a: 1, b: 2 } }), fingerprintRequest({ body: { b: 2, a: 1 } }));
  assert.notEqual(fingerprintRequest({ body: { a: 1 } }), fingerprintRequest({ body: { a: 2 } }));
  assert.equal(fingerprintRequest({}), fingerprintRequest({ body: undefined }));
});

test('scopedKey treats a missing targeted tenant like no X-Tenant-Id header', () => {
  assert.equal(scopedKey(base), scopedKey({ ...base, scope: { ...SCOPE, targetTenantId: null } }));
});
