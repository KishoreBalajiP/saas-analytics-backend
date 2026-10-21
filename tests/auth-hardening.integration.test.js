/**
 * Auth and session hardening (roadmap 1.9, 1.12, auth.14) - HTTP integration.
 *
 * Proves, over real HTTP against an in-memory MongoDB:
 *   - login/refresh never return the refresh token or session id in the
 *     body, on either portal; each portal has its own cookie name and path;
 *     refresh refuses the other portal's session; the legacy shared cookie
 *     still works once and is then cleared
 *   - logout revokes the session named by the bearer token when no cookie
 *     is sent (and reports whether anything was revoked)
 *   - lockout decays: after the lockout window, one wrong password does not
 *     re-lock; the full allowance applies again
 *   - two concurrent refreshes with one token both succeed without forking
 *     the session or revoking the family; a lagging duplicate inside the
 *     reuse grace joins the successor, while reuse after the grace, two
 *     rotations back, after logout, or with the grace disabled is a replay
 *   - absolute session lifetime survives rotation and is enforced at refresh
 *   - suspending a user, a tenant or an admin blocks an existing access
 *     token on the next request (even with the status cache warm)
 *   - idempotent replay: same key -> original response and one side effect;
 *     different body -> 422; keys never collide across tenants or actors;
 *     stored responses are encrypted at rest
 */

import test, { before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import env from '../src/config/env.js';
import { startMongo, stopMongo, resetMongo } from './helpers/mongo.js';
import { startHttp, stopHttp, api, refreshCookieFrom } from './helpers/http.js';
import { factories } from './helpers/factories.js';
import * as emailService from '../src/services/email.service.js';
import tenantService from '../src/services/tenant.service.js';
import invitationService from '../src/services/tenantInvitation.service.js';
import userRepository from '../src/repositories/user.repository.js';
import tenantRepository from '../src/repositories/tenant.repository.js';
import adminRepository from '../src/repositories/admin.repository.js';
import sessionRepository from '../src/repositories/session.repository.js';
import cacheService from '../src/services/cache.service.js';
import { scopedKey } from '../src/utils/idempotency.js';
import { Session } from '../src/models/Session.js';
import { User } from '../src/models/User.js';
import { Admin } from '../src/models/Admin.js';
import { ApiKey } from '../src/models/ApiKey.js';
// billing: tenants exercising paid features need a plan that includes them.
import { entitleTenant } from './helpers/billing.js';

const PASSWORD = 'Hardening123!';
const FACTORY_PASSWORD = 'Password123!';
const DAY_MS = 24 * 60 * 60 * 1000;

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => { await resetMongo(); await cacheService.flushAll(); });
after(async () => { await emailService.close(); await stopHttp(); await stopMongo(); });

/* -------------------------------- helpers -------------------------------- */

async function captureInviteToken(fn) {
  const sink = [];
  emailService.captureInto(sink);
  try {
    await fn();
  } finally {
    emailService.stopCapture();
  }
  const link = sink.map((m) => m.text).join('\n').match(/https?:\/\/[^\s]+/u)?.[0];
  return link ? new URL(link).searchParams.get('token') : null;
}

async function tenantLogin(slug, email, password = PASSWORD) {
  const res = await api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'X-Tenant-Id': slug },
    body: { email, password },
  });
  assert.equal(res.status, 200, `login should succeed: ${JSON.stringify(res.json)}`);
  return res;
}

/** An initialised workspace whose owner has accepted and signed in. */
async function workspace() {
  const email = `owner-${randomBytes(4).toString('hex')}@example.com`;
  let result;
  const token = await captureInviteToken(async () => {
    result = await tenantService.create({
      tenant: { name: `Hardening ${randomBytes(3).toString('hex')}` },
      owner: { email, name: 'Owner' },
      initialize: true,
      by: 'platform-admin',
    });
  });
  await invitationService.accept({ token, name: 'Owner', password: PASSWORD });
  await entitleTenant(result.tenant._id, 'enterprise');
  const login = await tenantLogin(result.tenant.slug, email);
  const user = await User.findOne({ tenantId: String(result.tenant._id), email }).lean();
  return {
    tenant: result.tenant,
    slug: result.tenant.slug,
    email,
    user,
    login,
    auth: { authorization: `Bearer ${login.json.data.accessToken}` },
    cookie: refreshCookieFrom(login, 'saas_session'),
  };
}

