/**
 * Session lifecycle - service + repository integration tests against a real
 * MongoDB.
 *
 * WHY IT EXISTS
 *   Sessions are the backbone of the auth contract, but most of their rules
 *   live below the HTTP layer. These tests exercise `session.service.js` +
 *   `session.repository.js` end-to-end against mongodb-memory-server: the
 *   deterministic refresh-token hash lookup, create-then-revoke rotation,
 *   idempotent revocation, family revocation and expiry.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from './helpers/mongo.js';
import sessionService from '../src/modules/iam/auth/session.service.js';
import sessionRepository from '../src/repositories/session.repository.js';

before(async () => {
  await startMongo();
});

beforeEach(async () => {
  await resetMongo();
});

after(async () => {
  await stopMongo();
});

async function createSession({ actorId = 'usr_test', actorType = 'user', tenantId = 'ten_test', refreshToken = sessionService.generateRefreshToken() } = {}) {
  return sessionService.create({ actorId, actorType, tenantId, refreshToken });
}

test('generateRefreshToken produces an opaque URL-safe token', () => {
  const token = sessionService.generateRefreshToken();
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 32);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(sessionService.generateRefreshToken(), token, 'tokens must be unique');
});

test('refresh-token hashing is deterministic so the lookup can match', async () => {
  const refreshToken = sessionService.generateRefreshToken();
  const { session } = await createSession({ refreshToken });

  // The stored hash equals a fresh hash of the same token...
  assert.equal(session.refreshTokenHash, await sessionService.hashRefreshToken(refreshToken));
  // ...and the repository can find the session by that hash (any status).
  const found = await sessionRepository.findByRefreshTokenHash(
    await sessionService.hashRefreshToken(refreshToken),
  );
  assert.ok(found, 'session must be findable by re-hashing the presented token');
  assert.equal(found.sessionId, session.sessionId);
  // A different token must never collide with it.
  const other = await sessionRepository.findByRefreshTokenHash(
    await sessionService.hashRefreshToken(sessionService.generateRefreshToken()),
  );
  assert.equal(other, null);
});

test('create persists an active session with the right shape', async () => {
  const { session, refreshToken } = await createSession();
  const stored = await sessionRepository.findById(session.sessionId);

  assert.equal(stored.status, 'active');
  assert.equal(stored.actorId, 'usr_test');
  assert.equal(stored.actorType, 'user');
  assert.equal(stored.tenantId, 'ten_test');
  assert.equal(typeof refreshToken, 'string');
  assert.ok(stored.expiresAt > new Date());
});

test('rotate creates the successor first and revokes the predecessor', async () => {
  const { session } = await createSession();
  const nextToken = sessionService.generateRefreshToken();
  const next = await sessionService.rotate({ session, refreshToken: nextToken });

  assert.notEqual(next.session.sessionId, session.sessionId);
  assert.notEqual(next.session.refreshTokenHash, session.refreshTokenHash);

  const old = await sessionRepository.findById(session.sessionId);
  assert.equal(old.status, 'revoked');
  assert.equal(old.revokedReason, 'rotated');
  assert.ok(old.revokedAt);

  const current = await sessionRepository.findById(next.session.sessionId);
  assert.equal(current.status, 'active');
});

test('revoke is idempotent: only the first call transitions the session', async () => {
  const { session } = await createSession();
  assert.equal(await sessionService.revoke({ sessionId: session.sessionId }), true);
  assert.equal(await sessionService.revoke({ sessionId: session.sessionId }), false);

  const stored = await sessionRepository.findById(session.sessionId);
  assert.equal(stored.status, 'revoked');
  assert.equal(stored.revokedReason, 'logout');
});

test('revokeAllForActor kills every active session for the actor', async () => {
  const actorId = 'usr_multi';
  const a = await createSession({ actorId });
  const b = await createSession({ actorId });

  const revoked = await sessionService.revokeAllForActor({ actorId });
  assert.equal(revoked, 2);
  assert.equal((await sessionRepository.findById(a.session.sessionId)).status, 'revoked');
  assert.equal((await sessionRepository.findById(b.session.sessionId)).status, 'revoked');
});

test('markExpired transitions an active session to expired', async () => {
  const { session } = await createSession();
  await sessionService.markExpired(session.sessionId);
  assert.equal((await sessionRepository.findById(session.sessionId)).status, 'expired');
});
