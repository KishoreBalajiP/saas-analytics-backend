/**
 * onboarding (roadmap 3.6): self-service password change (current password
 * required), own sessions list/revoke (user-scoped), persisted notification
 * preferences honoured by the notification service, and registration consent.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import { shortToken } from '../../src/utils/id.js';
import * as tenantService from '../../src/services/tenant.service.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import notificationService from '../../src/services/notification.service.js';
import { User } from '../../src/models/User.js';
import { LEGAL_DOCUMENT_VERSION } from '../../src/constants/legal.js';

const PASSWORD = 'Password123!';

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => { await resetMongo(); await rbacCache.clearAll(); });
after(async () => { await stopHttp(); await stopMongo(); });

async function login(tenantId, email, password = PASSWORD) {
  return api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email, password } });
}

async function onboard() {
  const email = `owner-${shortToken(8).toLowerCase()}@example.com`;
  const { tenant } = await tenantService.create({ tenant: { name: `Prof ${shortToken(8)}` }, owner: { email, name: 'Owner', password: PASSWORD }, initialize: true, by: 'root' });
  const tenantId = tenant._id.toString();
  const res = await login(tenantId, email);
  assert.equal(res.status, 200);
  return { tenantId, email, auth: { authorization: `Bearer ${res.json.data.accessToken}`, 'X-Tenant-Id': tenantId } };
}

test('password change requires the current password and revokes other sessions', async () => {
  const { tenantId, email, auth } = await onboard();
  const second = await login(tenantId, email);
  const otherAuth = { authorization: `Bearer ${second.json.data.accessToken}`, 'X-Tenant-Id': tenantId };

  const missing = await api('/api/v1/users/me/password', { method: 'POST', headers: auth, body: { newPassword: 'NewPassword456!' } });
  assert.equal(missing.status, 422);
  const wrong = await api('/api/v1/users/me/password', { method: 'POST', headers: auth, body: { currentPassword: 'nope-nope', newPassword: 'NewPassword456!' } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.errors[0].field, 'currentPassword');

  const ok = await api('/api/v1/users/me/password', { method: 'POST', headers: auth, body: { currentPassword: PASSWORD, newPassword: 'NewPassword456!' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.data.sessionsRevoked, 1);
  assert.equal((await api('/api/v1/users/me', { headers: auth })).status, 200, 'the current session stays signed in');
  assert.equal((await api('/api/v1/users/me', { headers: otherAuth })).status, 401, 'other sessions are revoked');
  assert.equal((await login(tenantId, email)).status, 401);
  assert.equal((await login(tenantId, email, 'NewPassword456!')).status, 200);
});

test('profile updates go through PATCH /users/me', async () => {
  const { auth } = await onboard();
  const res = await api('/api/v1/users/me', { method: 'PATCH', headers: auth, body: { name: 'Renamed', timezone: 'Europe/Berlin' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.profile.name, 'Renamed');
});

test('sessions list and revoke are scoped to the caller', async () => {
  const a = await onboard();
  const b = await onboard();
  await login(a.tenantId, a.email);
  const list = await api('/api/v1/users/me/sessions', { headers: a.auth });
  assert.equal(list.status, 200);
  assert.equal(list.json.data.length, 2);
  assert.equal(list.json.data.filter((s) => s.current).length, 1);
  assert.ok(list.json.data.every((s) => s.refreshTokenHash === undefined));
  const other = list.json.data.find((s) => !s.current);

  // B cannot see or revoke A's sessions.
  assert.equal((await api(`/api/v1/users/me/sessions/${other.sessionId}`, { method: 'DELETE', headers: b.auth })).status, 404);
  assert.equal((await api('/api/v1/users/me/sessions', { headers: b.auth })).json.data.length, 1);

  assert.equal((await api(`/api/v1/users/me/sessions/${other.sessionId}`, { method: 'DELETE', headers: a.auth })).status, 204);
  assert.equal((await api('/api/v1/users/me/sessions', { headers: a.auth })).json.data.length, 1);
  assert.equal((await api('/api/v1/users/me/sessions')).status, 401);
});

test('notification preferences persist with typed keys and are honoured', async () => {
  const { tenantId, email, auth } = await onboard();
  const initial = await api('/api/v1/notifications/preferences', { headers: auth });
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.json.data.preferences, { in_app: true, email: true });

  const bad = await api('/api/v1/notifications/preferences', { method: 'POST', headers: auth, body: { preferences: { sms: true } } });
  assert.equal(bad.status, 400);

  const saved = await api('/api/v1/notifications/preferences', { method: 'POST', headers: auth, body: { preferences: { in_app: false, email: false } } });
  assert.equal(saved.status, 200);
  const again = await api('/api/v1/notifications/preferences', { headers: auth });
  assert.deepEqual(again.json.data.preferences, { in_app: false, email: false });

  const user = await User.findOne({ tenantId, email }).lean();
  const uid = String(user._id);
  assert.deepEqual(await notificationService.recipientsAccepting({ tenantId, userIds: [uid, 'someone-else'], channel: 'in_app' }), ['someone-else']);
  assert.deepEqual(await notificationService.emailsAccepting({ tenantId, emails: [email, 'outside@example.com'] }), ['outside@example.com']);
  // Another tenant's preferences are separate.
  assert.deepEqual(await notificationService.recipientsAccepting({ tenantId: 'other', userIds: [uid], channel: 'in_app' }), [uid]);
});

test('registration requires consent and records the accepted version', async () => {
  const body = { fullName: 'Ada Lovelace', email: `ada-${shortToken(8).toLowerCase()}@example.com`, password: PASSWORD, workspaceName: `Consent ${shortToken(8)}` };
  const refused = await api('/api/v1/auth/register', { method: 'POST', body: { ...body, acceptTerms: false } });
  assert.equal(refused.status, 422);
  const missing = await api('/api/v1/auth/register', { method: 'POST', body });
  assert.equal(missing.status, 422);
  const stale = await api('/api/v1/auth/register', { method: 'POST', body: { ...body, acceptTerms: true, termsVersion: 'old' } });
  assert.equal(stale.status, 409);

  const ok = await api('/api/v1/auth/register', { method: 'POST', body: { ...body, acceptTerms: true, termsVersion: LEGAL_DOCUMENT_VERSION } });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  const user = await User.findOne({ email: body.email }).lean();
  assert.equal(user.consent.termsVersion, LEGAL_DOCUMENT_VERSION);
  assert.ok(user.consent.acceptedAt instanceof Date);
});
