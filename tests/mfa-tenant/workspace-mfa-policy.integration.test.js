/**
 * Workspace "MFA required" policy and Owner-assisted member MFA reset
 * (roadmap 4.E1, mfa-tenant) over real HTTP: enrolment-only sessions,
 * refresh tightening, permissions, step-up, self/ceiling refusals, tenant
 * isolation and security events.
 */

import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import roleRepository from '../../src/repositories/role.repository.js';
import { Permission } from '../../src/models/Permission.js';
import { RolePermission } from '../../src/models/RolePermission.js';
import { UserRole } from '../../src/models/UserRole.js';
import { User } from '../../src/models/User.js';
import { Session } from '../../src/models/Session.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { verifyAccessToken } from '../../src/middleware/auth.middleware.js';
import {
  PASSWORD, login, signIn, onboard, addMember, enrollMfa, nextCode, resetTotpClock, restoreClock,
} from './helpers.js';

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => {
  await resetMongo();
  await rbacCache.clearAll();
  await cacheService.flushAll();
  resetTotpClock();
});
afterEach(() => restoreClock());
after(async () => { await stopHttp(); await stopMongo(); });

const POLICY = '/api/v1/workspace/security';

async function securityRows(tenantId, action) {
  return AuditLog.find({ category: 'security', tenantId, action }).lean();
}

/** Onboard, enrol the Owner and turn the policy on. */
async function workspaceWithPolicy() {
  const ws = await onboard();
  const ownerMfa = await enrollMfa(ws.ownerSession.auth);
  const on = await api(POLICY, { method: 'PATCH', headers: ws.ownerSession.auth, body: { mfaRequired: true } });
  assert.equal(on.status, 200, JSON.stringify(on.json));
  return { ...ws, ownerSecret: ownerMfa.secret };
}

/** Owner step-up (password + a fresh code). */
async function ownerStepUp(ws) {
  const res = await api('/api/v1/auth/step-up', {
    method: 'POST', headers: ws.ownerSession.auth, body: { password: PASSWORD, code: nextCode(ws.ownerSecret) },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
}

/* --------------------------------- policy --------------------------------- */

test('the Owner must have MFA before requiring it; the change is audited', async () => {
  const ws = await onboard();
  const initial = await api(POLICY, { headers: ws.ownerSession.auth });
  assert.equal(initial.status, 200);
  assert.equal(initial.json.data.mfaRequired, false);

  const refused = await api(POLICY, { method: 'PATCH', headers: ws.ownerSession.auth, body: { mfaRequired: true } });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, 'MFA_NOT_ENABLED');

  await enrollMfa(ws.ownerSession.auth);
  const on = await api(POLICY, { method: 'PATCH', headers: ws.ownerSession.auth, body: { mfaRequired: true } });
  assert.equal(on.status, 200);
  assert.equal(on.json.data.mfaRequired, true);
  assert.equal(on.json.data.members.mfaEnabled, 1);

  const invalid = await api(POLICY, { method: 'PATCH', headers: ws.ownerSession.auth, body: { mfaRequired: 'maybe' } });
  assert.ok([400, 422].includes(invalid.status));

  const rows = await securityRows(ws.tenantId, 'workspace.mfa_policy.changed');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tenantId, ws.tenantId);
});

test('only security.configure changes the policy; Admin may read it, Viewer may not', async () => {
  const ws = await onboard();
  const admin = await signIn(ws.tenantId, (await addMember(ws.tenantId, 'Admin')).email);
  const viewer = await signIn(ws.tenantId, (await addMember(ws.tenantId, 'Viewer')).email);

  assert.equal((await api(POLICY, { headers: admin.auth })).status, 200);
  assert.equal((await api(`${POLICY}/members`, { headers: admin.auth })).status, 200);
  assert.equal((await api(POLICY, { method: 'PATCH', headers: admin.auth, body: { mfaRequired: false } })).status, 403);
  assert.equal((await api(POLICY, { headers: viewer.auth })).status, 403);
  assert.equal((await api(`${POLICY}/members`, { headers: viewer.auth })).status, 403);
});

