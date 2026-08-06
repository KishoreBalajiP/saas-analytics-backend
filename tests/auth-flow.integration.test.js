/**
 * Tenant-portal authentication flow - end-to-end HTTP integration tests.
 *
 * WHY IT EXISTS
 *   Proves the whole `/api/v1/auth` stack works together: route wiring,
 *   tenant resolution, validation, rate limiting, login, session liveness on
 *   `/me`, refresh-token rotation + replay family revocation, and logout.
 *
 * DESIGN
 *   - Real Express app on an ephemeral port + real in-memory MongoDB.
 *   - The refresh token is exercised through the HttpOnly cookie (the primary
 *     transport) exactly as a browser would send it back.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
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
const GENERIC = 'Invalid email or password';

/** Create a real tenant + an active user under it. */
async function seedUser(overrides = {}) {
  const tenant = await factories.tenant.create();
  const user = await factories.user.create({ tenantId: tenant._id.toString(), ...overrides });
  return { tenant, user };
}

function loginAs(email, password, { tenantId, body = {} } = {}) {
  const headers = tenantId ? { 'X-Tenant-Id': tenantId } : {};
  return api(`${BASE}/login`, {
    method: 'POST',
    headers,
    body: { email, password, ...body },
  });
}

/* ------------------------------- login ---------------------------------- */

test('login issues an access token, refresh token, session and cookie', async () => {
  const { tenant, user } = await seedUser();
  const res = await loginAs(user.email, PASSWORD, { tenantId: tenant._id.toString() });

  assert.equal(res.status, 200);
  assert.equal(res.json.success, true);
  assert.equal(typeof res.json.data.accessToken, 'string');
  assert.ok(res.json.data.accessToken.length > 50, 'access token should be a compact JWT');
  assert.equal(typeof res.json.data.refreshToken, 'string');
  assert.ok(res.json.data.refreshToken.length >= 32, 'refresh token should be opaque');
  assert.equal(typeof res.json.data.sessionId, 'string');
  assert.equal(res.json.data.expiresIn, 15 * 60);
  assert.equal(res.json.data.actor.email, user.email);
  assert.equal(res.json.data.actor.status, 'active');
  assert.ok(res.setCookie.some((c) => c.startsWith('saas_session=')), 'sets the HttpOnly cookie');
});

test('login rejects a wrong password with a generic message', async () => {
  const { tenant, user } = await seedUser();
  const res = await loginAs(user.email, 'WrongPassword1!', { tenantId: tenant._id.toString() });

  assert.equal(res.status, 401);
  assert.equal(res.json.message, GENERIC);
});

test('login rejects an unknown email with the same generic message (no enumeration)', async () => {
  const { tenant } = await seedUser();
  const res = await loginAs('nobody@example.com', PASSWORD, { tenantId: tenant._id.toString() });

  assert.equal(res.status, 401);
  assert.equal(res.json.message, GENERIC);
});

test('login requires a tenant header (fail closed)', async () => {
  const { user } = await seedUser();
  const res = await loginAs(user.email, PASSWORD, {});

  assert.equal(res.status, 400);
  assert.equal(res.json.message, 'Tenant id is required');
});

test('login rejects a suspended user with 403', async () => {
  const { tenant, user } = await seedUser({ status: 'suspended' });
  const res = await loginAs(user.email, PASSWORD, { tenantId: tenant._id.toString() });

  assert.equal(res.status, 403);
  assert.equal(res.json.message, 'Account is suspended');
});

test('repeated failed logins lock the account, then even valid credentials are rejected', async () => {
  const { tenant, user } = await seedUser();
  const tenantId = tenant._id.toString();

  for (let i = 0; i < 5; i += 1) {
    const res = await loginAs(user.email, 'WrongPassword1!', { tenantId });
    assert.equal(res.status, 401);
  }

  const res = await loginAs(user.email, PASSWORD, { tenantId });
  assert.equal(res.status, 429);
  assert.match(res.json.message, /Too many failed attempts/);
});

/* -------------------------------- /me ------------------------------------ */

