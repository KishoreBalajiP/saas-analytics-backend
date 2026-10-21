/**
 * Smoke test - request lifecycle and health endpoint.
 *
 * WHY IT EXISTS
 *   Proves the Express app assembles and answers with the standard envelope
 *   without needing MongoDB. It also guards the `app.js` / `server.js`
 *   separation (tests import `app` directly, which must never connect to a
 *   database or open a port).
 *
 * HOW TO EXTEND
 *   Add integration tests here (real HTTP round-trips) as features land.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';

test('GET /api/v1/health returns a healthy envelope', async (t) => {
  // Bind to an ephemeral port so the test never collides with a dev server.
  const server = app.listen(0);
  t.after(() => server.close());

  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.status, 'ok');
  assert.equal(body.data.environment, 'development');
  assert.equal(typeof body.data.version, 'string');
  assert.ok(typeof body.data.uptime === 'string');
  assert.ok(body.data.db === 'connected' || body.data.db === 'disconnected');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
});

test('unknown routes return the standard 404 envelope', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());

  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/nope`);
  const body = await res.json();

  assert.equal(res.status, 404);
  assert.equal(body.success, false);
  assert.equal(body.statusCode, 404);
});

test('readiness fails safely when the database is unavailable', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());

  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/health/ready`);
  const body = await res.json();

  assert.equal(res.status, 503);
  assert.equal(body.success, false);
  assert.equal(body.code, 'SERVICE_UNAVAILABLE');
  // Roadmap 2.8: the 503 names the failing dependencies (component and
  // status only - no hosts, errors or latencies on this public probe).
  assert.equal(body.data.status, 'not_ready');
  assert.equal(body.data.checks.database, 'down');
  assert.equal(body.data.checks.queue, 'ok');
  for (const value of Object.values(body.data.checks)) {
    assert.ok(['ok', 'degraded', 'down', 'disabled', 'unknown'].includes(value), value);
  }
  assert.equal(typeof body.requestId, 'string');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('liveness stays 200 while readiness is 503 (cheap, dependency-free)', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());

  const { port } = server.address();
  const live = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
  const ready = await fetch(`http://127.0.0.1:${port}/api/v1/health/ready`);
  assert.equal(live.status, 200);
  assert.equal((await live.json()).data.db, 'disconnected');
  assert.equal(ready.status, 503);
});
