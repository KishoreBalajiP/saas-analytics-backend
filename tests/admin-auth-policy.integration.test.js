/**
 * Admin authentication completeness (roadmap 2.2, adminauth) - part 1:
 * privileged-admin MFA policy, recovery codes and step-up.
 *
 * Exit criteria covered here:
 *   - a privileged admin without MFA can only reach MFA enrolment;
 *   - recovery codes work once and are stored hashed (never in audit rows);
 *   - step-up is required for sensitive actions, is bound to the session,
 *     and expires.
 *
 * The MFA policy is ON in this file (`ADMIN_MFA_REQUIRED_TYPES=super,platform`,
 * set by the first import below before the config loads).
 */

import './helpers/enableAdminMfaPolicy.js';
import test, { before, after, beforeEach } from 'node:test';
import { PLATFORM_ROLE_NAMES } from '../src/constants/platformRoles.js';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from './helpers/mongo.js';
import { startHttp, stopHttp, api, refreshCookieFrom } from './helpers/http.js';
import { factories } from './helpers/factories.js';
import { totpCode } from './helpers/totp.js';
import {
  ADMIN,
  ADMIN_AUTH,
  PASSWORD,
  bearer,
  adminLogin,
  seedPrivilegedAdmin,
  enrolMfa,
  signInEnrolled,
  signInWithCode,
  stepUp,
} from './helpers/adminAuthFlow.js';
import env from '../src/config/env.js';
import { Admin } from '../src/models/Admin.js';
import { Session } from '../src/models/Session.js';
import { AuditLog } from '../src/models/AuditLog.js';
import roleService from '../src/services/role.service.js';
import roleRepository from '../src/repositories/role.repository.js';
import adminRepository from '../src/repositories/admin.repository.js';
import adminService from '../src/services/admin.service.js';
import rbacCache from '../src/services/rbac.cache.service.js';
import { hashRecoveryCode } from '../src/utils/recoveryCodes.js';

before(async () => {
  await startMongo();
  await startHttp();
});

beforeEach(async () => {
  await resetMongo();
  await rbacCache.clearAll();
});

after(async () => {
  await stopHttp();
  await stopMongo();
});

const RECOVERY_CODE_RE = /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;

/* ----------------------- MFA required for privileged ---------------------- */

test('policy is on in this suite: super and platform admins must use MFA', () => {
  assert.deepEqual(env.security.auth.adminMfaRequiredTypes, ['super', 'platform']);
});

test('a privileged admin without MFA gets a session that can only enrol MFA', async () => {
  const admin = await seedPrivilegedAdmin('super');
  const login = await adminLogin(admin.email);
  assert.equal(login.status, 200);
  assert.equal(login.json.data.mfaEnrollmentRequired, true);
  const token = login.json.data.accessToken;

  // Every other admin route is refused with a machine-readable code.
  for (const path of [`${ADMIN}/admins`, '/api/v1/tenants', `${ADMIN}/dashboard/summary`]) {
    const res = await api(path, { headers: bearer(token) });
    assert.equal(res.status, 403, path);
    assert.equal(res.json.code, 'MFA_ENROLLMENT_REQUIRED', path);
  }
  // Mutations too, and step-up / disable are not part of the enrolment surface.
  const stepUpRes = await api(`${ADMIN_AUTH}/step-up`, { method: 'POST', headers: bearer(token), body: { password: PASSWORD } });
  assert.equal(stepUpRes.status, 403);
  assert.equal(stepUpRes.json.code, 'MFA_ENROLLMENT_REQUIRED');

  // /me works and tells the client what to do.
  const me = await api(`${ADMIN_AUTH}/me`, { headers: bearer(token) });
  assert.equal(me.status, 200);
  assert.equal(me.json.data.mfaRequired, true);
  assert.equal(me.json.data.mfaEnrollmentRequired, true);
  assert.equal(me.json.data.mfaEnabled, false);

  // Refreshing does not lift the restriction.
  const refreshed = await api(`${ADMIN_AUTH}/refresh`, { method: 'POST', cookies: [refreshCookieFrom(login)] });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.json.data.mfaEnrollmentRequired, true);
  const stillRestricted = await api(`${ADMIN}/admins`, { headers: bearer(refreshed.json.data.accessToken) });
  assert.equal(stillRestricted.status, 403);

  // Enrolling lifts it for the whole login (old and rotated tokens alike).
  const { recoveryCodes } = await enrolMfa(refreshed.json.data.accessToken);
  assert.equal(recoveryCodes.length, 10);
  assert.ok(recoveryCodes.every((code) => RECOVERY_CODE_RE.test(code)), 'formatted XXXX-XXXX-XXXX-XXXX');
  const allowed = await api(`${ADMIN}/admins`, { headers: bearer(refreshed.json.data.accessToken) });
  assert.equal(allowed.status, 200);
  const meAfter = await api(`${ADMIN_AUTH}/me`, { headers: bearer(refreshed.json.data.accessToken) });
  assert.equal(meAfter.json.data.mfaEnrollmentRequired, false);
  assert.equal(meAfter.json.data.recoveryCodesRemaining, 10);

  // From now on the login itself demands a code.
  const noCode = await adminLogin(admin.email);
  assert.equal(noCode.status, 401);
  assert.equal(noCode.json.code, 'MFA_REQUIRED');
});

