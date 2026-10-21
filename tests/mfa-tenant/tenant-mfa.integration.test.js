/**
 * Tenant-user MFA (roadmap 4.E1, mfa-tenant) over real HTTP: enrolment,
 * login challenge, recovery codes, disable with step-up, TOTP replay,
 * step-up lockout and the security events they emit.
 */

import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import { User } from '../../src/models/User.js';
import { Session } from '../../src/models/Session.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { hashRecoveryCode } from '../../src/utils/recoveryCodes.js';
import {
  PASSWORD, login, signIn, onboard, addMember, enrollMfa, nextCode, sameCode, resetTotpClock, restoreClock,
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

async function securityActions(tenantId) {
  const rows = await AuditLog.find({ category: 'security', tenantId }).lean();
  return rows.map((row) => row.action);
}

/* ------------------------------- enrolment ------------------------------- */

test('enrolment is two-step; the secret is stored encrypted and recovery codes hashed', async () => {
  const { tenantId } = await onboard();
  const member = await addMember(tenantId, 'Viewer');
  const { auth } = await signIn(tenantId, member.email);

  const start = await api('/api/v1/auth/mfa/enroll', { method: 'POST', headers: auth });
  assert.equal(start.status, 200);
  assert.equal(start.headers.get('cache-control'), 'no-store');
  const { secret, otpauthUrl } = start.json.data;
  assert.match(otpauthUrl, /^otpauth:\/\/totp\//);

  // Pending: MFA still off and the stored secret is an encrypted envelope.
  let stored = await User.findById(member.id).select('+mfaSecret +mfaRecoveryCodes').lean();
  assert.equal(stored.mfaEnabled, false);
  assert.ok(stored.mfaSecret && stored.mfaSecret !== secret && !stored.mfaSecret.includes(secret));

  const wrong = await api('/api/v1/auth/mfa/verify', { method: 'POST', headers: auth, body: { code: '000000' } });
  assert.equal(wrong.status, 400);

  const verify = await api('/api/v1/auth/mfa/verify', { method: 'POST', headers: auth, body: { code: nextCode(secret) } });
  assert.equal(verify.status, 200);
  assert.equal(verify.headers.get('cache-control'), 'no-store');
  const codes = verify.json.data.recoveryCodes;
  assert.equal(codes.length, 10);
  assert.equal(verify.json.data.enabled, true);

  stored = await User.findById(member.id).select('+mfaSecret +mfaRecoveryCodes').lean();
  assert.equal(stored.mfaEnabled, true);
  assert.equal(stored.mfaRecoveryCodes.length, 10);
  for (const code of codes) {
    assert.equal(stored.mfaRecoveryCodes.includes(code), false, 'plaintext code never stored');
    assert.ok(stored.mfaRecoveryCodes.includes(hashRecoveryCode(code)), 'digest stored');
  }

  // Re-enrolment (which would silently switch MFA off) is refused.
  const again = await api('/api/v1/auth/mfa/enroll', { method: 'POST', headers: auth });
  assert.equal(again.status, 409);

  // Profile reports MFA without any secret material; listings neither.
  const me = await api('/api/v1/users/me', { headers: auth });
  assert.equal(me.status, 200);
  assert.equal(me.json.data.mfa.enabled, true);
  assert.equal(me.json.data.mfa.recoveryCodesRemaining, 10);
  const body = JSON.stringify(me.json);
  assert.equal(body.includes('"mfaSecret"'), false);
  assert.equal(body.includes('"mfaRecoveryCodes"'), false);
  assert.equal(body.includes('"mfaLastTimeStep"'), false);
  assert.equal(body.includes(secret), false);

  const events = await securityActions(tenantId);
  assert.ok(events.includes('auth.mfa.enrollment_started'));
  assert.ok(events.includes('auth.mfa.enrolled'));
});

test('MFA endpoints require a tenant bearer token (admin tokens are refused)', async () => {
  const res = await api('/api/v1/auth/mfa/enroll', { method: 'POST' });
  assert.equal(res.status, 401);
  const stepUp = await api('/api/v1/auth/step-up', { method: 'POST', body: { password: PASSWORD } });
  assert.equal(stepUp.status, 401);
});

/* ---------------------------- login challenge ---------------------------- */

test('login requires the second factor once MFA is on, and a code works only once', async () => {
  const { tenantId } = await onboard();
  const member = await addMember(tenantId, 'Viewer');
  const { auth } = await signIn(tenantId, member.email);
  const { secret } = await enrollMfa(auth);

  const missing = await login(tenantId, member.email);
  assert.equal(missing.status, 401);
  assert.equal(missing.json.code, 'MFA_REQUIRED');
  assert.equal(missing.json.data?.accessToken, undefined);

  const wrong = await login(tenantId, member.email, { mfaToken: '123456' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.message, 'Invalid email or password');
  assert.equal((await User.findById(member.id).lean()).failedAttempts, 1, 'a wrong code counts as a failed login');

  // Wrong password with a valid code stays generic.
  const code = nextCode(secret);
  const badPassword = await login(tenantId, member.email, { password: 'Nope12345!', mfaToken: code });
  assert.equal(badPassword.status, 401);

  const ok = await login(tenantId, member.email, { mfaToken: code });
  assert.equal(ok.status, 200);
  assert.equal(typeof ok.json.data.accessToken, 'string');
  assert.equal((await User.findById(member.id).lean()).failedAttempts, 0);

  // The same code (same time step) cannot be replayed.
  const replay = await login(tenantId, member.email, { mfaToken: sameCode(secret) });
  assert.equal(replay.status, 401);
});

test('a recovery code signs in exactly once and is stored only as a digest', async () => {
  const { tenantId } = await onboard();
  const member = await addMember(tenantId, 'Viewer');
  const { auth } = await signIn(tenantId, member.email);
  const { recoveryCodes } = await enrollMfa(auth);

  // Case, spaces and dashes are ignored.
  const typed = recoveryCodes[0].toLowerCase().replace(/-/g, ' ');
  const first = await login(tenantId, member.email, { recoveryCode: typed });
  assert.equal(first.status, 200);
  assert.equal(first.json.data.recoveryCodesRemaining, 9);

  const second = await login(tenantId, member.email, { recoveryCode: recoveryCodes[0] });
  assert.equal(second.status, 401);

  const stored = await User.findById(member.id).select('+mfaRecoveryCodes').lean();
  assert.equal(stored.mfaRecoveryCodes.length, 9);
  assert.equal(stored.mfaRecoveryCodes.includes(hashRecoveryCode(recoveryCodes[0])), false);

  assert.ok((await securityActions(tenantId)).includes('auth.mfa.recovery_code_used'));
});

test('a recovery code from another member, or another workspace, never works', async () => {
  const a = await onboard();
  const b = await onboard();
  const memberA = await addMember(a.tenantId, 'Viewer');
  const otherA = await addMember(a.tenantId, 'Viewer');
  const memberB = await addMember(b.tenantId, 'Viewer');
  await enrollMfa((await signIn(a.tenantId, memberA.email)).auth);
  const { recoveryCodes: codesOther } = await enrollMfa((await signIn(a.tenantId, otherA.email)).auth);
  const { recoveryCodes: codesB } = await enrollMfa((await signIn(b.tenantId, memberB.email)).auth);

  assert.equal((await login(a.tenantId, memberA.email, { recoveryCode: codesOther[0] })).status, 401);
  assert.equal((await login(a.tenantId, memberA.email, { recoveryCode: codesB[0] })).status, 401);
  // The owners' codes stay unused.
  assert.equal((await login(a.tenantId, otherA.email, { recoveryCode: codesOther[0] })).status, 200);
});

/* --------------------------------- disable -------------------------------- */

test('disabling MFA requires the password AND a current code (step-up)', async () => {
  const { tenantId } = await onboard();
  const member = await addMember(tenantId, 'Viewer');
  const { auth } = await signIn(tenantId, member.email);
  const { secret, recoveryCodes } = await enrollMfa(auth);

  const noCode = await api('/api/v1/auth/mfa/disable', { method: 'POST', headers: auth, body: { password: PASSWORD } });
  assert.equal(noCode.status, 400);

  const wrongPassword = await api('/api/v1/auth/mfa/disable', {
    method: 'POST', headers: auth, body: { password: 'WrongPass1!', code: nextCode(secret) },
  });
  assert.equal(wrongPassword.status, 403);
  assert.equal(wrongPassword.json.code, 'STEP_UP_FAILED');
  // The recovery code is only spent after the password is proven.
  const wrongPasswordRecovery = await api('/api/v1/auth/mfa/disable', {
    method: 'POST', headers: auth, body: { password: 'WrongPass1!', recoveryCode: recoveryCodes[1] },
  });
  assert.equal(wrongPasswordRecovery.status, 403);
  assert.equal((await User.findById(member.id).select('+mfaRecoveryCodes').lean()).mfaRecoveryCodes.length, 10);

  const wrongCode = await api('/api/v1/auth/mfa/disable', {
    method: 'POST', headers: auth, body: { password: PASSWORD, code: '000000' },
  });
  assert.equal(wrongCode.status, 403);
  assert.equal((await User.findById(member.id).lean()).mfaEnabled, true, 'still on after refused attempts');

  const ok = await api('/api/v1/auth/mfa/disable', {
    method: 'POST', headers: auth, body: { password: PASSWORD, code: nextCode(secret) },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.data.enabled, false);
  assert.equal(ok.json.data.enrollmentRequired, false);
  const stored = await User.findById(member.id).select('+mfaSecret +mfaRecoveryCodes').lean();
  assert.equal(stored.mfaEnabled, false);
  assert.equal(stored.mfaSecret, null);
  assert.deepEqual(stored.mfaRecoveryCodes, []);

  // Password-only login works again.
  assert.equal((await login(tenantId, member.email)).status, 200);
  const events = await securityActions(tenantId);
  assert.ok(events.includes('auth.mfa.disable_failed'));
  assert.ok(events.includes('auth.mfa.disabled'));
});

/* ------------------------- step-up and recovery codes ------------------------- */

test('regenerating recovery codes needs a fresh step-up and voids the old codes', async () => {
  const { tenantId } = await onboard();
  const member = await addMember(tenantId, 'Viewer');
  const { auth } = await signIn(tenantId, member.email);
  const { secret, recoveryCodes } = await enrollMfa(auth);

  const noStepUp = await api('/api/v1/auth/mfa/recovery-codes', { method: 'POST', headers: auth });
  assert.equal(noStepUp.status, 403);
  assert.equal(noStepUp.json.code, 'STEP_UP_REQUIRED');

  const passwordOnly = await api('/api/v1/auth/step-up', { method: 'POST', headers: auth, body: { password: PASSWORD } });
  assert.equal(passwordOnly.status, 400, 'a member with MFA must present a code');

  const stepUp = await api('/api/v1/auth/step-up', { method: 'POST', headers: auth, body: { password: PASSWORD, code: nextCode(secret) } });
  assert.equal(stepUp.status, 200);
  assert.ok(Date.parse(stepUp.json.data.stepUpExpiresAt) > Date.now());

  const me = await api('/api/v1/users/me', { headers: auth });
  assert.ok(me.json.data.mfa.stepUpExpiresAt);

  const regen = await api('/api/v1/auth/mfa/recovery-codes', { method: 'POST', headers: auth });
  assert.equal(regen.status, 200);
  assert.equal(regen.json.data.recoveryCodes.length, 10);
  assert.equal(regen.headers.get('cache-control'), 'no-store');

  assert.equal((await login(tenantId, member.email, { recoveryCode: recoveryCodes[0] })).status, 401, 'old codes are void');
  assert.equal((await login(tenantId, member.email, { recoveryCode: regen.json.data.recoveryCodes[0] })).status, 200);
  const events = await securityActions(tenantId);
  assert.ok(events.includes('auth.mfa.user_recovery_codes_regenerated'));
  assert.ok(events.includes('auth.step_up.user_succeeded'));
});

test('step-up is bound to the session that performed it', async () => {
  const { tenantId } = await onboard();
  const member = await addMember(tenantId, 'Viewer');
  const first = await signIn(tenantId, member.email);
  const { secret } = await enrollMfa(first.auth);
  const second = await signIn(tenantId, member.email, { mfaToken: nextCode(secret) });

  const stepUp = await api('/api/v1/auth/step-up', { method: 'POST', headers: first.auth, body: { password: PASSWORD, code: nextCode(secret) } });
  assert.equal(stepUp.status, 200);
  const other = await api('/api/v1/auth/mfa/recovery-codes', { method: 'POST', headers: second.auth });
  assert.equal(other.status, 403);
  assert.equal(other.json.code, 'STEP_UP_REQUIRED');
});

test('repeated step-up failures lock the account and revoke its sessions', async () => {
  const { tenantId } = await onboard();
  const member = await addMember(tenantId, 'Viewer');
  const { auth } = await signIn(tenantId, member.email);
  await enrollMfa(auth);

  for (let i = 0; i < 5; i += 1) {
    const res = await api('/api/v1/auth/step-up', { method: 'POST', headers: auth, body: { password: 'WrongPass1!', code: '000000' } });
    if (i < 4) assert.equal(res.status, 403);
  }
  const user = await User.findById(member.id).lean();
  assert.ok(user.lockedUntil && new Date(user.lockedUntil) > new Date(), 'account locked');
  const live = await Session.countDocuments({ actorId: member.id, status: 'active' });
  assert.equal(live, 0, 'every session revoked');
  const after = await api('/api/v1/users/me', { headers: auth });
  assert.equal(after.status, 401);
  const events = await securityActions(tenantId);
  assert.ok(events.includes('auth.step_up.user_failed'));
  assert.ok(events.includes('auth.lockout'));
});

test('a member without MFA steps up with the password alone (outside the policy)', async () => {
  const { tenantId } = await onboard();
  const member = await addMember(tenantId, 'Viewer');
  const { auth } = await signIn(tenantId, member.email);
  const res = await api('/api/v1/auth/step-up', { method: 'POST', headers: auth, body: { password: PASSWORD } });
  assert.equal(res.status, 200);
  const wrong = await api('/api/v1/auth/step-up', { method: 'POST', headers: auth, body: { password: 'nope-nope' } });
  assert.equal(wrong.status, 403);
});