/** Add an active member with a default role and sign them in. */
async function member(ws, roleName) {
  const email = `${roleName.toLowerCase()}-${randomBytes(4).toString('hex')}@example.com`;
  const token = await captureInviteToken(() => invitationService.create({
    tenantId: String(ws.tenant._id), email, name: roleName, roleName, invitedBy: 'platform-admin',
  }));
  await invitationService.accept({ token, name: roleName, password: PASSWORD });
  const login = await tenantLogin(ws.slug, email);
  const user = await User.findOne({ tenantId: String(ws.tenant._id), email }).lean();
  return { email, user, auth: { authorization: `Bearer ${login.json.data.accessToken}` } };
}

/** A tenant + active user from factories (cheaper than a full workspace). */
async function seedUser() {
  const tenant = await factories.tenant.create();
  const user = await factories.user.create({ tenantId: tenant._id.toString() });
  return { tenant, user };
}

async function adminLogin(admin, password = FACTORY_PASSWORD) {
  return api('/api/v1/admin-auth/login', { method: 'POST', body: { email: admin.email, password } });
}

const cookieValue = (pair) => pair.slice(pair.indexOf('=') + 1);

/* ---------------------------- token transport ---------------------------- */

test('both portals: login and refresh bodies carry no refresh token or session id, and use distinct cookies', async () => {
  const { tenant, user } = await seedUser();
  const admin = await factories.admin.create();

  const tenantLoginRes = await tenantLogin(tenant._id.toString(), user.email, FACTORY_PASSWORD);
  const adminLoginRes = await adminLogin(admin);
  assert.equal(adminLoginRes.status, 200);

  for (const res of [tenantLoginRes, adminLoginRes]) {
    assert.deepEqual(Object.keys(res.json.data).sort(), ['accessToken', 'actor', 'expiresIn', 'sessionExpiresAt']);
  }
  const tenantCookieLine = tenantLoginRes.setCookie.find((c) => c.startsWith('saas_session='));
  const adminCookieLine = adminLoginRes.setCookie.find((c) => c.startsWith('saas_admin_session='));
  assert.match(tenantCookieLine, /Path=\/api\/v1\/auth(;|$)/);
  assert.match(adminCookieLine, /Path=\/api\/v1\/admin-auth(;|$)/);
  assert.match(tenantCookieLine, /HttpOnly/i);
  assert.match(adminCookieLine, /HttpOnly/i);

  // Both sessions live side by side: signing into one did not replace the other.
  const tenantRefresh = await api('/api/v1/auth/refresh', {
    method: 'POST', cookies: [refreshCookieFrom(tenantLoginRes, 'saas_session')],
  });
  const adminRefresh = await api('/api/v1/admin-auth/refresh', {
    method: 'POST', cookies: [refreshCookieFrom(adminLoginRes, 'saas_admin_session')],
  });
  assert.equal(tenantRefresh.status, 200);
  assert.equal(adminRefresh.status, 200);
  for (const res of [tenantRefresh, adminRefresh]) {
    assert.deepEqual(Object.keys(res.json.data).sort(), ['accessToken', 'actor', 'expiresIn', 'sessionExpiresAt']);
  }
  assert.ok(refreshCookieFrom(tenantRefresh, 'saas_session'));
  assert.ok(refreshCookieFrom(adminRefresh, 'saas_admin_session'));
});

test('refresh refuses a session issued by the other portal without revoking it', async () => {
  const { tenant, user } = await seedUser();
  const admin = await factories.admin.create();
  const tenantRes = await tenantLogin(tenant._id.toString(), user.email, FACTORY_PASSWORD);
  const adminRes = await adminLogin(admin);
  const tenantToken = cookieValue(refreshCookieFrom(tenantRes, 'saas_session'));
  const adminToken = cookieValue(refreshCookieFrom(adminRes, 'saas_admin_session'));

  const crossToAdmin = await api('/api/v1/admin-auth/refresh', {
    method: 'POST', cookies: [`saas_admin_session=${tenantToken}`],
  });
  assert.equal(crossToAdmin.status, 401);
  assert.equal(crossToAdmin.json.code, 'SESSION_EXPIRED');

  const crossToTenant = await api('/api/v1/auth/refresh', {
    method: 'POST', cookies: [`saas_session=${adminToken}`],
  });
  assert.equal(crossToTenant.status, 401);

  // Neither family was revoked by the mismatch.
  const okTenant = await api('/api/v1/auth/refresh', { method: 'POST', cookies: [`saas_session=${tenantToken}`] });
  const okAdmin = await api('/api/v1/admin-auth/refresh', { method: 'POST', cookies: [`saas_admin_session=${adminToken}`] });
  assert.equal(okTenant.status, 200);
  assert.equal(okAdmin.status, 200);
});

