/**
 * Admin authentication completeness (roadmap 2.2, adminauth) - part 2:
 * admin invitations, admin-assisted credential resets, step-up on granting
 * super and on reading secret settings, and the admin password-reset link.
 *
 * Exit criteria covered here:
 *   - an admin cannot reset themselves; a super admin can reset another and
 *     the target must re-enrol;
 *   - invitation acceptance sets the password and requires MFA for
 *     privileged roles; pending admins cannot sign in;
 *   - the admin reset email links to the frontend admin reset page and the
 *     link completes a reset;
 *   - the resend cooldown is persisted (survives a cleared process cache).
 *
 * The MFA policy is ON in this file (first import).
 */

import './helpers/enableAdminMfaPolicy.js';
import { PLATFORM_ROLE_NAMES } from '../src/constants/platformRoles.js';
import test, { before, after, beforeEach } from 'node:test';
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
  stepUp,
  steppedUpSuper,
} from './helpers/adminAuthFlow.js';
import env from '../src/config/env.js';
import { describeDuration } from '../src/utils/humanDuration.js';
import emailService from '../src/services/email.service.js';
import cacheService from '../src/services/cache.service.js';
import rbacCache from '../src/services/rbac.cache.service.js';
import roleService from '../src/services/role.service.js';
import { Admin } from '../src/models/Admin.js';
import { AdminInvitation } from '../src/models/AdminInvitation.js';
import { AuthCooldown } from '../src/models/AuthCooldown.js';
import { AuditLog } from '../src/models/AuditLog.js';

const NEW_PASSWORD = 'BrandNewPassword9!';
let sink = [];

before(async () => {
  await startMongo();
  await startHttp();
});

beforeEach(async () => {
  await resetMongo();
  await rbacCache.clearAll();
  sink = [];
  emailService.captureInto(sink);
});

after(async () => {
  emailService.stopCapture();
  await stopHttp();
  await stopMongo();
});

/** Last captured email to `to`. */
function lastMailTo(to) {
  const found = sink.filter((m) => String(m.to).toLowerCase() === String(to).toLowerCase());
  assert.ok(found.length > 0, `an email was sent to ${to}`);
  return found[found.length - 1];
}

/** Token query parameter of the first link in an email that starts with `prefix`. */
function tokenFromMail(mail, prefix) {
  const line = String(mail.text).split('\n').find((l) => l.startsWith(prefix));
  assert.ok(line, `email contains a link starting with ${prefix}`);
  return new URL(line).searchParams.get('token');
}

const ACCEPT_PREFIX = `${env.cors.clientUrl}/admin/accept-invite?token=`;
const RESET_PREFIX = `${env.cors.clientUrl}/admin/reset-password?token=`;

/* ------------------------------- invitations ------------------------------ */