test('an enrolment-only session can sign out', async () => {
  const admin = await seedPrivilegedAdmin('platform');
  const login = await adminLogin(admin.email);
  assert.equal(login.json.data.mfaEnrollmentRequired, true);
  const out = await api(`${ADMIN_AUTH}/logout`, {
    method: 'POST',
    headers: bearer(login.json.data.accessToken),
    cookies: [refreshCookieFrom(login)],
  });
  assert.equal(out.status, 200);
  assert.equal(out.json.data.revoked, true);
  const me = await api(`${ADMIN_AUTH}/me`, { headers: bearer(login.json.data.accessToken) });
  assert.equal(me.status, 401);
});

test('a non-privileged support admin signs in without the enrolment restriction', async () => {
  const admin = await factories.admin.create({ adminType: 'support' });
  const login = await adminLogin(admin.email);
  assert.equal(login.status, 200);
  assert.equal(login.json.data.mfaEnrollmentRequired, undefined);
  const me = await api(`${ADMIN_AUTH}/me`, { headers: bearer(login.json.data.accessToken) });
  assert.equal(me.json.data.mfaRequired, false);
  assert.equal(me.json.data.mfaEnrollmentRequired, false);
});

test('a support admin holding the super role counts as privileged', async () => {
  const superAdmin = await seedPrivilegedAdmin('super');
  assert.ok(superAdmin);
  const support = await adminService.create({ email: 'support-super@platform.test', password: PASSWORD, adminType: 'support' });

  // roles: the admin type caps built-in roles, so the service refuses to give
  // a support admin the super role today.
  const superRole = (await roleService.list({ tenantId: null, search: 'super' })).docs.find((r) => r.name === PLATFORM_ROLE_NAMES.SUPER);
  assert.ok(superRole, 'bootstrap created the super role');
  await assert.rejects(
    () => adminService.assignRole({ adminId: String(support._id), roleId: String(superRole._id), by: null }),
    (err) => err.code === 'ROLE_ABOVE_ADMIN_TYPE',
  );

  // A grant left over from before the role model (legacy `super` role) still
  // makes the admin privileged: the MFA policy must not ignore it.
  const legacy = await roleRepository.create({ tenantId: null, name: 'super', level: 'platform', isSystem: true });
  await adminRepository.assignRole(String(support._id), String(legacy._id), { by: null });
  await rbacCache.invalidateScope(null);
  const login = await adminLogin(support.email);
  assert.equal(login.status, 200);
  assert.equal(login.json.data.mfaEnrollmentRequired, true);
});