test('an admin session in the legacy shared cookie refreshes once and the legacy cookie is cleared', async () => {
  const admin = await factories.admin.create();
  const res = await adminLogin(admin);
  const adminToken = cookieValue(refreshCookieFrom(res, 'saas_admin_session'));

  const refreshed = await api('/api/v1/admin-auth/refresh', {
    method: 'POST', cookies: [`saas_session=${adminToken}`],
  });
  assert.equal(refreshed.status, 200);
  assert.ok(refreshCookieFrom(refreshed, 'saas_admin_session'), 'moves to the admin cookie');
  assert.ok(
    refreshed.setCookie.some((c) => /^saas_session=;/.test(c) && /Path=\/(;|$)/.test(c)),
    'clears the legacy path=/ cookie',
  );
});

test('refresh without any cookie reports SESSION_COOKIE_MISSING', async () => {
  const res = await api('/api/v1/auth/refresh', { method: 'POST' });
  assert.equal(res.status, 401);
  assert.equal(res.json.code, 'SESSION_COOKIE_MISSING');
});

/* --------------------------- concurrent refresh -------------------------- */

/**
 * Make the next `n` refresh-token lookups wait for each other, so every
 * request reads the session while it is still active (a real race between
 * two tabs), whatever the event-loop scheduling.
 */
function barrierOnSessionLookup(t, n = 2) {
  const original = sessionRepository.findByRefreshTokenHash;
  const waiting = [];
  mock.method(sessionRepository, 'findByRefreshTokenHash', async (hash) => {
    const doc = await original(hash);
    await new Promise((resolve) => {
      waiting.push(resolve);
      if (waiting.length === n) waiting.forEach((release) => release());
    });
    return doc;
  });
  t.after(() => mock.restoreAll());
}

test('two concurrent refreshes with one token both succeed, rotate once and keep the family', async (t) => {
  const { tenant, user } = await seedUser();
  const login = await tenantLogin(tenant._id.toString(), user.email, FACTORY_PASSWORD);
  const cookie = refreshCookieFrom(login, 'saas_session');
  const firstSession = await Session.findOne({ actorId: String(user._id), status: 'active' }).lean();

  barrierOnSessionLookup(t, 2);
  const [a, b] = await Promise.all([
    api('/api/v1/auth/refresh', { method: 'POST', cookies: [cookie] }),
    api('/api/v1/auth/refresh', { method: 'POST', cookies: [cookie] }),
  ]);
  mock.restoreAll();

  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(b.status, 200, JSON.stringify(b.json));
  const newCookies = [a, b].map((res) => refreshCookieFrom(res, 'saas_session')).filter(Boolean);
  assert.equal(newCookies.length, 1, 'only the winning response sets a new refresh cookie');

  // No fork: one live session, which replaced the original.
  const live = await Session.find({ actorId: String(user._id), status: 'active' }).lean();
  assert.equal(live.length, 1);
  const predecessor = await Session.findOne({ sessionId: firstSession.sessionId }).lean();
  assert.equal(predecessor.revokedReason, 'rotated');
  assert.equal(predecessor.replacedBy, live[0].sessionId);
  assert.equal(
    await Session.countDocuments({ actorId: String(user._id), revokedReason: 'replay_detected' }),
    0,
    'the family was not revoked',
  );

  // Both responses carry working access tokens, bound to the one live session.
  for (const res of [a, b]) {
    const me = await api('/api/v1/auth/me', { headers: { authorization: `Bearer ${res.json.data.accessToken}` } });
    assert.equal(me.status, 200);
    assert.equal(res.json.data.sessionExpiresAt, new Date(live[0].expiresAt).toISOString());
  }

  // The browser's cookie (the winner's) keeps working.
  const next = await api('/api/v1/auth/refresh', { method: 'POST', cookies: [newCookies[0]] });
  assert.equal(next.status, 200);
});

/** Pretend the rotation of `sessionId` happened `msAgo` milliseconds ago. */
async function ageRotation(sessionId, msAgo) {
  await Session.updateOne({ sessionId }, { $set: { revokedAt: new Date(Date.now() - msAgo) } });
}

