/**
 * Security events (roadmap 2.5; findings gov.06, gov.08).
 *
 * Every event in `constants/securityEvents.js` that has a call site is
 * driven through the real code path (HTTP where the event is triggered by a
 * request) and the stored row is checked for: category `security`, the
 * catalogue module/action/severity, the actor, the tenant, the client ip,
 * and the absence of any secret (passwords, refresh/reset/API/embed tokens,
 * TOTP secrets).
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api, refreshCookieFrom } from '../helpers/http.js';
import { totpCode } from '../helpers/totp.js';
import { shortToken } from '../../src/utils/id.js';
import env from '../../src/config/env.js';
import * as emailService from '../../src/services/email.service.js';
import * as tenantService from '../../src/services/tenant.service.js';
import adminService from '../../src/services/admin.service.js';
import roleService from '../../src/services/role.service.js';
import permissionService from '../../src/services/permission.service.js';
import supportService from '../../src/services/support.service.js';
import apiKeyService from '../../src/services/apiKey.service.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import sessionRepository from '../../src/repositories/session.repository.js';
import { securityEvent } from '../../src/services/securityEvent.service.js';
import { SECURITY_EVENTS } from '../../src/constants/securityEvents.js';
import { runWithContext, runWithRequestContext } from '../../src/utils/actorContext.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { User } from '../../src/models/User.js';
import { Session } from '../../src/models/Session.js';
// support: impersonation needs workspace consent (roadmap 2.3).
import * as supportAccessService from '../../src/services/supportAccess.service.js';

const PASSWORD = 'Password123!';

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => {
  await resetMongo();
  await rbacCache.clearAll();
  await cacheService.flushAll();
});
after(async () => { await emailService.close(); await stopHttp(); await stopMongo(); });

/* -------------------------------- helpers -------------------------------- */