test('inviting an admin creates a pending, passwordless admin and emails an acceptance link', async () => {
  const actor = await steppedUpSuper();
  const res = await api(`${ADMIN}/admins`, {
    method: 'POST',
    headers: bearer(actor.token),
    // A password in the body is ignored: the invitee chooses their own.
    body: { email: 'New.Ops@Example.com', name: 'New Ops', adminType: 'platform', password: 'Typed-By-Someone-Else1' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.data.email, 'new.ops@example.com');
  assert.equal(res.json.data.status, 'pending');
  assert.equal(res.json.data.passwordHash, undefined);
  assert.equal(res.json.data.invitation.status, 'pending');
  assert.equal(res.json.data.invitation.tokenHash, undefined, 'never returns the token digest');
  assert.equal(res.json.data.delivered, true);

  const stored = await Admin.findOne({ email: 'new.ops@example.com' }).lean();
  assert.equal(stored.passwordHash, null);
  const mail = lastMailTo('new.ops@example.com');
  assert.match(mail.text, /expires in 3 days/);
  assert.match(mail.text, /multi-factor authentication/);
  assert.ok(tokenFromMail(mail, ACCEPT_PREFIX));

  // A pending admin cannot sign in, whatever password is tried.
  for (const pw of [PASSWORD, 'Typed-By-Someone-Else1']) {
    const login = await adminLogin('new.ops@example.com', pw);
    assert.equal(login.status, 401);
  }

  // The invitation shows up in the history.
  const listed = await api(`${ADMIN}/admins/invitations?status=pending`, { headers: bearer(actor.token) });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.data.length, 1);
  assert.equal(listed.json.data[0].email, 'new.ops@example.com');
  assert.equal(listed.json.data[0].tokenHash, undefined);
});

test('a pending admin that somehow has a password is still refused (403 ACCOUNT_NOT_ACTIVE)', async () => {
  const pending = await factories.admin.create({ status: 'pending', adminType: 'support' });
  const login = await adminLogin(pending.email);
  assert.equal(login.status, 403);
  assert.equal(login.json.code, 'ACCOUNT_NOT_ACTIVE');
});

test('accepting an invitation sets the password and makes a privileged invitee enrol MFA', async () => {
  const actor = await steppedUpSuper();
  await api(`${ADMIN}/admins`, { method: 'POST', headers: bearer(actor.token), body: { email: 'ops@example.com', adminType: 'platform' } });
  const token = tokenFromMail(lastMailTo('ops@example.com'), ACCEPT_PREFIX);

  const preview = await api(`${ADMIN_AUTH}/invitations/preview`, { method: 'POST', body: { token } });
  assert.equal(preview.status, 200);
  assert.equal(preview.json.data.email, 'ops@example.com');
  assert.equal(preview.json.data.adminType, 'platform');
  assert.equal(preview.json.data.mfaRequired, true);

  const weak = await api(`${ADMIN_AUTH}/invitations/accept`, { method: 'POST', body: { token, password: 'short' } });
  assert.ok(weak.status === 400 || weak.status === 422, `weak password refused (${weak.status})`);

  const accepted = await api(`${ADMIN_AUTH}/invitations/accept`, {
    method: 'POST',
    body: { token, password: NEW_PASSWORD, name: 'Ops Person' },
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
  assert.equal(accepted.json.data.mfaEnrollmentRequired, true);
  assert.equal('refreshToken' in accepted.json.data, false);
  assert.ok(refreshCookieFrom(accepted, 'saas_admin_session'), 'signed in with the admin cookie');
  const session = accepted.json.data.accessToken;

  const blocked = await api(`${ADMIN}/admins`, { headers: bearer(session) });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.code, 'MFA_ENROLLMENT_REQUIRED');
  const { secret } = await enrolMfa(session);
  const me = await api(`${ADMIN_AUTH}/me`, { headers: bearer(session) });
  assert.equal(me.json.data.status, 'active');
  assert.equal(me.json.data.name, 'Ops Person');
  assert.equal(me.json.data.mfaEnabled, true);

  // Single use.
  const again = await api(`${ADMIN_AUTH}/invitations/accept`, { method: 'POST', body: { token, password: NEW_PASSWORD } });
  assert.equal(again.status, 400);
  // The chosen password (plus the new authenticator) signs in.
  const login = await adminLogin('ops@example.com', NEW_PASSWORD, { mfaToken: totpCode(secret) });
  assert.equal(login.status, 200);

  const trail = JSON.stringify(await AuditLog.find({}).lean());
  assert.ok(trail.includes('iam.admin_invitation.accepted'));
  assert.ok(!trail.includes(token), 'the raw invitation token is never logged');
});

test('a support invitee is not forced into MFA enrolment', async () => {
  const actor = await steppedUpSuper();
  await api(`${ADMIN}/admins`, { method: 'POST', headers: bearer(actor.token), body: { email: 'help@example.com', adminType: 'support' } });
  const token = tokenFromMail(lastMailTo('help@example.com'), ACCEPT_PREFIX);
  const accepted = await api(`${ADMIN_AUTH}/invitations/accept`, { method: 'POST', body: { token, password: NEW_PASSWORD } });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.data.mfaEnrollmentRequired, undefined);
});

test('invalid, expired and revoked invitations all answer the same 400', async () => {
  const actor = await steppedUpSuper();
  await api(`${ADMIN}/admins`, { method: 'POST', headers: bearer(actor.token), body: { email: 'late@example.com', adminType: 'support' } });
  const token = tokenFromMail(lastMailTo('late@example.com'), ACCEPT_PREFIX);

  const unknown = await api(`${ADMIN_AUTH}/invitations/preview`, { method: 'POST', body: { token: `${token}x` } });
  assert.equal(unknown.status, 400);

  await AdminInvitation.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const expired = await api(`${ADMIN_AUTH}/invitations/accept`, { method: 'POST', body: { token, password: NEW_PASSWORD } });
  assert.equal(expired.status, 400);
  assert.equal(expired.json.message, unknown.json.message);
  const listed = await api(`${ADMIN}/admins/invitations?status=expired`, { headers: bearer(actor.token) });
  assert.equal(listed.json.data.length, 1);
  assert.equal(listed.json.data[0].status, 'expired');
});

test('resend supersedes the old link and its cooldown is persisted, not process-local', async () => {
  const actor = await steppedUpSuper();
  const created = await api(`${ADMIN}/admins`, { method: 'POST', headers: bearer(actor.token), body: { email: 'again@example.com', adminType: 'support' } });
  const adminId = created.json.data._id;
  const firstToken = tokenFromMail(lastMailTo('again@example.com'), ACCEPT_PREFIX);

  const tooSoon = await api(`${ADMIN}/admins/${adminId}/invitation/resend`, { method: 'POST', headers: bearer(actor.token), body: {} });
  assert.equal(tooSoon.status, 429);
  // A cleared process cache (another instance / a restart) does not reset it.
  await cacheService.flushAll();
  const stillTooSoon = await api(`${ADMIN}/admins/${adminId}/invitation/resend`, { method: 'POST', headers: bearer(actor.token), body: {} });
  assert.equal(stillTooSoon.status, 429);
  assert.equal(await AuthCooldown.countDocuments({ key: `admin-invitation-resend:${adminId}` }), 1);

  // Once the cooldown has run out, resend issues a new link.
  await AuthCooldown.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1) } });
  const resent = await api(`${ADMIN}/admins/${adminId}/invitation/resend`, { method: 'POST', headers: bearer(actor.token), body: {} });
  assert.equal(resent.status, 200, JSON.stringify(resent.json));
  assert.equal(resent.json.data.invitation.sendCount, 2);
  const secondToken = tokenFromMail(lastMailTo('again@example.com'), ACCEPT_PREFIX);
  assert.notEqual(secondToken, firstToken);

  const old = await api(`${ADMIN_AUTH}/invitations/preview`, { method: 'POST', body: { token: firstToken } });
  assert.equal(old.status, 400, 'the superseded link stops working');
  const fresh = await api(`${ADMIN_AUTH}/invitations/preview`, { method: 'POST', body: { token: secondToken } });
  assert.equal(fresh.status, 200);
});