test('a token reused just after its rotation (lagging second tab) joins the successor: no new cookie, no revocation', async () => {
  const { tenant, user } = await seedUser();
  const login = await tenantLogin(tenant._id.toString(), user.email, FACTORY_PASSWORD);
  const cookie = refreshCookieFrom(login, 'saas_session');
  const first = await Session.findOne({ actorId: String(user._id), status: 'active' }).lean();

  const rotated = await api('/api/v1/auth/refresh', { method: 'POST', cookies: [cookie] });
  assert.equal(rotated.status, 200);
  const successorCookie = refreshCookieFrom(rotated, 'saas_session');
  const successor = await Session.findOne({ actorId: String(user._id), status: 'active' }).lean();

  // The second tab's request left with the old cookie and arrives after the
  // rotation completed (inside AUTH_REFRESH_REUSE_GRACE_MS).
  const lagging = await api('/api/v1/auth/refresh', { method: 'POST', cookies: [cookie] });
  assert.equal(lagging.status, 200, JSON.stringify(lagging.json));
  assert.equal(refreshCookieFrom(lagging, 'saas_session'), null, 'the browser keeps the successor cookie');
  assert.deepEqual(Object.keys(lagging.json.data).sort(), ['accessToken', 'actor', 'expiresIn', 'sessionExpiresAt']);
  assert.equal(lagging.json.data.sessionExpiresAt, new Date(successor.expiresAt).toISOString());

  // No second rotation, nothing revoked, and the access token is bound to the successor.
  const live = await Session.find({ actorId: String(user._id), status: 'active' }).lean();
  assert.deepEqual(live.map((s) => s.sessionId), [successor.sessionId]);
  assert.equal((await Session.findOne({ sessionId: first.sessionId }).lean()).replacedBy, successor.sessionId);
  const me = await api('/api/v1/auth/me', { headers: { authorization: `Bearer ${lagging.json.data.accessToken}` } });
  assert.equal(me.status, 200);
  assert.equal((await api('/api/v1/auth/refresh', { method: 'POST', cookies: [successorCookie] })).status, 200);
});

test('reusing a rotated token after the grace window is a replay and revokes every session', async () => {
  const { tenant, user } = await seedUser();
  const login = await tenantLogin(tenant._id.toString(), user.email, FACTORY_PASSWORD);
  const cookie = refreshCookieFrom(login, 'saas_session');
  const first = await Session.findOne({ actorId: String(user._id), status: 'active' }).lean();
  const rotated = await api('/api/v1/auth/refresh', { method: 'POST', cookies: [cookie] });
  assert.equal(rotated.status, 200);

  await ageRotation(first.sessionId, 60 * 1000);
  const replay = await api('/api/v1/auth/refresh', { method: 'POST', cookies: [cookie] });
  assert.equal(replay.status, 401);
  assert.equal(replay.json.code, 'SESSION_REVOKED');
  assert.equal(await Session.countDocuments({ actorId: String(user._id), status: 'active' }), 0);
  const successorRefresh = await api('/api/v1/auth/refresh', {
    method: 'POST', cookies: [refreshCookieFrom(rotated, 'saas_session')],
  });
  assert.equal(successorRefresh.status, 401, 'the whole family is gone');
});

test('with the reuse grace disabled (0), immediate reuse of a rotated token is a replay', async (t) => {
  const previous = env.security.auth.refreshReuseGraceMs;
  env.security.auth.refreshReuseGraceMs = 0;
  t.after(() => { env.security.auth.refreshReuseGraceMs = previous; });

  const { tenant, user } = await seedUser();
  const login = await tenantLogin(tenant._id.toString(), user.email, FACTORY_PASSWORD);
  const cookie = refreshCookieFrom(login, 'saas_session');
  assert.equal((await api('/api/v1/auth/refresh', { method: 'POST', cookies: [cookie] })).status, 200);
  const replay = await api('/api/v1/auth/refresh', { method: 'POST', cookies: [cookie] });
  assert.equal(replay.status, 401);
  assert.equal(replay.json.code, 'SESSION_REVOKED');
  assert.equal(await Session.countDocuments({ actorId: String(user._id), status: 'active' }), 0);
});

test('the grace follows one rotation only: a token two rotations old is a replay', async () => {
  const { tenant, user } = await seedUser();
  const login = await tenantLogin(tenant._id.toString(), user.email, FACTORY_PASSWORD);
  const original = refreshCookieFrom(login, 'saas_session');
  const once = await api('/api/v1/auth/refresh', { method: 'POST', cookies: [original] });
  const twice = await api('/api/v1/auth/refresh', {
    method: 'POST', cookies: [refreshCookieFrom(once, 'saas_session')],
  });
  assert.equal(twice.status, 200);

  const stale = await api('/api/v1/auth/refresh', { method: 'POST', cookies: [original] });
  assert.equal(stale.status, 401);
  assert.equal(stale.json.code, 'SESSION_REVOKED');
  assert.equal(await Session.countDocuments({ actorId: String(user._id), status: 'active' }), 0);
});

