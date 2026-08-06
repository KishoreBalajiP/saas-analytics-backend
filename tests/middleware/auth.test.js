/**
 * Tests for the Sprint 1 authentication middleware.
 *
 * Covers `authenticate` / `optionalAuthenticate` (user audience) and
 * `adminAuth` / `adminAuthOptional` (admin audience). The session liveness
 * lookup is stubbed via `sessionRepository.findById` so no database is
 * needed - token signing/verification uses the real `utils/jwt.js`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';

import { sign, JWT_AUDIENCES } from '../../src/utils/jwt.js';
import { authenticate, optionalAuthenticate } from '../../src/middleware/auth.middleware.js';
import { adminAuth, adminAuthOptional } from '../../src/middleware/adminAuth.middleware.js';
import sessionRepository from '../../src/repositories/session.repository.js';

const ACTIVE_SESSION = {
  sessionId: 'ses_test',
  status: 'active',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

const REVOKED_SESSION = { ...ACTIVE_SESSION, status: 'revoked', revokedAt: new Date().toISOString() };
const EXPIRED_SESSION = {
  ...ACTIVE_SESSION,
  status: 'active',
  expiresAt: new Date(Date.now() - 60_000).toISOString(),
};

/** Mint a signed access token carrying a sessionId claim. */
async function mint({ audience = JWT_AUDIENCES.USER, sessionId = 'ses_test', sub = 'usr_test' } = {}) {
  return sign({
    payload: { sessionId, email: 'a@b.com' },
    subject: sub,
    audience,
    expiresIn: '15m',
  });
}

function bearer(token) {
  return { headers: { authorization: `Bearer ${token}` } };
}

/** Invoke a middleware; returns the error passed to `next` (or undefined). */
async function invoke(middleware, req) {
  let error;
  await middleware(req, {}, (err) => {
    error = err;
  });
  return error;
}

function stubSession(t, session) {
  mock.method(sessionRepository, 'findById', async () => session);
  t.after(() => mock.restoreAll());
}

test('authenticate attaches req.user for a valid token + live session', async (t) => {
  stubSession(t, ACTIVE_SESSION);
  const req = bearer(await mint());
  const error = await invoke(authenticate, req);
  assert.equal(error, undefined);
  assert.equal(req.user.id, 'usr_test');
  assert.equal(req.user.sessionId, 'ses_test');
  assert.equal(req.user.email, 'a@b.com');
});

test('authenticate rejects a missing Authorization header with 401', async () => {
  const error = await invoke(authenticate, { headers: {} });
  assert.equal(error.statusCode, 401);
});

test('authenticate rejects a token for the wrong audience (admin token on user route)', async (t) => {
  stubSession(t, ACTIVE_SESSION);
  const req = bearer(await mint({ audience: JWT_AUDIENCES.ADMIN }));
  const error = await invoke(authenticate, req);
  assert.equal(error.statusCode, 401);
});

test('authenticate rejects a revoked session with 401', async (t) => {
  stubSession(t, REVOKED_SESSION);
  const req = bearer(await mint());
  const error = await invoke(authenticate, req);
  assert.equal(error.statusCode, 401);
});

test('authenticate rejects an expired session with 401', async (t) => {
  stubSession(t, EXPIRED_SESSION);
  const req = bearer(await mint());
  const error = await invoke(authenticate, req);
  assert.equal(error.statusCode, 401);
});

test('authenticate rejects a token whose session is missing entirely', async (t) => {
  stubSession(t, null);
  const req = bearer(await mint());
  const error = await invoke(authenticate, req);
  assert.equal(error.statusCode, 401);
});

test('optionalAuthenticate passes through without req.user when no token', async () => {
  const req = { headers: {} };
  const error = await invoke(optionalAuthenticate, req);
  assert.equal(error, undefined);
  assert.equal(req.user, undefined);
});

test('optionalAuthenticate attaches req.user when a valid token is present', async (t) => {
  stubSession(t, ACTIVE_SESSION);
  const req = bearer(await mint());
  const error = await invoke(optionalAuthenticate, req);
  assert.equal(error, undefined);
  assert.equal(req.user.id, 'usr_test');
});

test('adminAuth attaches req.admin for an admin-audience token', async (t) => {
  stubSession(t, ACTIVE_SESSION);
  const req = bearer(await mint({ audience: JWT_AUDIENCES.ADMIN }));
  const error = await invoke(adminAuth, req);
  assert.equal(error, undefined);
  assert.equal(req.admin.id, 'usr_test');
});

test('adminAuth rejects a user-audience token with 401', async (t) => {
  stubSession(t, ACTIVE_SESSION);
  const req = bearer(await mint({ audience: JWT_AUDIENCES.USER }));
  const error = await invoke(adminAuth, req);
  assert.equal(error.statusCode, 401);
});

test('adminAuthOptional passes through without req.admin when no token', async () => {
  const req = { headers: {} };
  const error = await invoke(adminAuthOptional, req);
  assert.equal(error, undefined);
  assert.equal(req.admin, undefined);
});