test('revoking an invitation removes the pending admin and voids the link', async () => {
  const actor = await steppedUpSuper();
  const created = await api(`${ADMIN}/admins`, { method: 'POST', headers: bearer(actor.token), body: { email: 'gone@example.com', adminType: 'support' } });
  const token = tokenFromMail(lastMailTo('gone@example.com'), ACCEPT_PREFIX);
  const revoked = await api(`${ADMIN}/admins/${created.json.data._id}/invitation/revoke`, {
    method: 'POST',
    headers: bearer(actor.token),
    body: { reason: 'wrong address' },
  });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.json.data.adminRemoved, true);
  assert.equal(revoked.json.data.invitation.status, 'revoked');
  assert.equal(await Admin.countDocuments({ email: 'gone@example.com' }), 0);
  const preview = await api(`${ADMIN_AUTH}/invitations/preview`, { method: 'POST', body: { token } });
  assert.equal(preview.status, 400);
  // The email can be invited again.
  const reinvite = await api(`${ADMIN}/admins`, { method: 'POST', headers: bearer(actor.token), body: { email: 'gone@example.com', adminType: 'support' } });
  assert.equal(reinvite.status, 201);
  // Inviting an existing admin is a conflict.
  const dup = await api(`${ADMIN}/admins`, { method: 'POST', headers: bearer(actor.token), body: { email: 'gone@example.com', adminType: 'support' } });
  assert.equal(dup.status, 409);
});