test('the grace never revives a session that ended by logout', async () => {
  const { tenant, user } = await seedUser();
  const login = await tenantLogin(tenant._id.toString(), user.email, FACTORY_PASSWORD);
  const cookie = refreshCookieFrom(login, 'saas_session');
  assert.equal((await api('/api/v1/auth/logout', { method: 'POST', cookies: [cookie] })).json.data.revoked, true);
  const res = await api('/api/v1/auth/refresh', { method: 'POST', cookies: [cookie] });
  assert.equal(res.status, 401);
  assert.equal(res.json.code, 'SESSION_REVOKED');
});

test('a lagging duplicate is refused once the account is suspended', async () => {
  const { tenant, user } = await seedUser();
  const login = await tenantLogin(tenant._id.toString(), user.email, FACTORY_PASSWORD);
  const cookie = refreshCookieFrom(login, 'saas_session');
  assert.equal((await api('/api/v1/auth/refresh', { method: 'POST', cookies: [cookie] })).status, 200);

  await userRepository.suspend(user._id, tenant._id.toString(), 'test');
  const res = await api('/api/v1/auth/refresh', { method: 'POST', cookies: [cookie] });
  assert.equal(res.status, 401);
  assert.equal(res.json.code, 'SESSION_REVOKED');
  assert.equal(await Session.countDocuments({ actorId: String(user._id), status: 'active' }), 0);
});

/* --------------------------------- logout -------------------------------- */

test('tenant logout with only a bearer token revokes that session', async () => {
  const { tenant, user } = await seedUser();
  const login = await tenantLogin(tenant._id.toString(), user.email, FACTORY_PASSWORD);
  const authorization = `Bearer ${login.json.data.accessToken}`;
  const cookie = refreshCookieFrom(login, 'saas_session');

  const logout = await api('/api/v1/auth/logout', { method: 'POST', headers: { authorization } });
  assert.equal(logout.status, 200);
  assert.equal(logout.json.data.revoked, true);

  const me = await api('/api/v1/auth/me', { headers: { authorization } });
  assert.equal(me.status, 401);
  // The refresh token of that session is dead as well.
  const refresh = await api('/api/v1/auth/refresh', { method: 'POST', cookies: [cookie] });
  assert.equal(refresh.status, 401);
});

test('admin logout with only a bearer token revokes that session', async () => {
  const admin = await factories.admin.create();
  const login = await adminLogin(admin);
  const authorization = `Bearer ${login.json.data.accessToken}`;

  const logout = await api('/api/v1/admin-auth/logout', { method: 'POST', headers: { authorization } });
  assert.equal(logout.status, 200);
  assert.equal(logout.json.data.revoked, true);
  const me = await api('/api/v1/admin-auth/me', { headers: { authorization } });
  assert.equal(me.status, 401);
});

test('logout with a cookie that was already rotated ends the live session of that login', async () => {
  const { tenant, user } = await seedUser();
  const login = await tenantLogin(tenant._id.toString(), user.email, FACTORY_PASSWORD);
  const original = refreshCookieFrom(login, 'saas_session');
  // The rotation happened, but its response (new cookie) never reached the client.
  const rotated = await api('/api/v1/auth/refresh', { method: 'POST', cookies: [original] });
  assert.equal(rotated.status, 200);

  const logout = await api('/api/v1/auth/logout', { method: 'POST', cookies: [original] });
  assert.equal(logout.status, 200);
  assert.equal(logout.json.data.revoked, true);
  assert.equal(await Session.countDocuments({ actorId: String(user._id), status: 'active' }), 0);
  const successor = await api('/api/v1/auth/refresh', {
    method: 'POST', cookies: [refreshCookieFrom(rotated, 'saas_session')],
  });
  assert.equal(successor.status, 401);
});

test('logout with no credentials says nothing was revoked', async () => {
  const res = await api('/api/v1/auth/logout', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.revoked, false);
});

/* ------------------------------ lockout decay ---------------------------- */

async function wrongLogin(tenantId, email) {
  return api('/api/v1/auth/login', {
    method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email, password: 'WrongPassword1!' },
  });
}

test('one wrong password after the lockout window does not re-lock the account', async () => {
  const { tenant, user } = await seedUser();
  const tenantId = tenant._id.toString();
  for (let i = 0; i < 5; i += 1) assert.equal((await wrongLogin(tenantId, user.email)).status, 401);
  const locked = await api('/api/v1/auth/login', {
    method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email: user.email, password: FACTORY_PASSWORD },
  });
  assert.equal(locked.status, 429);

  // The lockout window passes.
  await User.updateOne({ _id: user._id }, { $set: { lockedUntil: new Date(Date.now() - 1000) } });

  const oneWrong = await wrongLogin(tenantId, user.email);
  assert.equal(oneWrong.status, 401, 'a single mistake is a normal failure, not a new lockout');
  const after = await User.findById(user._id).lean();
  assert.equal(after.failedAttempts, 1, 'the counter restarted');
  assert.equal(after.lockedUntil, null);

  const ok = await api('/api/v1/auth/login', {
    method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email: user.email, password: FACTORY_PASSWORD },
  });
  assert.equal(ok.status, 200);
});