test('with the policy on, a member without MFA gets an enrolment-only session', async () => {
  const ws = await workspaceWithPolicy();
  const member = await addMember(ws.tenantId, 'Manager');

  const res = await login(ws.tenantId, member.email);
  assert.equal(res.status, 200);
  assert.equal(res.json.data.mfaEnrollmentRequired, true);
  const auth = { authorization: `Bearer ${res.json.data.accessToken}`, 'X-Tenant-Id': ws.tenantId };

  // Every ordinary route refuses the restricted session.
  for (const path of ['/api/v1/dashboards', '/api/v1/connectors', '/api/v1/users', '/api/v1/workspace/settings']) {
    const blocked = await api(path, { headers: auth });
    assert.equal(blocked.status, 403, path);
    assert.equal(blocked.json.code, 'MFA_ENROLLMENT_REQUIRED', path);
  }
  const stepUp = await api('/api/v1/auth/step-up', { method: 'POST', headers: auth, body: { password: PASSWORD } });
  assert.equal(stepUp.status, 403);
  // The Socket.IO handshake uses the same check.
  await assert.rejects(
    () => verifyAccessToken({ token: res.json.data.accessToken, audience: 'user' }),
    (err) => err.statusCode === 403 && err.code === 'MFA_ENROLLMENT_REQUIRED',
  );

  // The profile and the enrolment surface accept it.
  const me = await api('/api/v1/users/me', { headers: auth });
  assert.equal(me.status, 200);
  assert.equal(me.json.data.mfa.enrollmentRequired, true);
  assert.equal(me.json.data.mfa.required, true);
  assert.equal((await api('/api/v1/auth/me', { headers: auth })).status, 200);

  await enrollMfa(auth);
  // Enrolment lifts the restriction for this login.
  assert.equal((await api('/api/v1/dashboards', { headers: auth })).status, 200);
  const after = await api('/api/v1/users/me', { headers: auth });
  assert.equal(after.json.data.mfa.enrollmentRequired, false);

  assert.equal((await securityRows(ws.tenantId, 'auth.mfa.user_enrollment_enforced')).length, 1);
});

test('enrolling on one device revokes the other enrolment-only sessions', async () => {
  const ws = await workspaceWithPolicy();
  const member = await addMember(ws.tenantId, 'Viewer');
  const first = await login(ws.tenantId, member.email);
  const second = await login(ws.tenantId, member.email);
  const firstAuth = { authorization: `Bearer ${first.json.data.accessToken}`, 'X-Tenant-Id': ws.tenantId };
  const secondAuth = { authorization: `Bearer ${second.json.data.accessToken}`, 'X-Tenant-Id': ws.tenantId };
  await enrollMfa(firstAuth);
  assert.equal((await api('/api/v1/users/me', { headers: secondAuth })).status, 401);
  assert.equal((await api('/api/v1/users/me', { headers: firstAuth })).status, 200);
});

test('a refresh restricts an existing session once the policy requires MFA', async () => {
  const ws = await onboard();
  const member = await addMember(ws.tenantId, 'Viewer');
  const session = await signIn(ws.tenantId, member.email);
  await enrollMfa(ws.ownerSession.auth);
  assert.equal((await api(POLICY, { method: 'PATCH', headers: ws.ownerSession.auth, body: { mfaRequired: true } })).status, 200);

  const refreshed = await api('/api/v1/auth/refresh', { method: 'POST', cookies: [session.cookie] });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.json.data.mfaEnrollmentRequired, true);
  const auth = { authorization: `Bearer ${refreshed.json.data.accessToken}`, 'X-Tenant-Id': ws.tenantId };
  assert.equal((await api('/api/v1/dashboards', { headers: auth })).json.code, 'MFA_ENROLLMENT_REQUIRED');
});