test('inviting a super admin needs a super actor and a fresh step-up', async () => {
  const superAdmin = await seedPrivilegedAdmin('super');
  const s = await signInEnrolled(superAdmin);
  const noStepUp = await api(`${ADMIN}/admins`, { method: 'POST', headers: bearer(s.token), body: { email: 'boss@example.com', adminType: 'super' } });
  assert.equal(noStepUp.status, 403);
  assert.equal(noStepUp.json.code, 'STEP_UP_REQUIRED');
  // A non-super invite needs no step-up.
  const plain = await api(`${ADMIN}/admins`, { method: 'POST', headers: bearer(s.token), body: { email: 'ops2@example.com', adminType: 'support' } });
  assert.equal(plain.status, 201);
  assert.equal((await stepUp(s.token, s.secret)).status, 200);
  const ok = await api(`${ADMIN}/admins`, { method: 'POST', headers: bearer(s.token), body: { email: 'boss@example.com', adminType: 'super' } });
  assert.equal(ok.status, 201);

  // A platform admin with every permission and a fresh step-up still may not.
  const platform = await seedPrivilegedAdmin('platform');
  const p = await signInEnrolled(platform);
  assert.equal((await stepUp(p.token, p.secret)).status, 200);
  const denied = await api(`${ADMIN}/admins`, { method: 'POST', headers: bearer(p.token), body: { email: 'boss2@example.com', adminType: 'super' } });
  assert.equal(denied.status, 403);
  assert.equal(await Admin.countDocuments({ email: 'boss2@example.com' }), 0);
});

test('invitation management requires the iam.admins permissions', async () => {
  const viewer = await factories.admin.create({ adminType: 'support' });
  const login = await adminLogin(viewer.email);
  const token = login.json.data.accessToken;
  const invite = await api(`${ADMIN}/admins`, { method: 'POST', headers: bearer(token), body: { email: 'x@example.com' } });
  assert.equal(invite.status, 403);
  const list = await api(`${ADMIN}/admins/invitations`, { headers: bearer(token) });
  assert.equal(list.status, 403);
});

/* ------------------------- admin-assisted resets -------------------------- */

test('an admin cannot reset their own credentials, even as a stepped-up super', async () => {
  const actor = await steppedUpSuper();
  for (const kind of ['mfa', 'password']) {
    const res = await api(`${ADMIN}/admins/${actor.admin._id}/${kind}/reset`, {
      method: 'POST',
      headers: bearer(actor.token),
      body: { reason: 'lost device' },
    });
    assert.equal(res.status, 403, kind);
  }
  const trail = JSON.stringify(await AuditLog.find({ action: 'auth.credentials.reset_denied' }).lean());
  assert.ok(trail.includes('"why":"self"'));
});

test('a credential reset needs a fresh step-up and a reason', async () => {
  const superAdmin = await seedPrivilegedAdmin('super');
  const s = await signInEnrolled(superAdmin);
  const target = await factories.admin.create({ adminType: 'support' });
  const noStepUp = await api(`${ADMIN}/admins/${target._id}/mfa/reset`, { method: 'POST', headers: bearer(s.token), body: { reason: 'lost device' } });
  assert.equal(noStepUp.status, 403);
  assert.equal(noStepUp.json.code, 'STEP_UP_REQUIRED');
  assert.equal((await stepUp(s.token, s.secret)).status, 200);
  const noReason = await api(`${ADMIN}/admins/${target._id}/mfa/reset`, { method: 'POST', headers: bearer(s.token), body: {} });
  assert.ok(noReason.status === 400 || noReason.status === 422, `reason required (${noReason.status})`);
});