test('after the lockout window, 4 wrong passwords do not re-lock and the 5th does', async () => {
  const { tenant, user } = await seedUser();
  const tenantId = tenant._id.toString();
  await User.updateOne(
    { _id: user._id },
    { $set: { failedAttempts: 5, lockedUntil: new Date(Date.now() - 1000) } },
  );
  for (let i = 0; i < 4; i += 1) assert.equal((await wrongLogin(tenantId, user.email)).status, 401);
  const stillOpen = await User.findById(user._id).lean();
  assert.equal(stillOpen.failedAttempts, 4);
  assert.ok(!stillOpen.lockedUntil || new Date(stillOpen.lockedUntil).getTime() <= Date.now());

  assert.equal((await wrongLogin(tenantId, user.email)).status, 401);
  const relocked = await User.findById(user._id).lean();
  assert.ok(new Date(relocked.lockedUntil).getTime() > Date.now(), 'the 5th failure locks again');
});

test('admin portal: one wrong password after the lockout window does not re-lock', async () => {
  const admin = await factories.admin.create();
  const wrongAdmin = () => api('/api/v1/admin-auth/login', {
    method: 'POST', body: { email: admin.email, password: 'WrongPassword1!' },
  });
  for (let i = 0; i < 5; i += 1) assert.equal((await wrongAdmin()).status, 401);
  assert.equal((await adminLogin(admin)).status, 429, 'locked');

  await Admin.updateOne({ _id: admin._id }, { $set: { lockedUntil: new Date(Date.now() - 1000) } });
  assert.equal((await wrongAdmin()).status, 401);
  const after = await Admin.findById(admin._id).lean();
  assert.equal(after.failedAttempts, 1, 'the counter restarted');
  assert.equal((await adminLogin(admin)).status, 200);
});

test('concurrent wrong passwords after the lockout window reset the counter once and re-lock', async () => {
  const { tenant, user } = await seedUser();
  const tenantId = tenant._id.toString();
  await User.updateOne(
    { _id: user._id },
    { $set: { failedAttempts: 5, lockedUntil: new Date(Date.now() - 1000) } },
  );
  // Every request read the expired lockout; only one of them may reset it,
  // so all six failures count and the allowance is not multiplied.
  const results = await Promise.all(Array.from({ length: 6 }, () => wrongLogin(tenantId, user.email)));
  for (const res of results) assert.equal(res.status, 401);
  const after = await User.findById(user._id).lean();
  assert.equal(after.failedAttempts, 6);
  assert.ok(new Date(after.lockedUntil).getTime() > Date.now(), 'locked again');
});

test('the expired-lockout reset never clears a lockout that is in force', async () => {
  const { user } = await seedUser();
  const until = new Date(Date.now() + 60 * 1000);
  await User.updateOne({ _id: user._id }, { $set: { failedAttempts: 5, lockedUntil: until } });
  // A request holding a stale read (lock already expired) tries to reset.
  assert.equal(await userRepository.clearExpiredLockout(user._id), null);
  const still = await User.findById(user._id).lean();
  assert.equal(still.failedAttempts, 5);
  assert.equal(new Date(still.lockedUntil).getTime(), until.getTime());

  const admin = await factories.admin.create();
  await Admin.updateOne({ _id: admin._id }, { $set: { failedAttempts: 5, lockedUntil: until } });
  assert.equal(await adminRepository.clearExpiredLockout(admin._id), null);
  assert.equal((await Admin.findById(admin._id).lean()).failedAttempts, 5);
});

/* --------------------------- absolute lifetime --------------------------- */