test('disabling MFA while the policy requires it restricts every session of the member', async () => {
  const ws = await workspaceWithPolicy();
  const member = await addMember(ws.tenantId, 'Viewer');
  const restricted = await login(ws.tenantId, member.email);
  const auth = { authorization: `Bearer ${restricted.json.data.accessToken}`, 'X-Tenant-Id': ws.tenantId };
  const { secret } = await enrollMfa(auth);
  const res = await api('/api/v1/auth/mfa/disable', { method: 'POST', headers: auth, body: { password: PASSWORD, code: nextCode(secret) } });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.enrollmentRequired, true);
  assert.equal((await api('/api/v1/dashboards', { headers: auth })).json.code, 'MFA_ENROLLMENT_REQUIRED');
});

test('the policy of one workspace never applies to another', async () => {
  const a = await workspaceWithPolicy();
  const b = await onboard();
  const memberB = await addMember(b.tenantId, 'Viewer');
  const res = await login(b.tenantId, memberB.email);
  assert.equal(res.status, 200);
  assert.equal(res.json.data.mfaEnrollmentRequired, undefined);
  // The member list is per workspace.
  const list = await api(`${POLICY}/members`, { headers: a.ownerSession.auth });
  assert.equal(list.json.data.some((m) => m.email === memberB.email), false);
  // A token is bound to its workspace: another tenant header is refused.
  const cross = await api(POLICY, { headers: { ...a.ownerSession.auth, 'X-Tenant-Id': b.tenantId } });
  assert.ok([401, 403].includes(cross.status));
});

/* ------------------------------ Owner reset ------------------------------ */

test('the Owner resets a member: step-up first, sessions revoked, enrolment forced', async () => {
  const ws = await workspaceWithPolicy();
  const member = await addMember(ws.tenantId, 'Viewer');
  const restricted = await login(ws.tenantId, member.email);
  const memberAuth = { authorization: `Bearer ${restricted.json.data.accessToken}`, 'X-Tenant-Id': ws.tenantId };
  await enrollMfa(memberAuth);

  // Turn the policy off: the reset still forces enrolment for this member.
  assert.equal((await api(POLICY, { method: 'PATCH', headers: ws.ownerSession.auth, body: { mfaRequired: false } })).status, 200);

  const url = `${POLICY}/members/${member.id}/mfa/reset`;
  const noStepUp = await api(url, { method: 'POST', headers: ws.ownerSession.auth, body: { reason: 'lost phone' } });
  assert.equal(noStepUp.status, 403);
  assert.equal(noStepUp.json.code, 'STEP_UP_REQUIRED');

  await ownerStepUp(ws);
  const noReason = await api(url, { method: 'POST', headers: ws.ownerSession.auth, body: {} });
  assert.ok([400, 422].includes(noReason.status));

  const reset = await api(url, { method: 'POST', headers: ws.ownerSession.auth, body: { reason: 'lost phone' } });
  assert.equal(reset.status, 200, JSON.stringify(reset.json));
  assert.equal(reset.json.data.mfaEnrollmentRequired, true);
  assert.ok(reset.json.data.sessionsRevoked >= 1);
  assert.equal(JSON.stringify(reset.json).includes('"mfaSecret"'), false);

  const stored = await User.findById(member.id).select('+mfaSecret +mfaRecoveryCodes').lean();
  assert.equal(stored.mfaEnabled, false);
  assert.equal(stored.mfaSecret, null);
  assert.deepEqual(stored.mfaRecoveryCodes, []);
  assert.equal(await Session.countDocuments({ actorId: member.id, status: 'active' }), 0);
  assert.equal((await api('/api/v1/users/me', { headers: memberAuth })).status, 401);

  // Next sign-in: password only, but restricted to enrolment.
  const next = await login(ws.tenantId, member.email);
  assert.equal(next.status, 200);
  assert.equal(next.json.data.mfaEnrollmentRequired, true);

  const rows = await securityRows(ws.tenantId, 'auth.mfa.reset_by_owner');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actorId, ws.owner.id);
});

