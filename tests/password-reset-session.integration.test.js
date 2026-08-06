/**
 * Password reset flow - end-to-end HTTP integration tests.
 *
 * WHY IT EXISTS
 *   Proves the forgot/reset contract: no user enumeration, stateless signed
 *   reset tokens, the old password stops working, and a completed reset
 *   revokes the ENTIRE session family (old refresh + access tokens die).
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import env from '../src/config/env.js';
import { sign, JWT_AUDIENCES } from '../src/utils/jwt.js';
import { startMongo, stopMongo, resetMongo } from './helpers/mongo.js';
import { startHttp, stopHttp, api, refreshCookieFrom } from './helpers/http.js';
import { factories } from './helpers/factories.js';

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

const BASE = '/api/v1/auth';
const PASSWORD = 'Password123!';
const NEW_PASSWORD = 'NewPassword456!';

async function seedUser() {
  const tenant = await factories.tenant.create();
  const user = await factories.user.create({ tenantId: tenant._id.toString() });
  return { tenant, user };
}

function tenantHeaders(tenantId) {
  return { 'X-Tenant-Id': tenantId };
}

function login(email, password, tenantId) {
  return api(`${BASE}/login`, {
    method: 'POST',
    headers: tenantHeaders(tenantId),
    body: { email, password },
  });
}

/** Mint a reset token the same way `password.service.js` does. */
async function resetTokenFor(user) {
  return sign({
    payload: { purpose: 'password_reset', email: user.email },
    subject: user._id.toString(),
    audience: JWT_AUDIENCES.USER,
    expiresIn: Math.floor(env.security.auth.passwordResetTokenTtlMs / 1000),
  });
}

test('forgot always returns ok and never reveals whether an email exists', async () => {
  const { tenant, user } = await seedUser();

  const known = await api(`${BASE}/password/forgot`, {
    method: 'POST',
    headers: tenantHeaders(tenant._id.toString()),
    body: { email: user.email },
  });
  assert.equal(known.status, 200);
  assert.equal(known.json.data.ok, true);

  const unknown = await api(`${BASE}/password/forgot`, {
    method: 'POST',
    headers: tenantHeaders(tenant._id.toString()),
    body: { email: 'nobody@example.com' },
  });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.json.data.ok, true);
});

test('reset with a valid token changes the password and revokes sessions', async () => {
  const { tenant, user } = await seedUser();
  const token = await resetTokenFor(user);

  // Establish a live session before the reset.
  const loginBefore = await login(user.email, PASSWORD, tenant._id.toString());
  assert.equal(loginBefore.status, 200);
  const oldCookie = refreshCookieFrom(loginBefore);
  const oldAccessToken = loginBefore.json.data.accessToken;

  // Complete the reset.
  const reset = await api(`${BASE}/password/reset`, {
    method: 'POST',
    headers: tenantHeaders(tenant._id.toString()),
    body: { token, newPassword: NEW_PASSWORD },
  });
  assert.equal(reset.status, 200);
  assert.equal(reset.json.data.ok, true);

  // Old password stops working; new password works.
  const oldLogin = await login(user.email, PASSWORD, tenant._id.toString());
  assert.equal(oldLogin.status, 401);
  const newLogin = await login(user.email, NEW_PASSWORD, tenant._id.toString());
  assert.equal(newLogin.status, 200);

  // The pre-reset refresh token and access token are both dead.
  const staleRefresh = await api(`${BASE}/refresh`, { method: 'POST', cookies: [oldCookie] });
  assert.equal(staleRefresh.status, 401);
  const staleMe = await api(`${BASE}/me`, {
    headers: { authorization: `Bearer ${oldAccessToken}` },
  });
  assert.equal(staleMe.status, 401);
});

test('reset with an invalid or foreign token returns a generic error', async () => {
  const { tenant } = await seedUser();

  const garbage = await api(`${BASE}/password/reset`, {
    method: 'POST',
    headers: tenantHeaders(tenant._id.toString()),
    body: { token: 'not-a-jwt', newPassword: NEW_PASSWORD },
  });
  assert.equal(garbage.status, 400);
  assert.match(garbage.json.message, /invalid or has expired/);

  // A token signed for the wrong portal audience must not reset a user.
  const foreign = await sign({
    payload: { purpose: 'password_reset', email: 'x@example.com' },
    subject: 'adm_someone',
    audience: JWT_AUDIENCES.ADMIN,
    expiresIn: 900,
  });
  const wrongAudience = await api(`${BASE}/password/reset`, {
    method: 'POST',
    headers: tenantHeaders(tenant._id.toString()),
    body: { token: foreign, newPassword: NEW_PASSWORD },
  });
  assert.equal(wrongAudience.status, 400);
});