test('rotation keeps the family and sign-in time; expiry never passes the absolute lifetime', async () => {
  const { tenant, user } = await seedUser();
  const login = await tenantLogin(tenant._id.toString(), user.email, FACTORY_PASSWORD);
  const first = await Session.findOne({ actorId: String(user._id), status: 'active' }).lean();
  assert.ok(first.authenticatedAt);
  assert.equal(first.familyId, first.sessionId);

  // Pretend the login happened 29 days ago: the successor may live 1 more day only.
  const signedIn = new Date(Date.now() - 29 * DAY_MS);
  await Session.updateOne({ sessionId: first.sessionId }, { $set: { authenticatedAt: signedIn } });
  const refreshed = await api('/api/v1/auth/refresh', { method: 'POST', cookies: [refreshCookieFrom(login, 'saas_session')] });
  assert.equal(refreshed.status, 200);

  const next = await Session.findOne({ actorId: String(user._id), status: 'active' }).lean();
  assert.notEqual(next.sessionId, first.sessionId);
  assert.equal(next.familyId, first.sessionId, 'same family');
  assert.equal(new Date(next.authenticatedAt).getTime(), signedIn.getTime(), 'sign-in time carried forward');
  const deadline = signedIn.getTime() + 30 * DAY_MS;
  assert.ok(new Date(next.expiresAt).getTime() <= deadline, 'capped at the absolute lifetime');
  assert.equal(refreshed.json.data.sessionExpiresAt, new Date(next.expiresAt).toISOString());
  const maxAge = Number(/Max-Age=(\d+)/i.exec(refreshed.setCookie.find((c) => c.startsWith('saas_session=') && !/^saas_session=;/.test(c)))[1]);
  assert.ok(maxAge <= DAY_MS / 1000 + 5, `cookie lifetime follows the capped expiry (${maxAge}s)`);
});

test('refresh past the absolute session lifetime fails even though the session is active', async () => {
  const { tenant, user } = await seedUser();
  const login = await tenantLogin(tenant._id.toString(), user.email, FACTORY_PASSWORD);
  const session = await Session.findOne({ actorId: String(user._id), status: 'active' }).lean();
  // The sliding expiry is still in the future, but the login is 31 days old.
  await Session.updateOne(
    { sessionId: session.sessionId },
    { $set: { authenticatedAt: new Date(Date.now() - 31 * DAY_MS), expiresAt: new Date(Date.now() + DAY_MS) } },
  );
  const res = await api('/api/v1/auth/refresh', { method: 'POST', cookies: [refreshCookieFrom(login, 'saas_session')] });
  assert.equal(res.status, 401);
  assert.equal(res.json.code, 'SESSION_EXPIRED');
  assert.equal((await Session.findOne({ sessionId: session.sessionId }).lean()).status, 'expired');
});

/* -------------------- status re-check on every request -------------------- */

test('suspending a user blocks their existing access token on the next request', async () => {
  const { tenant, user } = await seedUser();
  const login = await tenantLogin(tenant._id.toString(), user.email, FACTORY_PASSWORD);
  const headers = { authorization: `Bearer ${login.json.data.accessToken}` };
  assert.equal((await api('/api/v1/auth/me', { headers })).status, 200, 'warms the status cache');

  await userRepository.suspend(user._id, tenant._id.toString(), 'test');
  const blocked = await api('/api/v1/auth/me', { headers });
  assert.equal(blocked.status, 401);
  assert.equal(blocked.json.code, 'ACCOUNT_SUSPENDED');

  // Restoring the account restores access (no stale negative cache).
  await userRepository.restore(user._id, tenant._id.toString(), 'test');
  assert.equal((await api('/api/v1/auth/me', { headers })).status, 200);
});

test('suspending a tenant blocks its users\' existing access tokens on the next request', async () => {
  const { tenant, user } = await seedUser();
  const login = await tenantLogin(tenant._id.toString(), user.email, FACTORY_PASSWORD);
  const headers = { authorization: `Bearer ${login.json.data.accessToken}` };
  assert.equal((await api('/api/v1/users/me', { headers })).status, 200);

  await tenantRepository.suspend(tenant._id, { by: 'test', reason: 'test' });
  const blocked = await api('/api/v1/users/me', { headers });
  assert.equal(blocked.status, 401);
  assert.equal(blocked.json.code, 'TENANT_NOT_ACTIVE');
});

test('suspending an admin blocks their existing access token on the next request', async () => {
  const admin = await factories.admin.create();
  const login = await adminLogin(admin);
  const headers = { authorization: `Bearer ${login.json.data.accessToken}` };
  assert.equal((await api('/api/v1/admin-auth/me', { headers })).status, 200);

  await adminRepository.suspend(admin._id, 'test');
  const blocked = await api('/api/v1/admin-auth/me', { headers });
  assert.equal(blocked.status, 401);
  assert.equal(blocked.json.code, 'ACCOUNT_SUSPENDED');
});

/* ------------------------------- idempotency ------------------------------ */

const API_KEY_BODY = { name: 'ci', scopes: ['datasets:read'] };

function createKey(auth, idempotencyKey, body = API_KEY_BODY) {
  return api('/api/v1/api-keys', {
    method: 'POST',
    headers: { ...auth, ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}) },
    body,
  });
}

