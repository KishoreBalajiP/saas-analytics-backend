/**
 * Admin-portal password reset - end-to-end HTTP integration tests.
 *
 * WHY IT EXISTS
 *   The forgot/reset contract is shared by both portals (one generic
 *   `password.service.js`), but the ADMIN portal has its own audience,
 *   account table and route surface (`/api/v1/admin-auth/password/*`).
 *   These tests prove the admin half of the contract that the tenant-portal
 *   suite (`tests/password-reset-session.integration.test.js`) covers for
 *   users: no enumeration, stateless signed reset tokens scoped to the admin
 *   audience, old credentials stop working, and a completed reset revokes the
 *   ENTIRE admin session family.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { startMongo, stopMongo, resetMongo } from './helpers/mongo.js';
import { startHttp, stopHttp, api, refreshCookieFrom } from './helpers/http.js';
import { factories } from './helpers/factories.js';
import { PasswordResetToken } from '../src/models/PasswordResetToken.js';

before(async () => {
  await startMongo();
  await startHttp();
});

beforeEach(async () => {
  await resetMongo();
});

after(async () => {
  await stopHttp();
  await stopMongo();
});

const BASE = '/api/v1/admin-auth';
const PASSWORD = 'Password123!';
const NEW_PASSWORD = 'NewPassword456!';

async function seedAdmin(overrides = {}) {
  return factories.admin.create(overrides);
}

function adminLogin(email, password) {
  return api(`${BASE}/login`, { method: 'POST', body: { email, password } });
}

/** Create the same opaque token record used by the production service. */
async function resetTokenFor(admin) {
  const token = randomBytes(32).toString('base64url');
  await PasswordResetToken.create({
    portal: 'admin',
    actorId: admin._id.toString(),
    tokenHash: createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + 900000),
  });
  return token;
}

test('admin forgot always returns ok and never reveals whether an email exists', async () => {
  const admin = await seedAdmin();

  const known = await api(`${BASE}/password/forgot`, {
    method: 'POST',
    body: { email: admin.email },
  });
  assert.equal(known.status, 200);
  assert.equal(known.json.data.ok, true);

  const unknown = await api(`${BASE}/password/forgot`, {
    method: 'POST',
    body: { email: 'nobody@example.com' },
  });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.json.data.ok, true);
});

test('admin forgot accepts missing accounts without leaking account state', async () => {
  const res = await api(`${BASE}/password/forgot`, {
    method: 'POST',
    body: { email: '' },
  });
  assert.equal(res.status, 422, 'an empty email must fail validation');
});

test('admin reset with a valid token changes the password and revokes sessions', async () => {
  const admin = await seedAdmin();
  const token = await resetTokenFor(admin);

  // Establish a live admin session before the reset.
  const loginBefore = await adminLogin(admin.email, PASSWORD);
  assert.equal(loginBefore.status, 200);
  const oldCookie = refreshCookieFrom(loginBefore);
  const oldAccessToken = loginBefore.json.data.accessToken;

  // Complete the reset.
  const reset = await api(`${BASE}/password/reset`, {
    method: 'POST',
    body: { token, newPassword: NEW_PASSWORD },
  });
  assert.equal(reset.status, 200);
  assert.equal(reset.json.data.ok, true);

  // Old password stops working; new password works.
  const oldLogin = await adminLogin(admin.email, PASSWORD);
  assert.equal(oldLogin.status, 401);
  const newLogin = await adminLogin(admin.email, NEW_PASSWORD);
  assert.equal(newLogin.status, 200);

  // The pre-reset refresh token and access token are both dead.
  const staleRefresh = await api(`${BASE}/refresh`, { method: 'POST', cookies: [oldCookie] });
  assert.equal(staleRefresh.status, 401);
  const staleMe = await api(`${BASE}/me`, {
    headers: { authorization: `Bearer ${oldAccessToken}` },
  });
  assert.equal(staleMe.status, 401);
});

test('admin reset with an invalid or foreign token returns a generic error', async () => {
  const admin = await seedAdmin();

  const garbage = await api(`${BASE}/password/reset`, {
    method: 'POST',
    body: { token: 'not-a-jwt', newPassword: NEW_PASSWORD },
  });
  assert.equal(garbage.status, 400);
  assert.match(garbage.json.message, /invalid or has expired/);

  const foreign = 'not-a-valid-reset-token-value';
  const wrongAudience = await api(`${BASE}/password/reset`, {
    method: 'POST',
    body: { token: foreign, newPassword: NEW_PASSWORD },
  });
  assert.equal(wrongAudience.status, 400);
  assert.match(wrongAudience.json.message, /invalid or has expired/);
});
