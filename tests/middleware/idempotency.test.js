/**
 * Unit tests for `middleware/idempotency.middleware.js` (roadmap 1.12): the
 * cross-instance in-progress guard, cache-failure modes and opt-in rules.
 * The HTTP replay / isolation behaviour is covered end to end in
 * `tests/auth-hardening.integration.test.js`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { idempotency } from '../../src/middleware/idempotency.middleware.js';
import { createMemoryCache } from '../../src/cache/memory.js';
import { scopedKey } from '../../src/utils/idempotency.js';

const SCOPE = () => ({ actorType: 'user', actorId: 'u1', tenantId: 't1' });

function makeReq({ method = 'POST', key = 'k1', body = { a: 1 }, url = '/api/v1/things' } = {}) {
  return {
    method,
    originalUrl: url,
    headers: key === null ? {} : { 'x-idempotency-key': key },
    body,
  };
}

function makeRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.body = undefined;
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.setHeader = (name, value) => {
    res.headers[name.toLowerCase()] = value;
  };
  res.getHeader = (name) => res.headers[name.toLowerCase()];
  res.send = (body) => {
    res.body = body;
    res.emit('finish');
    return res;
  };
  return res;
}

/** Run the middleware; resolves with what reached `next` (or 'sent'). */
function run(mw, req, res, handler) {
  return new Promise((resolve) => {
    const done = (err) => {
      if (err) return resolve({ error: err });
      if (handler) handler(req, res);
      return resolve({ next: true });
    };
    Promise.resolve(mw(req, res, done)).then(() => {
      if (res.body !== undefined && !handler) resolve({ sent: true });
    });
  });
}

test('requests without the header, or safe methods, pass straight through', async () => {
  const mw = idempotency({ cache: createMemoryCache(), scopeFn: SCOPE });
  assert.deepEqual(await run(mw, makeReq({ key: null }), makeRes()), { next: true });
  assert.deepEqual(await run(mw, makeReq({ method: 'GET' }), makeRes()), { next: true });
});

test('requests without an actor scope are not handled', async () => {
  const mw = idempotency({ cache: createMemoryCache(), scopeFn: () => null });
  assert.deepEqual(await run(mw, makeReq({ key: 'no-scope' }), makeRes()), { next: true });
});

test('a duplicate on another instance gets 409 IDEMPOTENCY_IN_PROGRESS with Retry-After', async () => {
  const cache = createMemoryCache();
  // Another instance already holds the shared lock for this key.
  const sharedCache = { ...cache, increment: async (key) => (await cache.increment(key)) + 1 };
  const mw = idempotency({ cache: sharedCache, scopeFn: SCOPE });
  const res = makeRes();
  const outcome = await run(mw, makeReq({ key: 'busy' }), res);
  assert.equal(outcome.error.statusCode, 409);
  assert.equal(outcome.error.code, 'IDEMPOTENCY_IN_PROGRESS');
  assert.equal(res.headers['retry-after'], '1');
});

test('a lock orphaned without expiry (instance died after INCR) is given its TTL', async () => {
  const cache = createMemoryCache();
  const storageKey = scopedKey({
    scope: SCOPE(), method: 'POST', path: '/api/v1/things', clientKey: 'orphan',
  });
  const lockKey = `idempotency-lock:${storageKey}`;
  await cache.increment(lockKey); // the INCR landed, the bounding SET never did
  assert.equal(await cache.ttl(lockKey), -1);

  const mw = idempotency({ cache, scopeFn: SCOPE, lockTtlSec: 30 });
  const outcome = await run(mw, makeReq({ key: 'orphan' }), makeRes());
  assert.equal(outcome.error.code, 'IDEMPOTENCY_IN_PROGRESS');
  const remaining = await cache.ttl(lockKey);
  assert.ok(remaining > 0 && remaining <= 30, `the lock now expires (ttl ${remaining})`);
});