test('idempotent replay returns the original response and runs the side effect once', async () => {
  const ws = await workspace();
  const key = `idem-${randomBytes(6).toString('hex')}`;

  const first = await createKey(ws.auth, key);
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.equal(first.headers.get('x-idempotent-replay'), null);

  const replay = await createKey(ws.auth, key);
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get('x-idempotent-replay'), 'true');
  assert.deepEqual(replay.json, first.json, 'the original response is replayed');
  assert.equal(await ApiKey.countDocuments({ tenantId: String(ws.tenant._id) }), 1, 'one key created');

  // Without the header nothing is replayed (opt-in).
  const plain = await createKey(ws.auth, null);
  assert.equal(plain.status, 201);
  assert.equal(await ApiKey.countDocuments({ tenantId: String(ws.tenant._id) }), 2);
});

test('concurrent duplicates with one key create one record', async () => {
  const ws = await workspace();
  const key = `idem-${randomBytes(6).toString('hex')}`;
  const [a, b] = await Promise.all([createKey(ws.auth, key), createKey(ws.auth, key)]);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.deepEqual(a.json.data, b.json.data);
  assert.equal(await ApiKey.countDocuments({ tenantId: String(ws.tenant._id) }), 1);
});

test('reusing a key with a different body is refused', async () => {
  const ws = await workspace();
  const key = `idem-${randomBytes(6).toString('hex')}`;
  assert.equal((await createKey(ws.auth, key)).status, 201);
  const reused = await createKey(ws.auth, key, { name: 'other', scopes: ['datasets:read'] });
  assert.equal(reused.status, 422);
  assert.equal(reused.json.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(await ApiKey.countDocuments({ tenantId: String(ws.tenant._id) }), 1);
});

test('an invalid idempotency key is rejected before the handler runs', async () => {
  const ws = await workspace();
  const res = await createKey(ws.auth, 'x'.repeat(300));
  assert.equal(res.status, 400);
  assert.equal(res.json.code, 'IDEMPOTENCY_KEY_INVALID');
  assert.equal(await ApiKey.countDocuments({ tenantId: String(ws.tenant._id) }), 0);
});

test('idempotency keys never collide across tenants or across actors in one tenant', async () => {
  const a = await workspace();
  const b = await workspace();
  const colleague = await member(a, 'Admin');
  const key = 'shared-client-key-1';

  const fromA = await createKey(a.auth, key);
  const fromB = await createKey(b.auth, key);
  const fromColleague = await createKey(colleague.auth, key);
  for (const res of [fromA, fromB, fromColleague]) {
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.headers.get('x-idempotent-replay'), null, 'nobody receives another actor\'s response');
  }
  const ids = new Set([fromA, fromB, fromColleague].map((r) => r.json.data.key.id ?? r.json.data.key._id));
  assert.equal(ids.size, 3);
  assert.equal(await ApiKey.countDocuments({ tenantId: String(a.tenant._id) }), 2);
  assert.equal(await ApiKey.countDocuments({ tenantId: String(b.tenant._id) }), 1);
});

test('an admin reusing one idempotency key against two tenants gets two separate results', async () => {
  const admin = await factories.admin.create();
  const login = await adminLogin(admin);
  assert.equal(login.status, 200);
  const auth = { authorization: `Bearer ${login.json.data.accessToken}` };
  // Same admin, same method, same path, same body: only the targeted
  // workspace differs. The client key must not replay across tenants.
  const send = (tenantId) => api('/api/v1/admin-auth/mfa/enroll', {
    method: 'POST',
    headers: { ...auth, 'X-Tenant-Id': tenantId, 'X-Idempotency-Key': 'admin-shared-key' },
  });
  const first = await send('tenant-a');
  const second = await send('tenant-b');
  const again = await send('tenant-a');
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.headers.get('x-idempotent-replay'), null);
  assert.notEqual(second.headers.get('x-idempotent-replay'), 'true', 'no replay across tenants');
  assert.equal(again.headers.get('x-idempotent-replay'), 'true', 'same tenant replays');
  assert.deepEqual(again.json, first.json);
});

test('stored idempotent responses are encrypted at rest', async () => {
  const ws = await workspace();
  const key = `idem-${randomBytes(6).toString('hex')}`;
  const first = await createKey(ws.auth, key);
  assert.equal(first.status, 201);

  const storageKey = scopedKey({
    scope: { actorType: 'user', actorId: String(ws.user._id), tenantId: String(ws.tenant._id) },
    method: 'POST',
    path: '/api/v1/api-keys',
    clientKey: key,
  });
  const stored = await cacheService.get(`idempotency:${storageKey}`);
  assert.ok(stored, 'the outcome is stored under the actor + tenant scoped key');
  assert.equal(stored.encrypted, true);
  assert.equal(stored.body.includes(first.json.data.secret), false, 'the one-time secret is not stored in clear');
});
