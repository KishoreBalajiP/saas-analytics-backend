/**
 * Admin-portal authentication + MFA - end-to-end HTTP integration tests.
 *
 * WHY IT EXISTS
 *   Proves the `/api/v1/admin-auth` stack: admin login/refresh, authenticated
 *   `/me`, and the two-step TOTP enrolment lifecycle (enroll -> verify code ->
 *   login now requires a code). TOTP codes are generated locally with the
 *   RFC 6238 helper against the exact secret the API returns at enrolment.
 *
 * DESIGN
 *   - Real Express app on an ephemeral port + real in-memory MongoDB.
 *   - MFA secret at rest is AES-256-GCM encrypted under the per-admin
 *     context; the raw secret is only ever seen in the one-time enrol
 *     response, exactly like the production contract.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from './helpers/mongo.js';
import { startHttp, stopHttp, api, refreshCookieFrom } from './helpers/http.js';
import { totpCode } from './helpers/totp.js';
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

const BASE = '/api/v1/admin-auth';
const PASSWORD = 'Password123!';
const GENERIC = 'Invalid email or password';

/** Create an active platform admin with the standard test password. */
async function seedAdmin(overrides = {}) {
  return factories.admin.create(overrides);
}

function adminLogin(password = PASSWORD, body = {}) {
  return api(`${BASE}/login`, { method: 'POST', body: { email: null, password, ...body } });
}

async function loggedInAdmin() {
  const admin = await seedAdmin();
  const login = await adminLogin(PASSWORD, { email: admin.email });
  return { admin, login };
}

/* ------------------------------- login ---------------------------------- */

test('admin login issues tokens for valid credentials', async () => {
  const admin = await seedAdmin();
  const login = await adminLogin(PASSWORD, { email: admin.email });

  assert.equal(login.status, 200);
  assert.equal(login.json.success, true);
  assert.equal(typeof login.json.data.accessToken, 'string');
  assert.equal(typeof login.json.data.refreshToken, 'string');
  assert.equal(login.json.data.actor.email, admin.email);
  assert.ok(login.setCookie.some((c) => c.startsWith('saas_session=')));
});

test('admin login rejects a wrong password with a generic message', async () => {
  const admin = await seedAdmin();
  const res = await adminLogin('WrongPassword1!', { email: admin.email });

  assert.equal(res.status, 401);
  assert.equal(res.json.message, GENERIC);
});

/* -------------------------------- /me ------------------------------------ */

test('GET /me returns the admin profile without secrets', async () => {
  const { admin, login } = await loggedInAdmin();
  const me = await api(`${BASE}/me`, {
    headers: { authorization: `Bearer ${login.json.data.accessToken}` },
  });

  assert.equal(me.status, 200);
  assert.equal(me.json.data.id, admin._id.toString());
  assert.equal(me.json.data.email, admin.email);
  assert.equal(me.json.data.type, 'platform');
  assert.equal(me.json.data.mfaEnabled, false);
  assert.equal(me.json.data.mfaSecret, undefined, 'the encrypted secret must never leak');
});

test('mfa endpoints require an admin bearer token', async () => {
  const res = await api(`${BASE}/mfa/enroll`, { method: 'POST' });
  assert.equal(res.status, 401);
});

/* -------------------------------- MFA ------------------------------------ */

test('MFA enrolment is two-step and login enforces the code afterwards', async () => {
  const { admin, login } = await loggedInAdmin();
  const token = login.json.data.accessToken;

  // Step 1: enrol -> the secret is returned exactly once (for the QR app).
  const enroll = await api(`${BASE}/mfa/enroll`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(enroll.status, 200);
  assert.equal(enroll.json.data.mfaEnabled ?? false, false);
  const secret = enroll.json.data.secret;
  assert.equal(typeof secret, 'string');
  assert.match(enroll.json.data.otpauthUrl, /^otpauth:\/\/totp\//);

  // A wrong code must not enable MFA.
  const badVerify = await api(`${BASE}/mfa/verify`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: { code: '000000' },
  });
  assert.equal(badVerify.status, 400);

  // Step 2: the correct TOTP code enables MFA.
  const verify = await api(`${BASE}/mfa/verify`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: { code: totpCode(secret) },
  });
  assert.equal(verify.status, 200);
  assert.equal(verify.json.data.enabled, true);

  // /me now reports MFA enabled.
  const me = await api(`${BASE}/me`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.json.data.mfaEnabled, true);

  // Login without a code -> 401 flagged mfaRequired.
  const noCode = await adminLogin(PASSWORD, { email: admin.email });
  assert.equal(noCode.status, 401);
  assert.equal(noCode.json.mfaRequired, true, 'client should be told to retry with a code');

  // Login with a valid code -> success.
  const withCode = await adminLogin(PASSWORD, { email: admin.email, mfaToken: totpCode(secret) });
  assert.equal(withCode.status, 200);
  assert.ok(withCode.json.data.accessToken);

  // Login with a wrong code -> generic 401 (and counts as a failed attempt).
  const wrongCode = await adminLogin(PASSWORD, { email: admin.email, mfaToken: '123456' });
  assert.equal(wrongCode.status, 401);
  assert.equal(wrongCode.json.message, GENERIC);
});

test('admin refresh rotates the refresh-token cookie', async () => {
  const { login } = await loggedInAdmin();
  const cookie = refreshCookieFrom(login);

  const refreshed = await api(`${BASE}/refresh`, { method: 'POST', cookies: [cookie] });
  assert.equal(refreshed.status, 200);
  const newCookie = refreshCookieFrom(refreshed);
  assert.ok(newCookie);
  assert.notEqual(newCookie, cookie);
});