/** Poll until a security row matches (some writes are fire-and-forget). */
async function waitForSecurity(filter, { timeoutMs = 4000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await AuditLog.findOne({ category: 'security', ...filter }).sort({ occurredAt: -1 }).lean();
    if (row) return row;
    assert.ok(Date.now() < deadline, `no security row matched ${JSON.stringify(filter)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The row follows the catalogue entry for `key`. */
function assertCatalogue(row, key) {
  const def = SECURITY_EVENTS[key];
  assert.equal(row.category, 'security');
  assert.equal(row.module, def.module, `${key} module`);
  assert.equal(row.action, def.action, `${key} action`);
  assert.equal(row.severity, def.severity, `${key} severity`);
  assert.ok(row.seq > 0 && typeof row.hash === 'string', `${key} is hash-chained`);
}

/** No stored security row contains any of the given secret values. */
async function assertNoSecrets(secrets) {
  const rows = await AuditLog.find({}).lean();
  const text = JSON.stringify(rows);
  for (const secret of secrets.filter(Boolean)) {
    assert.ok(!text.includes(secret), `a secret leaked into the audit trail: ${secret.slice(0, 6)}...`);
  }
  for (const row of rows) {
    for (const key of ['password', 'passwordHash', 'secretHash', 'tokenHash', 'refreshTokenHash', 'mfaSecret', 'webhookToken']) {
      for (const field of ['before', 'after', 'metadata']) {
        const value = row[field]?.[key];
        assert.ok(value === undefined || value === '[REDACTED]', `${row.module}/${row.action} ${field}.${key} stored`);
      }
    }
  }
}

async function onboard() {
  const owner = { email: `owner-${shortToken(10).toLowerCase()}@example.com`, name: 'Owner', password: PASSWORD };
  const { tenant } = await tenantService.create({ tenant: { name: `Sec ${shortToken(8)}` }, owner, initialize: true, by: 'root' });
  await entitleTenant(tenant._id);
  const tenantId = String(tenant._id);
  const user = await User.findOne({ tenantId, email: owner.email }).lean();
  const login = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email: owner.email, password: PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return {
    tenant,
    tenantId,
    email: owner.email,
    userId: String(user._id),
    auth: { authorization: `Bearer ${login.json.data.accessToken}`, 'X-Tenant-Id': tenantId },
    cookie: refreshCookieFrom(login),
  };
}

async function ensurePermission(key) {
  const module = key.slice(0, key.lastIndexOf('.'));
  const action = key.slice(key.lastIndexOf('.') + 1);
  const parts = module.split('.');
  for (let i = 1; i <= parts.length; i += 1) {
    try { await permissionService.createModule({ key: parts.slice(0, i).join('.'), name: parts.slice(0, i).join('.') }); } catch (err) { if (err.statusCode !== 409) throw err; }
  }
  try { await permissionService.createPermission({ module, action }); } catch (err) { if (err.statusCode !== 409) throw err; }
}

async function seedAdmin({ adminType = 'platform', keys = [], tenantScope = null } = {}) {
  const admin = await adminService.create({ email: `adm-${shortToken(8).toLowerCase()}@example.com`, password: PASSWORD, adminType, name: 'Admin', tenantScope });
  if (keys.length) {
    const role = await roleService.create({ tenantId: null, name: `r_${shortToken(8)}` });
    for (const key of keys) {
      await ensurePermission(key);
      await roleService.addPermission({ roleId: role._id, permissionKey: key, by: null });
    }
    await adminService.assignRole({ adminId: admin._id, roleId: role._id, by: null });
  }
  return admin;
}

async function adminLogin(admin, extra = {}) {
  const res = await api('/api/v1/admin-auth/login', { method: 'POST', body: { email: admin.email, password: PASSWORD, ...extra } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return { authorization: `Bearer ${res.json.data.accessToken}` };
}

/** Run service code as an admin request from a known ip. */
function asAdmin(admin, fn, ip = '203.0.113.7') {
  return runWithRequestContext({ requestId: `req-${shortToken(8)}`, ip, userAgent: 'audit-test' }, () =>
    runWithContext({ actor: { type: 'admin', id: String(admin._id), email: admin.email, tenantId: null } }, fn));
}

/* ---------------------------------- login --------------------------------- */

test('login success and failure are recorded with actor, tenant and ip; failures are de-duplicated; no password stored', async () => {
  const ws = await onboard();
  const succeeded = await waitForSecurity({ action: 'auth.login.succeeded', actorId: ws.userId });
  assertCatalogue(succeeded, 'LOGIN_SUCCEEDED');
  assert.equal(succeeded.actorType, 'user');
  assert.equal(succeeded.tenantId, ws.tenantId);
  assert.match(succeeded.ip, /127\.0\.0\.1/);
  assert.equal(succeeded.result, 'success');

  const wrong = 'WrongPassword!1';
  for (let i = 0; i < 2; i += 1) {
    const res = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': ws.tenantId }, body: { email: ws.email, password: wrong } });
    assert.equal(res.status, 401);
  }
  const failed = await waitForSecurity({ action: 'auth.login.failed', actorId: ws.userId });
  assertCatalogue(failed, 'LOGIN_FAILED');
  assert.equal(failed.result, 'failure');
  assert.equal(failed.tenantId, ws.tenantId);
  assert.equal(failed.actorDisplay, ws.email);
  assert.equal(failed.metadata.reason, 'invalid_credentials');
  assert.match(failed.ip, /127\.0\.0\.1/);
  assert.equal(
    await AuditLog.countDocuments({ action: 'auth.login.failed', actorId: ws.userId }),
    1,
    'identical failures inside the window are written once',
  );

  // Unknown account: recorded without an actor id.
  await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': ws.tenantId }, body: { email: 'ghost@example.com', password: wrong } });
  const unknown = await waitForSecurity({ action: 'auth.login.failed', actorDisplay: 'ghost@example.com' });
  assert.equal(unknown.actorId, null);
  assert.equal(unknown.metadata.reason, 'unknown_email');

  await assertNoSecrets([PASSWORD, wrong]);
});

test('lockout is a warning event naming the locked account', async () => {
  const ws = await onboard();
  for (let i = 0; i < env.security.auth.loginMaxAttempts; i += 1) {
    await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': ws.tenantId }, body: { email: ws.email, password: `Nope-${i}-Wrong!` } });
  }
  const lockout = await waitForSecurity({ action: 'auth.lockout', actorId: ws.userId });
  assertCatalogue(lockout, 'LOCKOUT');
  assert.equal(lockout.tenantId, ws.tenantId);
  assert.equal(lockout.metadata.failedAttempts, env.security.auth.loginMaxAttempts);
  assert.match(lockout.metadata.lockedUntil, /^\d{4}-\d{2}-\d{2}T/, 'dates are stored as ISO strings');
  assert.match(lockout.ip, /127\.0\.0\.1/);
});

/* ----------------------------------- MFA ---------------------------------- */

test('admin MFA enrolment, confirmation, refused disable and disable are recorded without the secret', async () => {
  const admin = await seedAdmin();
  const auth = await adminLogin(admin);

  const enroll = await api('/api/v1/admin-auth/mfa/enroll', { method: 'POST', headers: auth });
  assert.equal(enroll.status, 200, JSON.stringify(enroll.json));
  const secret = enroll.json.data.secret;
  const started = await waitForSecurity({ action: 'auth.mfa.enrollment_started', actorId: String(admin._id) });
  assertCatalogue(started, 'MFA_ENROLLMENT_STARTED');
  assert.match(started.ip, /127\.0\.0\.1/);

  const verify = await api('/api/v1/admin-auth/mfa/verify', { method: 'POST', headers: auth, body: { code: totpCode(secret) } });
  assert.equal(verify.status, 200, JSON.stringify(verify.json));
  const enrolled = await waitForSecurity({ action: 'auth.mfa.enrolled', actorId: String(admin._id) });
  assertCatalogue(enrolled, 'MFA_ENROLLED');
  assert.equal(enrolled.actorType, 'admin');
  assert.equal(enrolled.tenantId, null, 'platform admins have no tenant');

  const refused = await api('/api/v1/admin-auth/mfa/disable', { method: 'POST', headers: auth, body: { password: 'not-my-password', code: totpCode(secret) } });
  // adminauth: a failed re-authentication is 403 STEP_UP_FAILED (a 401 would sign the portal out).
  assert.equal(refused.status, 403);
  assert.equal(refused.json.code, 'STEP_UP_FAILED');
  const failed = await waitForSecurity({ action: 'auth.mfa.disable_failed', actorId: String(admin._id) });
  assertCatalogue(failed, 'MFA_DISABLE_FAILED');
  assert.equal(failed.metadata.failedCheck, 'password');

  const disabled = await api('/api/v1/admin-auth/mfa/disable', { method: 'POST', headers: auth, body: { password: PASSWORD, code: totpCode(secret) } });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.json));
  const row = await waitForSecurity({ action: 'auth.mfa.disabled', actorId: String(admin._id) });
  assertCatalogue(row, 'MFA_DISABLED');
  assert.match(row.ip, /127\.0\.0\.1/);

  await assertNoSecrets([secret, PASSWORD]);
});

test('MFA recovery-code use is a catalogued event later packages can emit; unknown events are refused', async () => {
  const admin = await seedAdmin();
  const row = await asAdmin(admin, () => securityEvent('MFA_RECOVERY_CODE_USED', {
    resource: { type: 'admin', id: String(admin._id) },
    metadata: { remaining: 7, recoveryCode: 'abcd-efgh-ijkl', token: 'leak-me' },
  }));
  assertCatalogue(row, 'MFA_RECOVERY_CODE_USED');
  assert.equal(row.actorId, String(admin._id));
  assert.equal(row.ip, '203.0.113.7');
  assert.equal(row.metadata.remaining, 7);
  assert.equal(row.metadata.recoveryCode, '[REDACTED]');
  assert.equal(row.metadata.token, '[REDACTED]');
  await assert.rejects(() => securityEvent('NOT_AN_EVENT', {}), TypeError);
});

/* ----------------------------- password reset ----------------------------- */

test('password reset request and completion are recorded; the reset token never is', async () => {
  const ws = await onboard();
  const sink = [];
  emailService.captureInto(sink);
  try {
    const forgot = await api('/api/v1/auth/password/forgot', { method: 'POST', headers: { 'X-Tenant-Id': ws.tenantId }, body: { email: ws.email } });
    assert.equal(forgot.status, 200);
  } finally {
    emailService.stopCapture();
  }
  const link = sink.map((m) => m.text).join('\n').match(/https?:\/\/[^\s]+/u)?.[0];
  const token = new URL(link).searchParams.get('token');
  assert.ok(token);

  const requested = await waitForSecurity({ action: 'auth.password_reset.requested', resourceId: ws.userId });
  assertCatalogue(requested, 'PASSWORD_RESET_REQUESTED');
  assert.equal(requested.actorId, ws.userId, 'an anonymous request is attributed to the account holder');
  assert.equal(requested.tenantId, ws.tenantId);
  assert.match(requested.ip, /127\.0\.0\.1/);

  const newPassword = 'BrandNewPassword123!';
  const reset = await api('/api/v1/auth/password/reset', { method: 'POST', headers: { 'X-Tenant-Id': ws.tenantId }, body: { token, newPassword } });
  assert.equal(reset.status, 200, JSON.stringify(reset.json));
  const completed = await waitForSecurity({ action: 'auth.password_reset.completed', actorId: ws.userId });
  assertCatalogue(completed, 'PASSWORD_RESET_COMPLETED');
  assert.equal(completed.tenantId, ws.tenantId);
  assert.ok(completed.metadata.sessionsRevoked >= 1);
  const revoked = await waitForSecurity({ action: 'auth.session.revoked', reason: 'password_reset' });
  assert.equal(revoked.tenantId, ws.tenantId);
  assert.equal(revoked.metadata.subjectId, ws.userId);

  // The password change shows as a changed field on the user row, never as a value.
  const change = await AuditLog.findOne({ module: 'iam.users', action: 'update', resourceId: ws.userId, 'metadata.changedFields': 'passwordHash' }).lean();
  assert.ok(change, 'the model row names the changed credential field');
  assert.equal(change.after?.passwordHash, undefined);

  await assertNoSecrets([token, newPassword, PASSWORD]);
});

/* --------------------------- roles and privileges -------------------------- */

test('permission and role grants and revocations are recorded with actor, tenant scope and ip', async () => {
  const operator = await seedAdmin({ adminType: 'super' });
  // A tenant-scoped grant is only accepted for an admin scoped to that tenant (roles).
  const target = await seedAdmin({ adminType: 'support', tenantScope: 'tenant-support-9' });
  await ensurePermission('dashboards.view');
  const tenantRole = await roleService.create({ tenantId: 'tenant-roles-1', name: `tr_${shortToken(8)}` });
  const platformRole = await roleService.create({ tenantId: null, name: `pr_${shortToken(8)}` });

  await asAdmin(operator, async () => {
    await roleService.addPermission({ roleId: tenantRole._id, permissionKey: 'dashboards.view', by: String(operator._id) });
    await roleService.removePermission({ roleId: tenantRole._id, permissionKey: 'dashboards.view', by: String(operator._id) });
    await adminService.assignRole({ adminId: target._id, roleId: platformRole._id, tenantId: 'tenant-support-9', by: String(operator._id) });
    await adminService.revokeRole({ adminId: target._id, roleId: platformRole._id, tenantId: 'tenant-support-9', by: String(operator._id) });
  });

  for (const [key, filter, tenantId] of [
    ['PERMISSION_GRANTED', { action: 'rbac.permission.granted' }, 'tenant-roles-1'],
    ['PERMISSION_REVOKED', { action: 'rbac.permission.revoked' }, 'tenant-roles-1'],
    ['ROLE_GRANTED', { action: 'rbac.role.granted', resourceId: String(target._id) }, 'tenant-support-9'],
    ['ROLE_REVOKED', { action: 'rbac.role.revoked', resourceId: String(target._id) }, 'tenant-support-9'],
  ]) {
    const row = await waitForSecurity({ ...filter, actorId: String(operator._id) });
    assertCatalogue(row, key);
    assert.equal(row.actorType, 'admin');
    assert.equal(row.tenantId, tenantId, `${key} tenant`);
    assert.equal(row.ip, '203.0.113.7', `${key} ip`);
    assert.ok(row.requestId, `${key} request id`);
  }
  const granted = await waitForSecurity({ action: 'rbac.permission.granted' });
  assert.equal(granted.metadata.permission, 'dashboards.view');

  // The RolePermission hard delete is also a model row (gov.02).
  assert.ok(await AuditLog.findOne({ module: 'iam.roles', resourceType: 'rolepermission', action: 'delete' }).lean());
  assert.ok(await AuditLog.findOne({ module: 'iam.roles', resourceType: 'adminrole', action: { $in: ['delete', 'deleteMany'] } }).lean());
});

test('admin privilege changes and refused changes are recorded', async () => {
  const superAdmin = await seedAdmin({ adminType: 'super' });
  const target = await seedAdmin();
  const plain = await seedAdmin();
  // A request may only scope an admin to a tenant that exists (roles).
  const ws = await onboard();

  await asAdmin(superAdmin, () => adminService.update({
    id: String(target._id), patch: { adminType: 'support', tenantScope: ws.tenantId }, by: String(superAdmin._id),
  }));
  const changed = await waitForSecurity({ action: 'admin.privilege.changed', resourceId: String(target._id), 'metadata.operation': 'update' });
  assertCatalogue(changed, 'ADMIN_PRIVILEGE_CHANGED');
  assert.equal(changed.actorId, String(superAdmin._id));
  assert.deepEqual(changed.metadata.changes.adminType, { from: 'platform', to: 'support' });
  assert.deepEqual(changed.metadata.changes.tenantScope, { from: null, to: ws.tenantId });
  assert.equal(changed.ip, '203.0.113.7');

  await assert.rejects(
    () => asAdmin(plain, () => adminService.update({ id: String(target._id), patch: { adminType: 'super' }, by: String(plain._id) })),
    (err) => err.statusCode === 403,
  );
  const denied = await waitForSecurity({ action: 'admin.privilege.change_denied', actorId: String(plain._id) });
  assertCatalogue(denied, 'ADMIN_PRIVILEGE_CHANGE_DENIED');
  assert.equal(denied.result, 'failure');
  assert.equal(denied.metadata.reason, 'not_active_super');

  // Creating an admin is recorded too.
  const created = await waitForSecurity({ action: 'admin.privilege.changed', resourceId: String(target._id), 'metadata.operation': 'create' });
  assert.equal(created.metadata.changes.adminType.to, 'platform');
});

/* -------------------------------- support --------------------------------- */

test('support impersonation start and stop are security events (legacy action names kept)', async () => {
  const ws = await onboard();
  const admin = await seedAdmin();
  await supportAccessService.grantConsent({ tenantId: ws.tenantId, user: { id: ws.userId }, durationHours: 4 });
  const started = await supportService.impersonate({
    actor: { id: String(admin._id) }, targetUserId: ws.userId, reason: 'ticket 42', ip: '198.51.100.4', userAgent: 'ua', requestId: 'r-imp',
  });
  const start = await waitForSecurity({ module: 'support.impersonation', action: 'impersonate' });
  assertCatalogue(start, 'SUPPORT_IMPERSONATION_STARTED');
  assert.equal(start.actorId, String(admin._id));
  assert.equal(start.tenantId, ws.tenantId);
  assert.equal(start.ip, '198.51.100.4');
  assert.equal(start.reason, 'ticket 42');
  assert.equal(start.metadata.targetUserId, ws.userId);

  await supportService.stopImpersonation({
    actor: { id: String(admin._id) }, sessionId: started.sessionId, reason: 'done', ip: '198.51.100.4', userAgent: 'ua', requestId: 'r-stop',
  });
  const stop = await waitForSecurity({ module: 'support.impersonation', action: 'impersonate.stop' });
  assertCatalogue(stop, 'SUPPORT_IMPERSONATION_STOPPED');
  assert.equal(stop.tenantId, ws.tenantId);
  await assertNoSecrets([started.token]);
});

/* ------------------------- API keys and embed tokens ----------------------- */

test('API key create, rotate and revoke are recorded without the secret', async () => {
  const ws = await onboard();
  const created = await api('/api/v1/api-keys', { method: 'POST', headers: ws.auth, body: { name: 'ci', scopes: ['datasets:read'] } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const keyId = String(created.json.data.key.id);
  const createdRow = await waitForSecurity({ action: 'api_key.created', resourceId: keyId });
  assertCatalogue(createdRow, 'API_KEY_CREATED');
  assert.equal(createdRow.actorId, ws.userId);
  assert.equal(createdRow.tenantId, ws.tenantId);
  assert.match(createdRow.ip, /127\.0\.0\.1/);
  assert.deepEqual(createdRow.metadata.scopes, ['datasets:read']);

  const rotated = await runWithRequestContext({ ip: '192.0.2.10' }, () => runWithContext(
    { actor: { type: 'user', id: ws.userId, tenantId: ws.tenantId } },
    () => apiKeyService.rotateApiKey({ tenantId: ws.tenantId, keyId, actorId: ws.userId, reason: 'scheduled' }),
  ));
  const rotatedRow = await waitForSecurity({ action: 'api_key.rotated', resourceId: keyId });
  assertCatalogue(rotatedRow, 'API_KEY_ROTATED');
  assert.equal(rotatedRow.metadata.newKeyId, String(rotated.newKey.id));
  assert.equal(rotatedRow.ip, '192.0.2.10');
  assert.equal(await AuditLog.countDocuments({ action: { $in: ['api_key.created', 'api_key.revoked'] }, resourceId: String(rotated.newKey.id) }), 0,
    'a rotation is one event, not a create plus a revoke');

  const revoked = await api(`/api/v1/api-keys/${rotated.newKey.id}/revoke`, { method: 'POST', headers: ws.auth, body: { reason: 'leaked' } });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.json));
  const revokedRow = await waitForSecurity({ action: 'api_key.revoked', resourceId: String(rotated.newKey.id) });
  assertCatalogue(revokedRow, 'API_KEY_REVOKED');
  assert.equal(revokedRow.reason, 'leaked');
  assert.equal(revokedRow.tenantId, ws.tenantId);

  // The model row for the key keeps the allow-list: no hash, ISO dates.
  const keyRow = await AuditLog.findOne({ module: 'api_keys', action: 'create', resourceId: keyId }).lean();
  assert.equal(keyRow.after.secretHash, undefined);
  assert.match(keyRow.after.expiresAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);

  await assertNoSecrets([created.json.data.secret, created.json.data.secret.split('.')[1], rotated.secret]);
});

test('embed token create and revoke are recorded without the token', async () => {
  const ws = await onboard();
  const dash = await api('/api/v1/dashboards', { method: 'POST', headers: ws.auth, body: { name: 'Public KPIs' } });
  assert.equal(dash.status, 201, JSON.stringify(dash.json));
  const dashboardId = dash.json.data._id;
  assert.equal((await api(`/api/v1/dashboards/${dashboardId}/publish`, { method: 'POST', headers: ws.auth })).status, 200);

  const minted = await api('/api/v1/embed/tokens', { method: 'POST', headers: ws.auth, body: { dashboardId, ttlSec: 600, allowedOrigins: ['https://host.example.com'] } });
  assert.equal(minted.status, 201, JSON.stringify(minted.json));
  const tokenId = String(minted.json.data.token.id);
  const createdRow = await waitForSecurity({ action: 'embed_token.created', resourceId: tokenId });
  assertCatalogue(createdRow, 'EMBED_TOKEN_CREATED');
  assert.equal(createdRow.actorId, ws.userId);
  assert.equal(createdRow.tenantId, ws.tenantId);
  assert.equal(createdRow.metadata.dashboardId, String(dashboardId));
  assert.match(createdRow.ip, /127\.0\.0\.1/);

  const revoke = await api(`/api/v1/embed/tokens/${tokenId}/revoke`, { method: 'POST', headers: ws.auth, body: { reason: 'rotated' } });
  assert.equal(revoke.status, 200, JSON.stringify(revoke.json));
  const revokedRow = await waitForSecurity({ action: 'embed_token.revoked', resourceId: tokenId });
  assertCatalogue(revokedRow, 'EMBED_TOKEN_REVOKED');

  // Model row: allow-listed fields, ObjectId refs as 24-hex strings.
  const tokenRow = await AuditLog.findOne({ module: 'embed', action: 'create', resourceId: tokenId }).lean();
  assert.match(tokenRow.after.dashboardId, /^[0-9a-f]{24}$/);
  assert.equal(tokenRow.after.tokenHash, undefined);

  await assertNoSecrets([minted.json.data.secret]);
});

/* -------------------------------- sessions --------------------------------- */

test('logout and refresh-token replay are recorded as session events', async () => {
  const ws = await onboard();
  const out = await api('/api/v1/auth/logout', { method: 'POST', headers: ws.auth, cookies: [ws.cookie] });
  assert.equal(out.status, 200);
  const logout = await waitForSecurity({ action: 'auth.session.revoked', reason: 'logout' });
  assertCatalogue(logout, 'SESSION_REVOKED');
  assert.equal(logout.actorId, ws.userId);
  assert.equal(logout.tenantId, ws.tenantId);
  assert.equal(logout.resourceType, 'session');
  assert.match(logout.ip, /127\.0\.0\.1/);

  // A second login, then its refresh token is presented after the session
  // was ended for another reason: a replay, so the family is revoked.
  const login = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': ws.tenantId }, body: { email: ws.email, password: PASSWORD } });
  const cookie = refreshCookieFrom(login);
  assert.equal(login.status, 200);
  const session = await Session.findOne({ actorId: ws.userId, status: 'active' }).lean();
  await sessionRepository.revoke(session.sessionId, 'admin_forced');
  const replay = await api('/api/v1/auth/refresh', { method: 'POST', cookies: [cookie] });
  assert.equal(replay.status, 401);
  const detected = await waitForSecurity({ action: 'auth.session.replay_detected', actorId: ws.userId });
  assertCatalogue(detected, 'SESSION_REPLAY_DETECTED');
  assert.equal(detected.severity, 'critical');
  assert.equal(detected.tenantId, ws.tenantId);
  assert.match(detected.ip, /127\.0\.0\.1/);
  await assertNoSecrets([cookie.split('=')[1]]);
});