test('enrolling on one device ends the other password-only (enrolment-only) sessions', async () => {
  const admin = await seedPrivilegedAdmin('super');
  const a = await adminLogin(admin.email);
  const b = await adminLogin(admin.email);
  assert.equal(a.json.data.mfaEnrollmentRequired, true);
  assert.equal(b.json.data.mfaEnrollmentRequired, true);
  await enrolMfa(a.json.data.accessToken);
  assert.equal((await api(`${ADMIN}/admins`, { headers: bearer(a.json.data.accessToken) })).status, 200);
  const other = await api(`${ADMIN_AUTH}/me`, { headers: bearer(b.json.data.accessToken) });
  assert.equal(other.status, 401, 'the other password-only session does not inherit the new factor');
});

test('a privileged admin\'s pre-existing unrestricted session is restricted at its next refresh', async () => {
  const admin = await seedPrivilegedAdmin('platform');
  const login = await adminLogin(admin.email);
  // Simulate a session opened before the policy shipped.
  await Session.updateMany({ actorId: String(admin._id) }, { $set: { restriction: null } });
  assert.equal((await api(`${ADMIN}/admins`, { headers: bearer(login.json.data.accessToken) })).status, 200);
  const refreshed = await api(`${ADMIN_AUTH}/refresh`, { method: 'POST', cookies: [refreshCookieFrom(login)] });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.json.data.mfaEnrollmentRequired, true);
  const blocked = await api(`${ADMIN}/admins`, { headers: bearer(refreshed.json.data.accessToken) });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.code, 'MFA_ENROLLMENT_REQUIRED');
});

/* ------------------------------ recovery codes ---------------------------- */

test('recovery codes are stored hashed and each works exactly once', async () => {
  const admin = await seedPrivilegedAdmin('super');
  const { recoveryCodes } = await signInEnrolled(admin);

  const stored = await Admin.findById(admin._id).select('+mfaRecoveryCodes').lean();
  assert.equal(stored.mfaRecoveryCodes.length, 10);
  for (const digest of stored.mfaRecoveryCodes) assert.match(digest, /^[0-9a-f]{64}$/);
  for (const code of recoveryCodes) {
    assert.ok(!stored.mfaRecoveryCodes.includes(code), 'plaintext never stored');
    assert.ok(stored.mfaRecoveryCodes.includes(hashRecoveryCode(code)), 'digest of each issued code stored');
  }
  // Plain admin reads never carry the digests.
  const plain = await Admin.findById(admin._id).lean();
  assert.equal(plain.mfaRecoveryCodes, undefined);

  // A recovery code replaces the TOTP code at login, once.
  const first = await adminLogin(admin.email, PASSWORD, { recoveryCode: recoveryCodes[0] });
  assert.equal(first.status, 200);
  assert.equal(first.json.data.recoveryCodesRemaining, 9);
  const reuse = await adminLogin(admin.email, PASSWORD, { recoveryCode: recoveryCodes[0] });
  assert.equal(reuse.status, 401);
  assert.equal(reuse.json.message, 'Invalid email or password');

  // Typed loosely (lower case, no dashes) still matches.
  const loose = await adminLogin(admin.email, PASSWORD, { recoveryCode: recoveryCodes[1].toLowerCase().replaceAll('-', '') });
  assert.equal(loose.status, 200);
  assert.equal(loose.json.data.recoveryCodesRemaining, 8);

  // A recovery code never works without the password.
  const wrongPassword = await adminLogin(admin.email, 'WrongPassword1!', { recoveryCode: recoveryCodes[2] });
  assert.equal(wrongPassword.status, 401);
  const stillThere = await Admin.findById(admin._id).select('+mfaRecoveryCodes').lean();
  assert.equal(stillThere.mfaRecoveryCodes.length, 8, 'a failed password does not spend a code');

  // The audit trail never contains the codes or their digests.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const trail = JSON.stringify(await AuditLog.find({}).lean());
  for (const code of recoveryCodes) {
    assert.ok(!trail.includes(code), 'plaintext code in audit trail');
    assert.ok(!trail.includes(hashRecoveryCode(code)), 'code digest in audit trail');
  }
  assert.ok(trail.includes('auth.mfa.recovery_code_used'), 'recovery-code use is a security event');
});

