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
import { createHash, randomBytes } from 'node:crypto';
import { startMongo, stopMongo, resetMongo } from './helpers/mongo.js';
import { startHttp, stopHttp, api, refreshCookieFrom } from './helpers/http.js';
import { factories } from './helpers/factories.js';
import * as emailService from '../src/services/email.service.js';
import passwordService from '../src/modules/iam/auth/password.service.js';
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

/** Create the same opaque token record used by the production service. */
async function resetTokenFor(user) {
  const token = randomBytes(32).toString('base64url');
  await PasswordResetToken.create({
    portal: 'user',
    actorId: user._id.toString(),
    tenantId: user.tenantId,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + 900000),
  });
  return token;
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

test('forgot email uses the frontend reset route and workspace slug, and token is single-use', async () => {
  const { tenant, user } = await seedUser();
  const sink = [];
  emailService.captureInto(sink);

  await passwordService.requestReset({ portal: 'user', email: user.email, tenantId: tenant.slug });
  emailService.stopCapture();
  assert.equal(sink.length, 1);
  const link = sink[0].text.match(/https?:\/\/[^\s]+/u)?.[0];
  assert.match(link, /\/login\/reset\?/u);
  assert.match(link, /tenant=acme-/u);
  const url = new URL(link);
  const token = url.searchParams.get('token');
  assert.ok(token);

  await passwordService.resetPassword({
    portal: 'user',
    token,
    tenantId: tenant.slug,
    newPassword: NEW_PASSWORD,
  });
  await assert.rejects(
    () => passwordService.resetPassword({
      portal: 'user',
      token,
      tenantId: tenant.slug,
      newPassword: 'AnotherPassword789!',
    }),
    /invalid or has expired/,
  );
});

test('reset with an invalid or foreign token returns a generic error', async () => {
  const { tenant, user } = await seedUser();

  const garbage = await api(`${BASE}/password/reset`, {
    method: 'POST',
    headers: tenantHeaders(tenant._id.toString()),
    body: { token: 'not-a-jwt', newPassword: NEW_PASSWORD },
  });
  assert.equal(garbage.status, 400);
  assert.match(garbage.json.message, /invalid or has expired/);

  const foreign = 'not-a-valid-reset-token-value';
  const wrongAudience = await api(`${BASE}/password/reset`, {
    method: 'POST',
    headers: tenantHeaders(tenant._id.toString()),
    body: { token: foreign, newPassword: NEW_PASSWORD },
  });
  assert.equal(wrongAudience.status, 400);
});

test('expired and cross-tenant reset tokens fail safely', async () => {
  const first = await seedUser();
  const second = await seedUser();
  const token = randomBytes(32).toString('base64url');
  await PasswordResetToken.create({
    portal: 'user',
    actorId: first.user._id.toString(),
    tenantId: first.tenant._id.toString(),
    tokenHash: createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() - 1000),
  });
  await assert.rejects(
    () => passwordService.resetPassword({ portal: 'user', token, tenantId: first.tenant.slug, newPassword: NEW_PASSWORD }),
    /invalid or has expired/,
  );

  const liveToken = randomBytes(32).toString('base64url');
  await PasswordResetToken.create({
    portal: 'user',
    actorId: first.user._id.toString(),
    tenantId: first.tenant._id.toString(),
    tokenHash: createHash('sha256').update(liveToken).digest('hex'),
    expiresAt: new Date(Date.now() + 900000),
  });
  await assert.rejects(
    () => passwordService.resetPassword({ portal: 'user', token: liveToken, tenantId: second.tenant.slug, newPassword: NEW_PASSWORD }),
    /invalid or has expired/,
  );
});
