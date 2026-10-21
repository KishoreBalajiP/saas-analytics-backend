/**
 * Per-route auth rate limits (roadmap 1.9, auth.06 / sec.11).
 *
 * The test runner disables the auth limiters (10000/window). This file runs
 * in its own process and sets SMALL limits BEFORE the app is imported, so
 * the real configured limiters on the real routes are exercised:
 *   - each strict route returns a typed 429 with `Retry-After`
 *   - login is keyed by IP + account (another account is unaffected) with a
 *     per-IP ceiling across accounts
 *   - refresh has its own bucket (per IP + session cookie): exhausting it
 *     never blocks login, password reset or another session on the same IP
 *   - the tenant and admin portals never share a bucket
 *
 * Buckets live for the whole process, so every test acts as its own client
 * IP (`X-Forwarded-For`, honoured through the default TRUST_PROXY=1).
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_RATE_LIMIT_LOGIN_MAX = '3';
process.env.AUTH_RATE_LIMIT_LOGIN_IP_MAX = '8';
process.env.AUTH_RATE_LIMIT_REFRESH_MAX = '4';
process.env.AUTH_RATE_LIMIT_PASSWORD_MAX = '2';
process.env.AUTH_RATE_LIMIT_INVITATION_MAX = '2';
process.env.AUTH_RATE_LIMIT_MFA_MAX = '2';
process.env.AUTH_RATE_LIMIT_VERIFICATION_MAX = '2';
process.env.AUTH_RATE_LIMIT_REGISTER_MAX = '2';

const { startMongo, stopMongo, resetMongo } = await import('./helpers/mongo.js');
const { startHttp, stopHttp, api: rawApi } = await import('./helpers/http.js');
const { factories } = await import('./helpers/factories.js');

let clientIp = '203.0.113.1';
let ipCounter = 1;
/** Every request of the current test comes from `clientIp`. */
const api = (path, opts = {}) =>
  rawApi(path, { ...opts, headers: { 'X-Forwarded-For': clientIp, ...(opts.headers ?? {}) } });

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => {
  await resetMongo();
  ipCounter += 1;
  clientIp = `203.0.113.${ipCounter}`;
});
after(async () => { await stopHttp(); await stopMongo(); });

/** Assert the typed 429 contract. */
function assertRateLimited(res, label) {
  assert.equal(res.status, 429, `${label}: expected 429, got ${res.status}`);
  assert.equal(res.json.code, 'RATE_LIMITED', label);
  assert.equal(res.json.success, false, label);
  const retryAfter = Number(res.headers.get('retry-after'));
  assert.ok(Number.isFinite(retryAfter) && retryAfter > 0, `${label}: Retry-After header`);
  assert.ok(res.json.meta.retryAfterSeconds > 0, `${label}: meta.retryAfterSeconds`);
}

const tenantLogin = (tenantId, email, password = 'WrongPassword1!') =>
  api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email, password } });

test('login: 429 with Retry-After after the per-account limit; other accounts and the admin portal are unaffected', async () => {
  const tenant = await factories.tenant.create();
  const victim = await factories.user.create({ tenantId: tenant._id.toString() });
  const other = await factories.user.create({ tenantId: tenant._id.toString() });
  const tenantId = tenant._id.toString();

  for (let i = 0; i < 3; i += 1) assert.equal((await tenantLogin(tenantId, victim.email)).status, 401);
  assertRateLimited(await tenantLogin(tenantId, victim.email), 'login (same account)');

  // Keyed by IP + account: a different account from the same IP still works.
  assert.equal((await tenantLogin(tenantId, other.email, 'Password123!')).status, 200);

  // The admin portal has its own buckets.
  const admin = await factories.admin.create();
  const adminRes = await api('/api/v1/admin-auth/login', { method: 'POST', body: { email: admin.email, password: 'Password123!' } });
  assert.equal(adminRes.status, 200);
});

test('login: a per-IP ceiling applies across accounts', async () => {
  const tenant = await factories.tenant.create();
  const tenantId = tenant._id.toString();
  // 8 attempts per IP across distinct accounts, each below its own limit.
  for (let i = 0; i < 8; i += 1) {
    assert.equal((await tenantLogin(tenantId, `nobody-${i}@example.com`)).status, 401);
  }
  assertRateLimited(await tenantLogin(tenantId, 'nobody-9@example.com'), 'login (per IP)');
});