test('an Owner cannot reset their own MFA here', async () => {
  const ws = await workspaceWithPolicy();
  await ownerStepUp(ws);
  const res = await api(`${POLICY}/members/${ws.owner.id}/mfa/reset`, {
    method: 'POST', headers: ws.ownerSession.auth, body: { reason: 'self service' },
  });
  assert.equal(res.status, 403);
  assert.equal((await User.findById(ws.owner.id).lean()).mfaEnabled, true);
  const denied = await securityRows(ws.tenantId, 'auth.mfa.reset_denied');
  assert.equal(denied.length, 1);
  assert.equal(denied[0].metadata.why, 'self');
  assert.equal(denied[0].result, 'failure');
});

test('a member of another workspace cannot be reset (404)', async () => {
  const a = await workspaceWithPolicy();
  const b = await onboard();
  const memberB = await addMember(b.tenantId, 'Viewer');
  await enrollMfa((await signIn(b.tenantId, memberB.email)).auth);
  await ownerStepUp(a);
  const res = await api(`${POLICY}/members/${memberB.id}/mfa/reset`, {
    method: 'POST', headers: a.ownerSession.auth, body: { reason: 'cross tenant' },
  });
  assert.equal(res.status, 404);
  assert.equal((await User.findById(memberB.id).lean()).mfaEnabled, true);
});

test('Admins cannot reset member MFA, and a custom security role cannot reset the Owner', async () => {
  const ws = await workspaceWithPolicy();
  const victim = await addMember(ws.tenantId, 'Viewer');

  // Admin: no security.configure.
  const adminMember = await addMember(ws.tenantId, 'Admin');
  const adminLogin = await login(ws.tenantId, adminMember.email);
  const adminAuth = { authorization: `Bearer ${adminLogin.json.data.accessToken}`, 'X-Tenant-Id': ws.tenantId };
  const adminSecret = (await enrollMfa(adminAuth)).secret;
  const adminDenied = await api(`${POLICY}/members/${victim.id}/mfa/reset`, { method: 'POST', headers: adminAuth, body: { reason: 'try' } });
  assert.equal(adminDenied.status, 403);

  // A custom role holding only security.* (plus nothing else the Owner lacks).
  const role = await roleRepository.create({ tenantId: ws.tenantId, name: 'SecOps', level: 'tenant', isSystem: false });
  for (const key of ['security.view', 'security.configure']) {
    const perm = await Permission.findOne({ key }).lean();
    assert.ok(perm, `${key} is seeded`);
    await new RolePermission({ roleId: String(role._id), permissionId: String(perm._id) }).save();
  }
  await new UserRole({ tenantId: ws.tenantId, userId: adminMember.id, roleId: String(role._id), grantedAt: new Date() }).save();
  await rbacCache.clearAll();

  await api('/api/v1/auth/step-up', { method: 'POST', headers: adminAuth, body: { password: PASSWORD, code: nextCode(adminSecret) } });
  const ceiling = await api(`${POLICY}/members/${ws.owner.id}/mfa/reset`, { method: 'POST', headers: adminAuth, body: { reason: 'escalate' } });
  assert.equal(ceiling.status, 403);
  assert.equal((await User.findById(ws.owner.id).lean()).mfaEnabled, true);
  // Within the ceiling (a Viewer) the same actor may reset.
  const allowed = await api(`${POLICY}/members/${victim.id}/mfa/reset`, { method: 'POST', headers: adminAuth, body: { reason: 'lost phone' } });
  assert.equal(allowed.status, 200);
});

test('member MFA status lists every member without secrets', async () => {
  const ws = await workspaceWithPolicy();
  const member = await addMember(ws.tenantId, 'Viewer');
  const list = await api(`${POLICY}/members`, { headers: ws.ownerSession.auth });
  assert.equal(list.status, 200);
  const owner = list.json.data.find((m) => m.id === ws.owner.id);
  const viewer = list.json.data.find((m) => m.id === member.id);
  assert.equal(owner.mfaEnabled, true);
  assert.equal(viewer.mfaEnabled, false);
  const body = JSON.stringify(list.json);
  assert.equal(body.includes('"mfaSecret"'), false);
  assert.equal(body.includes('passwordHash'), false);
});