test('first request runs, the replay is served from the stored outcome', async () => {
  const cache = createMemoryCache();
  const mw = idempotency({ cache, scopeFn: SCOPE });
  let calls = 0;
  const handler = (_req, res) => {
    calls += 1;
    res.status(201);
    res.setHeader('content-type', 'application/json');
    res.send(JSON.stringify({ id: calls }));
  };
  await run(mw, makeReq({ key: 'replay' }), makeRes(), handler);
  await new Promise((resolve) => setImmediate(resolve)); // let the outcome persist

  const replayRes = makeRes();
  const replay = await run(mw, makeReq({ key: 'replay' }), replayRes);
  assert.deepEqual(replay, { sent: true });
  assert.equal(calls, 1);
  assert.equal(replayRes.statusCode, 201);
  assert.equal(replayRes.body, JSON.stringify({ id: 1 }));
  assert.equal(replayRes.headers['x-idempotent-replay'], 'true');
});

test('failed (non-2xx) outcomes are not stored, so a retry runs again', async () => {
  const cache = createMemoryCache();
  const mw = idempotency({ cache, scopeFn: SCOPE });
  let calls = 0;
  const failing = (_req, res) => {
    calls += 1;
    res.status(500).send('{"error":true}');
  };
  await run(mw, makeReq({ key: 'fails' }), makeRes(), failing);
  await new Promise((resolve) => setImmediate(resolve));
  await run(mw, makeReq({ key: 'fails' }), makeRes(), failing);
  assert.equal(calls, 2);
});

test('binary (Buffer) responses are not stored, so a retry runs again instead of replaying corrupted bytes', async () => {
  const cache = createMemoryCache();
  const mw = idempotency({ cache, scopeFn: SCOPE });
  let calls = 0;
  const binary = (_req, res) => {
    calls += 1;
    res.status(200).send(Buffer.from([0xff, 0xd8, 0xff, 0x00]));
  };
  await run(mw, makeReq({ key: 'binary' }), makeRes(), binary);
  await new Promise((resolve) => setImmediate(resolve));
  await run(mw, makeReq({ key: 'binary' }), makeRes(), binary);
  assert.equal(calls, 2);
});

test('cache failure: fail closed with 503 by default, run unprotected with failOpen', async () => {
  const broken = {
    get: async () => {
      throw new Error('redis down');
    },
    set: async () => {},
    del: async () => {},
    increment: async () => 1,
  };
  const closed = await run(idempotency({ cache: broken, scopeFn: SCOPE }), makeReq({ key: 'down-1' }), makeRes());
  assert.equal(closed.error.statusCode, 503);
  const open = await run(
    idempotency({ cache: broken, scopeFn: SCOPE, failOpen: true }),
    makeReq({ key: 'down-2' }),
    makeRes(),
  );
  assert.deepEqual(open, { next: true });
});

test('an unusable header is rejected with 400 IDEMPOTENCY_KEY_INVALID', async () => {
  const mw = idempotency({ cache: createMemoryCache(), scopeFn: SCOPE });
  const outcome = await run(mw, makeReq({ key: 'x'.repeat(256) }), makeRes());
  assert.equal(outcome.error.statusCode, 400);
  assert.equal(outcome.error.code, 'IDEMPOTENCY_KEY_INVALID');
});

test('default scope: an admin targeting two tenants with one key gets no cross-tenant replay', async () => {
  const cache = createMemoryCache();
  const mw = idempotency({ cache });
  let calls = 0;
  const handler = (_req, res) => {
    calls += 1;
    res.status(201);
    res.send(JSON.stringify({ call: calls }));
  };
  const adminReq = (tenant) => ({
    ...makeReq({ key: 'same-key' }),
    admin: { id: 'adm1', tenantId: null },
    headers: { 'x-idempotency-key': 'same-key', 'x-tenant-id': tenant },
  });

  await run(mw, adminReq('tenant-a'), makeRes(), handler);
  await new Promise((resolve) => setImmediate(resolve));
  await run(mw, adminReq('tenant-b'), makeRes(), handler);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2, 'the second tenant ran its own request');

  const replayRes = makeRes();
  assert.deepEqual(await run(mw, adminReq('TENANT-A'), replayRes), { sent: true });
  assert.equal(replayRes.body, JSON.stringify({ call: 1 }), 'same tenant (case-insensitive) replays');
});

test('default scope: requests without a verified actor are not handled', async () => {
  const mw = idempotency({ cache: createMemoryCache() });
  assert.deepEqual(await run(mw, makeReq({ key: 'anonymous' }), makeRes()), { next: true });
});