test('refresh has its own bucket: exhausting it never blocks login or password reset', async () => {
  const tenant = await factories.tenant.create();
  const user = await factories.user.create({ tenantId: tenant._id.toString() });
  for (let i = 0; i < 4; i += 1) {
    assert.equal((await api('/api/v1/auth/refresh', { method: 'POST' })).status, 401);
  }
  assertRateLimited(await api('/api/v1/auth/refresh', { method: 'POST' }), 'refresh');

  assert.equal((await tenantLogin(tenant._id.toString(), user.email, 'Password123!')).status, 200);
  const forgot = await api('/api/v1/auth/password/forgot', {
    method: 'POST', headers: { 'X-Tenant-Id': tenant._id.toString() }, body: { email: user.email },
  });
  assert.equal(forgot.status, 200);
});

test('refresh is keyed by IP + session: one browser exhausting its budget does not block another behind the same IP', async () => {
  const refresh = (cookie) => api('/api/v1/auth/refresh', { method: 'POST', cookies: [cookie] });
  // Unknown tokens still count toward their own bucket.
  for (let i = 0; i < 4; i += 1) assert.equal((await refresh('saas_session=browser-one')).status, 401);
  assertRateLimited(await refresh('saas_session=browser-one'), 'refresh (same session)');
  assert.equal((await refresh('saas_session=browser-two')).status, 401, 'another session has its own budget');

  // The admin portal's refresh bucket is separate as well.
  const adminRefresh = await api('/api/v1/admin-auth/refresh', {
    method: 'POST', cookies: ['saas_admin_session=browser-one'],
  });
  assert.equal(adminRefresh.status, 401);
});

test('password forgot and reset are limited', async () => {
  const tenant = await factories.tenant.create();
  const tenantId = tenant._id.toString();
  const forgot = () => api('/api/v1/auth/password/forgot', {
    method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email: 'someone@example.com' },
  });
  for (let i = 0; i < 2; i += 1) assert.equal((await forgot()).status, 200);
  assertRateLimited(await forgot(), 'password/forgot');

  const reset = () => api('/api/v1/auth/password/reset', {
    method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { token: 'not-a-token', newPassword: 'LongEnough123!' },
  });
  for (let i = 0; i < 2; i += 1) assert.notEqual((await reset()).status, 429);
  assertRateLimited(await reset(), 'password/reset');

  const adminForgot = () => api('/api/v1/admin-auth/password/forgot', { method: 'POST', body: { email: 'ops@example.com' } });
  for (let i = 0; i < 2; i += 1) assert.equal((await adminForgot()).status, 200);
  assertRateLimited(await adminForgot(), 'admin password/forgot');
});

test('invitation preview/accept and email verification resend are limited', async () => {
  const preview = () => api('/api/v1/invitations/preview?token=not-a-real-token-value-1234567890');
  for (let i = 0; i < 2; i += 1) assert.notEqual((await preview()).status, 429);
  assertRateLimited(await preview(), 'invitations/preview');
  // Accept shares the invitation bucket (one flow).
  assertRateLimited(
    await api('/api/v1/invitations/accept', { method: 'POST', body: { token: 'x', name: 'X', password: 'LongEnough123!' } }),
    'invitations/accept',
  );

  const tenant = await factories.tenant.create();
  // Distinct emails: the service's own per-account cooldown never triggers,
  // so the 429 comes from the per-IP limiter.
  const resend = (i) => api('/api/v1/auth/resend-verification', {
    method: 'POST', headers: { 'X-Tenant-Id': tenant.slug }, body: { email: `pending-${i}@example.com` },
  });
  for (let i = 0; i < 2; i += 1) assert.equal((await resend(i)).status, 200);
  assertRateLimited(await resend(3), 'resend-verification');
});

test('registration and email verification are limited, each in its own bucket', async () => {
  // Invalid bodies are enough: the limiter runs before validation, so no
  // workspace is created and every attempt still counts.
  const register = () => api('/api/v1/auth/register', { method: 'POST', body: {} });
  for (let i = 0; i < 2; i += 1) assert.notEqual((await register()).status, 429);
  assertRateLimited(await register(), 'register');

  const verify = () => api('/api/v1/auth/verify-email', { method: 'POST', body: { token: 'not-a-real-token' } });
  for (let i = 0; i < 2; i += 1) assert.notEqual((await verify()).status, 429, 'verify-email has its own bucket');
  assertRateLimited(await verify(), 'verify-email');
});

test('admin MFA calls are limited per admin', async () => {
  const admin = await factories.admin.create();
  const login = await api('/api/v1/admin-auth/login', { method: 'POST', body: { email: admin.email, password: 'Password123!' } });
  assert.equal(login.status, 200);
  const headers = { authorization: `Bearer ${login.json.data.accessToken}` };
  const verify = () => api('/api/v1/admin-auth/mfa/verify', { method: 'POST', headers, body: { code: '000000' } });
  for (let i = 0; i < 2; i += 1) assert.notEqual((await verify()).status, 429);
  assertRateLimited(await verify(), 'admin mfa');
});