test('only an active super admin may reset another admin', async () => {
  const platform = await seedPrivilegedAdmin('platform');
  const p = await signInEnrolled(platform);
  assert.equal((await stepUp(p.token, p.secret)).status, 200);
  const target = await factories.admin.create({ adminType: 'support' });
  const res = await api(`${ADMIN}/admins/${target._id}/mfa/reset`, { method: 'POST', headers: bearer(p.token), body: { reason: 'lost device' } });
  assert.equal(res.status, 403);
});

test('a super admin resets another admin\'s MFA: sessions revoked and the target must re-enrol', async () => {
  const actor = await steppedUpSuper();
  // Target: a support admin (outside the type policy) with MFA enrolled.
  const target = await factories.admin.create({ adminType: 'support' });
  const t = await signInEnrolled(target);
  assert.equal((await api(`${ADMIN_AUTH}/me`, { headers: bearer(t.token) })).status, 200);

  const res = await api(`${ADMIN}/admins/${target._id}/mfa/reset`, {
    method: 'POST',
    headers: bearer(actor.token),
    body: { reason: 'lost phone, ticket 123' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.mfaEnrollmentRequired, true);
  assert.ok(res.json.data.sessionsRevoked >= 1);
  assert.equal(res.json.data.admin.mfaSecret, undefined);

  // The target's existing session is gone.
  assert.equal((await api(`${ADMIN_AUTH}/me`, { headers: bearer(t.token) })).status, 401);
  // Password alone now signs in, but only to enrol (even for a support admin).
  const login = await adminLogin(target.email);
  assert.equal(login.status, 200);
  assert.equal(login.json.data.mfaEnrollmentRequired, true);
  const blocked = await api(`${ADMIN}/admins`, { headers: bearer(login.json.data.accessToken) });
  assert.equal(blocked.json.code, 'MFA_ENROLLMENT_REQUIRED');
  await enrolMfa(login.json.data.accessToken);
  const stored = await Admin.findById(target._id).lean();
  assert.equal(stored.mfaEnrollmentRequired, false, 'enrolment clears the flag');

  const event = await AuditLog.findOne({ action: 'auth.mfa.reset_by_admin' }).lean();
  assert.ok(event, 'audited');
  assert.equal(event.actorType, 'admin');
  assert.equal(event.actorId, String(actor.admin._id));
  assert.equal(event.metadata.targetAdminId, String(target._id));
  assert.equal(event.reason, 'lost phone, ticket 123');
});

test('a super admin resets another admin\'s password: old password void, emailed link completes it', async () => {
  const actor = await steppedUpSuper();
  const target = await factories.admin.create({ adminType: 'support' });
  const before = await adminLogin(target.email);
  assert.equal(before.status, 200);

  const res = await api(`${ADMIN}/admins/${target._id}/password/reset`, {
    method: 'POST',
    headers: bearer(actor.token),
    body: { reason: 'suspected leak' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.delivered, true);
  assert.equal((await api(`${ADMIN_AUTH}/me`, { headers: bearer(before.json.data.accessToken) })).status, 401);
  assert.equal((await adminLogin(target.email)).status, 401, 'old password no longer works');

  const mail = lastMailTo(target.email);
  assert.match(mail.subject, /password was reset/i);
  const token = tokenFromMail(mail, RESET_PREFIX);
  const done = await api(`${ADMIN_AUTH}/password/reset`, { method: 'POST', body: { token, newPassword: NEW_PASSWORD } });
  assert.equal(done.status, 200);
  assert.equal((await adminLogin(target.email, NEW_PASSWORD)).status, 200);
  assert.ok(await AuditLog.findOne({ action: 'auth.password.reset_by_admin' }).lean());
});

test('a pending (invited) admin cannot be credential-reset', async () => {
  const actor = await steppedUpSuper();
  const pending = await factories.admin.create({ status: 'pending', adminType: 'support' });
  const res = await api(`${ADMIN}/admins/${pending._id}/mfa/reset`, { method: 'POST', headers: bearer(actor.token), body: { reason: 'n/a here' } });
  assert.equal(res.status, 409);
});

/* ------------------------ step-up on sensitive actions -------------------- */

test('granting super (type or role) requires a fresh step-up; other changes do not', async () => {
  const superAdmin = await seedPrivilegedAdmin('super');
  const s = await signInEnrolled(superAdmin);
  const target = await factories.admin.create({ adminType: 'support' });

  const rename = await api(`${ADMIN}/admins/${target._id}`, { method: 'PATCH', headers: bearer(s.token), body: { name: 'Renamed' } });
  assert.equal(rename.status, 200);
  const promote = await api(`${ADMIN}/admins/${target._id}`, { method: 'PATCH', headers: bearer(s.token), body: { adminType: 'super' } });
  assert.equal(promote.status, 403);
  assert.equal(promote.json.code, 'STEP_UP_REQUIRED');

  const superRole = (await roleService.list({ tenantId: null, search: 'super' })).docs.find((r) => r.name === PLATFORM_ROLE_NAMES.SUPER);
  const grant = await api(`${ADMIN}/admins/${target._id}/roles`, { method: 'POST', headers: bearer(s.token), body: { roleId: String(superRole._id) } });
  assert.equal(grant.status, 403);
  assert.equal(grant.json.code, 'STEP_UP_REQUIRED');
  const other = await roleService.create({ tenantId: null, name: 'helpdesk' });
  const otherGrant = await api(`${ADMIN}/admins/${target._id}/roles`, { method: 'POST', headers: bearer(s.token), body: { roleId: String(other._id) } });
  assert.equal(otherGrant.status, 200);

  assert.equal((await stepUp(s.token, s.secret)).status, 200);
  const promoted = await api(`${ADMIN}/admins/${target._id}`, { method: 'PATCH', headers: bearer(s.token), body: { adminType: 'super' } });
  assert.equal(promoted.status, 200);
  const granted = await api(`${ADMIN}/admins/${target._id}/roles`, { method: 'POST', headers: bearer(s.token), body: { roleId: String(superRole._id) } });
  assert.equal(granted.status, 200);
});

test('reading secret tenant settings requires a fresh step-up', async () => {
  const superAdmin = await seedPrivilegedAdmin('super');
  const s = await signInEnrolled(superAdmin);
  const tenant = await factories.tenant.create();
  const plain = await api(`/api/v1/tenants/${tenant._id}/settings`, { headers: bearer(s.token) });
  assert.equal(plain.status, 200);
  const secrets = await api(`/api/v1/tenants/${tenant._id}/settings?includeSecrets=true`, { headers: bearer(s.token) });
  assert.equal(secrets.status, 403);
  assert.equal(secrets.json.code, 'STEP_UP_REQUIRED');
  assert.equal((await stepUp(s.token, s.secret)).status, 200);
  const allowed = await api(`/api/v1/tenants/${tenant._id}/settings?includeSecrets=true`, { headers: bearer(s.token) });
  assert.equal(allowed.status, 200);
});

/* --------------------------- admin password reset ------------------------- */

test('the admin forgot-password email links to the admin reset page and states the configured lifetime', async () => {
  const admin = await factories.admin.create({ adminType: 'support' });
  const forgot = await api(`${ADMIN_AUTH}/password/forgot`, { method: 'POST', body: { email: admin.email } });
  assert.equal(forgot.status, 200);
  const mail = lastMailTo(admin.email);
  assert.match(mail.text, new RegExp(`expires in ${describeDuration(env.security.auth.passwordResetTokenTtlMs)}`));
  assert.ok(!mail.text.includes(`${env.cors.clientUrl}/reset-password`), 'old, non-existent route is gone');
  const token = tokenFromMail(mail, RESET_PREFIX);
  const done = await api(`${ADMIN_AUTH}/password/reset`, { method: 'POST', body: { token, newPassword: NEW_PASSWORD } });
  assert.equal(done.status, 200);
  assert.equal((await adminLogin(admin.email, NEW_PASSWORD)).status, 200);
  const replay = await api(`${ADMIN_AUTH}/password/reset`, { method: 'POST', body: { token, newPassword: 'Another1Password!' } });
  assert.equal(replay.status, 400);
});