test('regenerating recovery codes requires a fresh step-up and voids the old codes', async () => {
  const admin = await seedPrivilegedAdmin('super');
  const { token, secret, recoveryCodes } = await signInEnrolled(admin);

  const denied = await api(`${ADMIN_AUTH}/mfa/recovery-codes`, { method: 'POST', headers: bearer(token) });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.code, 'STEP_UP_REQUIRED');

  const badStepUp = await stepUp(token, secret, { password: 'WrongPassword1!' });
  assert.equal(badStepUp.status, 403);
  assert.equal(badStepUp.json.code, 'STEP_UP_FAILED');

  const ok = await stepUp(token, secret);
  assert.equal(ok.status, 200);
  assert.ok(Date.parse(ok.json.data.stepUpExpiresAt) > Date.now());

  const regenerated = await api(`${ADMIN_AUTH}/mfa/recovery-codes`, { method: 'POST', headers: bearer(token) });
  assert.equal(regenerated.status, 200);
  assert.equal(regenerated.headers.get('cache-control'), 'no-store');
  const fresh = regenerated.json.data.recoveryCodes;
  assert.equal(fresh.length, 10);
  assert.equal(fresh.some((code) => recoveryCodes.includes(code)), false);

  const old = await adminLogin(admin.email, PASSWORD, { recoveryCode: recoveryCodes[0] });
  assert.equal(old.status, 401);
  const neu = await adminLogin(admin.email, PASSWORD, { recoveryCode: fresh[0] });
  assert.equal(neu.status, 200);
});

test('disabling MFA takes the password plus a code or recovery code; every session of a privileged admin returns to enrolment-only', async () => {
  const admin = await seedPrivilegedAdmin('platform');
  const { token, secret, recoveryCodes } = await signInEnrolled(admin);
  const other = await signInWithCode(admin, secret);

  const noCode = await api(`${ADMIN_AUTH}/mfa/disable`, { method: 'POST', headers: bearer(token), body: { password: PASSWORD } });
  assert.equal(noCode.status, 400);

  const wrong = await api(`${ADMIN_AUTH}/mfa/disable`, {
    method: 'POST',
    headers: bearer(token),
    body: { password: 'WrongPassword1!', recoveryCode: recoveryCodes[0] },
  });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.json.code, 'STEP_UP_FAILED');

  const disabled = await api(`${ADMIN_AUTH}/mfa/disable`, {
    method: 'POST',
    headers: bearer(token),
    body: { password: PASSWORD, recoveryCode: recoveryCodes[0] },
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.json.data.enrollmentRequired, true);

  const blocked = await api(`${ADMIN}/admins`, { headers: bearer(token) });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.code, 'MFA_ENROLLMENT_REQUIRED');
  // Every other session of the admin is restricted too (no device keeps
  // full access without MFA).
  const elsewhere = await api(`${ADMIN}/admins`, { headers: bearer(other.token) });
  assert.equal(elsewhere.status, 403);
  assert.equal(elsewhere.json.code, 'MFA_ENROLLMENT_REQUIRED');
  const stored = await Admin.findById(admin._id).select('+mfaRecoveryCodes').lean();
  assert.equal(stored.mfaEnabled, false);
  assert.deepEqual(stored.mfaRecoveryCodes, [], 'codes wiped with the secret');
});

/* --------------------------------- step-up -------------------------------- */