test('GET /me returns the live profile for a valid token + session', async () => {
  const { tenant, user } = await seedUser();
  const login = await loginAs(user.email, PASSWORD, { tenantId: tenant._id.toString() });

  const me = await api(`${BASE}/me`, {
    headers: { authorization: `Bearer ${login.json.data.accessToken}` },
  });

  assert.equal(me.status, 200);
  assert.equal(me.json.data.id, user._id.toString());
  assert.equal(me.json.data.email, user.email);
  assert.equal(me.json.data.name, 'Test User');
  assert.equal(me.json.data.status, 'active');
  assert.equal(me.json.data.tenantId, tenant._id.toString());
});

test('GET /me without a token is rejected with 401', async () => {
  const res = await api(`${BASE}/me`);
  assert.equal(res.status, 401);
});

test('GET /me is rejected once the session is revoked', async () => {
  const { tenant, user } = await seedUser();
  const login = await loginAs(user.email, PASSWORD, { tenantId: tenant._id.toString() });
  const accessToken = login.json.data.accessToken;
  const cookie = refreshCookieFrom(login);

  const logout = await api(`${BASE}/logout`, { method: 'POST', cookies: [cookie] });
  assert.equal(logout.status, 200);

  const me = await api(`${BASE}/me`, { headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(me.status, 401);
});

/* ------------------------------- refresh --------------------------------- */

test('refresh rotates the token; replaying the old token revokes the whole family', async () => {
  const { tenant, user } = await seedUser();
  const login = await loginAs(user.email, PASSWORD, { tenantId: tenant._id.toString() });
  const oldCookie = refreshCookieFrom(login);
  const oldAccessToken = login.json.data.accessToken;
  const oldRefreshToken = login.json.data.refreshToken;

  // Rotate: new session + new tokens.
  const refreshed = await api(`${BASE}/refresh`, { method: 'POST', cookies: [oldCookie] });
  assert.equal(refreshed.status, 200);
  const newCookie = refreshCookieFrom(refreshed);
  assert.ok(newCookie, 'refresh re-sets the cookie');
  assert.notEqual(newCookie, oldCookie, 'the cookie value must change');
  assert.notEqual(refreshed.json.data.refreshToken, oldRefreshToken);
  assert.notEqual(refreshed.json.data.sessionId, login.json.data.sessionId);

  // The new access token works.
  const meOk = await api(`${BASE}/me`, {
    headers: { authorization: `Bearer ${refreshed.json.data.accessToken}` },
  });
  assert.equal(meOk.status, 200);

  // Replaying the OLD (rotated) token is an attack -> family revoked.
  const replay = await api(`${BASE}/refresh`, { method: 'POST', cookies: [oldCookie] });
  assert.equal(replay.status, 401);
  assert.equal(replay.json.message, 'Session revoked');

  // The NEW token is dead too (family revocation), and the access token too.
  const afterReplay = await api(`${BASE}/refresh`, { method: 'POST', cookies: [newCookie] });
  assert.equal(afterReplay.status, 401);
  const meDead = await api(`${BASE}/me`, {
    headers: { authorization: `Bearer ${oldAccessToken}` },
  });
  assert.equal(meDead.status, 401);
});

test('refresh with an unknown token is rejected as an expired session', async () => {
  const res = await api(`${BASE}/refresh`, {
    method: 'POST',
    body: { refreshToken: 'not-a-real-token' },
  });
  assert.equal(res.status, 401);
  assert.equal(res.json.message, 'Session expired');
});

/* ------------------------------- logout ---------------------------------- */

test('logout revokes the session and invalidates the refresh token', async () => {
  const { tenant, user } = await seedUser();
  const login = await loginAs(user.email, PASSWORD, { tenantId: tenant._id.toString() });
  const cookie = refreshCookieFrom(login);

  const logout = await api(`${BASE}/logout`, { method: 'POST', cookies: [cookie] });
  assert.equal(logout.status, 200);
  assert.equal(logout.json.data.ok, true);

  const refresh = await api(`${BASE}/refresh`, { method: 'POST', cookies: [cookie] });
  assert.equal(refresh.status, 401);
  assert.equal(refresh.json.message, 'Session revoked');
});
