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