test('step-up is bound to its session and expires', async () => {
  const admin = await seedPrivilegedAdmin('super');
  const a = await signInEnrolled(admin);
  const b = await signInWithCode(admin, a.secret);

  assert.equal((await stepUp(a.token, a.secret)).status, 200);
  const onA = await api(`${ADMIN_AUTH}/mfa/recovery-codes`, { method: 'POST', headers: bearer(a.token) });
  assert.equal(onA.status, 200);
  const onB = await api(`${ADMIN_AUTH}/mfa/recovery-codes`, { method: 'POST', headers: bearer(b.token) });
  assert.equal(onB.status, 403, 'another session of the same admin gets nothing from it');
  assert.equal(onB.json.code, 'STEP_UP_REQUIRED');

  // The window survives a refresh rotation of the same login...
  const rotated = await api(`${ADMIN_AUTH}/refresh`, { method: 'POST', cookies: [a.cookie] });
  assert.equal(rotated.status, 200);
  const afterRotation = await api(`${ADMIN_AUTH}/mfa/recovery-codes`, { method: 'POST', headers: bearer(rotated.json.data.accessToken) });
  assert.equal(afterRotation.status, 200);

  // ...and closes after ADMIN_STEP_UP_TTL_MS.
  const ttl = env.security.auth.adminStepUpTtlMs;
  await Session.updateMany({ actorId: String(admin._id) }, { $set: { stepUpAt: new Date(Date.now() - ttl - 1000) } });
  const expired = await api(`${ADMIN_AUTH}/mfa/recovery-codes`, { method: 'POST', headers: bearer(rotated.json.data.accessToken) });
  assert.equal(expired.status, 403);
  assert.equal(expired.json.code, 'STEP_UP_REQUIRED');
  const me = await api(`${ADMIN_AUTH}/me`, { headers: bearer(rotated.json.data.accessToken) });
  assert.equal(me.json.data.stepUpExpiresAt, null);
});

test('step-up needs a code when MFA is on and accepts a recovery code once', async () => {
  const admin = await seedPrivilegedAdmin('super');
  const { token, recoveryCodes } = await signInEnrolled(admin);
  const passwordOnly = await api(`${ADMIN_AUTH}/step-up`, { method: 'POST', headers: bearer(token), body: { password: PASSWORD } });
  assert.equal(passwordOnly.status, 400);
  const withRecovery = await api(`${ADMIN_AUTH}/step-up`, {
    method: 'POST',
    headers: bearer(token),
    body: { password: PASSWORD, recoveryCode: recoveryCodes[3] },
  });
  assert.equal(withRecovery.status, 200);
  assert.equal(withRecovery.json.data.recoveryCodesRemaining, 9);
  const again = await api(`${ADMIN_AUTH}/step-up`, {
    method: 'POST',
    headers: bearer(token),
    body: { password: PASSWORD, recoveryCode: recoveryCodes[3] },
  });
  assert.equal(again.status, 403);
});

test('repeated step-up failures lock the account and revoke its sessions', async () => {
  const admin = await seedPrivilegedAdmin('super');
  const { token, secret } = await signInEnrolled(admin);
  const max = env.security.auth.loginMaxAttempts;
  for (let i = 0; i < max; i += 1) {
    const res = await api(`${ADMIN_AUTH}/step-up`, {
      method: 'POST',
      headers: bearer(token),
      body: { password: 'WrongPassword1!', code: totpCode(secret) },
    });
    if (i < max - 1) assert.equal(res.status, 403, `attempt ${i + 1}`);
  }
  const me = await api(`${ADMIN_AUTH}/me`, { headers: bearer(token) });
  assert.equal(me.status, 401, 'sessions revoked once the lockout threshold is reached');
  const login = await adminLogin(admin.email, PASSWORD, { mfaToken: totpCode(secret) });
  assert.equal(login.status, 429, 'account locked');
});

test('step-up and sensitive routes require an admin token', async () => {
  const anon = await api(`${ADMIN_AUTH}/step-up`, { method: 'POST', body: { password: PASSWORD } });
  assert.equal(anon.status, 401);
  const regen = await api(`${ADMIN_AUTH}/mfa/recovery-codes`, { method: 'POST' });
  assert.equal(regen.status, 401);
});
