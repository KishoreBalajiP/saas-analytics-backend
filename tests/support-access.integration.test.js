/**
 * Support access redesign (roadmap 2.3) - HTTP integration tests.
 *
 * WHAT IT PROVES (exit criteria)
 *   - Impersonation without workspace consent is refused (and recorded on
 *     the workspace's trail); break-glass needs a DIFFERENT active super
 *     admin, is flagged on the grant, session record and audit rows, and is
 *     usable only by the requesting admin.
 *   - A support session is read-only: POST/PUT/PATCH/DELETE are refused
 *     with 403 IMPERSONATION_READ_ONLY before any handler runs; it expires
 *     with its token and can never be refreshed.
 *   - Every request of a support session is attributed to the operator on
 *     the access log, and audit rows written in its context carry
 *     `impersonatedBy`.
 *   - Concurrent starts cannot exceed the per-admin daily cap (atomic
 *     counter, no access-log flush involved).
 *   - Workspaces see their grants, support sessions and support activity;
 *     other workspaces and members without settings permissions do not.
 *   - Sanitised diagnostics carry no secrets or personal data and respect
 *     the admin's tenant scope.
 *
 * DESIGN
 *   Real Express app on an ephemeral port + in-memory MongoDB. Workspaces
 *   are onboarded through `tenantService.create({ initialize: true })` so
 *   the Owner holds the default `settings.*` permissions.
 */

import test, { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from './helpers/mongo.js';
import { startHttp, stopHttp, api } from './helpers/http.js';
import { shortToken } from '../src/utils/id.js';
import { hash } from '../src/utils/password.js';
import adminService from '../src/services/admin.service.js';
import roleService from '../src/services/role.service.js';
import permissionService from '../src/services/permission.service.js';
import * as tenantService from '../src/services/tenant.service.js';
import rbacCache from '../src/services/rbac.cache.service.js';
import * as cacheService from '../src/services/cache.service.js';
import * as accessLogService from '../src/services/accessLog.service.js';
import { emit as emitAudit } from '../src/services/auditLog.service.js';
import actorStatus from '../src/modules/iam/auth/actorStatus.service.js';
import sessionService from '../src/modules/iam/auth/session.service.js';
import userRepository from '../src/repositories/user.repository.js';
import roleRepository from '../src/repositories/role.repository.js';
import supportAccessRepository from '../src/repositories/supportAccess.repository.js';
import { runWithContext } from '../src/utils/actorContext.js';
import { authenticateToken } from '../src/middleware/auth.middleware.js';
import { AuditLog } from '../src/models/AuditLog.js';
import { AccessLog } from '../src/models/AccessLog.js';
import { Session } from '../src/models/Session.js';
import { Tenant } from '../src/models/Tenant.js';
import { UserRole } from '../src/models/UserRole.js';
import { Connector } from '../src/models/Connector.js';
import { ConnectorRow } from '../src/models/ConnectorRow.js';
import { SyncRun } from '../src/models/SyncRun.js';
import { Dashboard } from '../src/models/Dashboard.js';
import { SupportImpersonation } from '../src/models/SupportImpersonation.js';
import { SupportImpersonationCounter } from '../src/models/SupportImpersonationCounter.js';
import { SupportAccessGrant } from '../src/models/SupportAccessGrant.js';
import env from '../src/config/env.js';

const PASSWORD = 'Password123!';

/* -------------------------------- fixtures -------------------------------- */

async function ensureModule(key) {
  if (key.includes('.')) await ensureModule(key.slice(0, key.lastIndexOf('.')));
  try {
    await permissionService.createModule({ key, name: key });
  } catch (err) {
    if (err.statusCode !== 409) throw err;
  }
}

async function ensurePermission(key) {
  const module = key.slice(0, key.lastIndexOf('.'));
  const action = key.slice(key.lastIndexOf('.') + 1);
  await ensureModule(module);
  try {
    await permissionService.createPermission({ module, action });
  } catch (err) {
    if (err.statusCode !== 409) throw err;
  }
}

/** A platform admin holding `permissions`, logged in. */
async function seedAdmin({
  permissions = ['support.configure', 'support.view'],
  adminType = 'platform',
  tenantScope = null,
  email = null,
} = {}) {
  const admin = await adminService.create({
    email: email ?? `admin-${shortToken(8).toLowerCase()}@platform.test`,
    password: PASSWORD,
    adminType,
    name: 'Support Operator',
    tenantScope,
  });
  const role = await roleService.create({ tenantId: null, name: `role_${shortToken(8)}` });
  for (const key of permissions) {
    await ensurePermission(key);
    await roleService.addPermission({ roleId: role._id, permissionKey: key, by: null /* fixture seeding */ });
  }
  // A scoped admin's grants live inside its scope (admin tokens carry it).
  await adminService.assignRole({ adminId: admin._id, roleId: role._id, tenantId: tenantScope, by: null /* fixture seeding */ });
  const login = await api('/api/v1/admin-auth/login', { method: 'POST', body: { email: admin.email, password: PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  const auth = { authorization: `Bearer ${login.json.data.accessToken}` };
  // adminauth: break-glass approval needs a fresh step-up; take one up front.
  const stepUp = await api('/api/v1/admin-auth/step-up', { method: 'POST', headers: auth, body: { password: PASSWORD } });
  assert.equal(stepUp.status, 200, JSON.stringify(stepUp.json));
  return { admin, id: String(admin._id), auth };
}

/** A workspace with an Owner (default roles), logged in. */
async function onboard({ billingEmail = null } = {}) {
  const ownerEmail = `owner-${shortToken(10).toLowerCase()}@example.com`;
  const { tenant } = await tenantService.create({
    tenant: { name: `Support ${shortToken(8)}`, ...(billingEmail ? { billingEmail } : {}) },
    owner: { email: ownerEmail, name: 'Olivia Owner', password: PASSWORD },
    initialize: true,
    by: 'root',
  });
  const tenantId = String(tenant._id);
  const owner = await userRepository.findByEmail(tenantId, ownerEmail);
  const login = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email: ownerEmail, password: PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return {
    tenantId,
    owner,
    ownerId: String(owner._id),
    ownerEmail,
    auth: { authorization: `Bearer ${login.json.data.accessToken}`, 'X-Tenant-Id': tenantId },
  };
}

/** Another member of a workspace, optionally holding a default role. */
async function member(tenantId, roleName = null) {
  const email = `member-${shortToken(10).toLowerCase()}@example.com`;
  const user = await userRepository.create({ tenantId, email, status: 'active', passwordHash: await hash(PASSWORD), profile: { name: 'Member' } });
  if (roleName) {
    const role = await roleRepository.findByName({ tenantId, name: roleName });
    await UserRole.create({ tenantId, userId: String(user._id), roleId: String(role._id), grantedBy: 'test', grantedAt: new Date() });
  }
  const login = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email, password: PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return { user, auth: { authorization: `Bearer ${login.json.data.accessToken}`, 'X-Tenant-Id': tenantId } };
}

async function grantConsent(workspace, { durationHours = 4, note = 'Ticket 4711' } = {}) {
  const res = await api('/api/v1/workspace/support-access/grants', {
    method: 'POST',
    headers: workspace.auth,
    body: { durationHours, note },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.data;
}

function impersonate(operator, userId, { reason = 'Customer reported missing dashboard data', ticket = 'T-1' } = {}) {
  return api('/api/v1/support/impersonate', {
    method: 'POST',
    headers: operator.auth,
    body: { targetUserId: String(userId), reason, ticket },
  });
}

function supportAuth(started, tenantId) {
  return { authorization: `Bearer ${started.json.data.token}`, 'X-Tenant-Id': tenantId };
}

function decodeJwt(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

/* --------------------------------- suite ---------------------------------- */

describe('support access redesign (roadmap 2.3)', () => {
  const originalCap = env.support.impersonationBudgetDailyCap;
  const originalTtl = env.support.impersonationTokenTtl;

  before(async () => {
    await startMongo();
    await startHttp();
  });

  after(async () => {
    await stopHttp();
    await stopMongo();
  });

  beforeEach(async () => {
    await resetMongo();
    await rbacCache.clearAll();
    await cacheService.flushAll();
    actorStatus.clear();
    env.support.impersonationBudgetDailyCap = 1000;
    env.support.impersonationTokenTtl = originalTtl;
  });

  after(() => {
    env.support.impersonationBudgetDailyCap = originalCap;
    env.support.impersonationTokenTtl = originalTtl;
  });

  /* ------------------------------ consent ------------------------------ */

  test('impersonation without workspace consent is refused and recorded on the workspace trail', async () => {
    const operator = await seedAdmin();
    const ws = await onboard();

    const res = await impersonate(operator, ws.ownerId);
    assert.equal(res.status, 403, JSON.stringify(res.json));
    assert.equal(res.json.code, 'SUPPORT_CONSENT_REQUIRED');

    assert.equal(await Session.countDocuments({ impersonatedBy: operator.id }), 0, 'no session was opened');
    assert.equal(await supportAccessRepository.readDailyCounter({ adminId: operator.id }), 0, 'no budget was consumed');
    const refused = await AuditLog.findOne({ tenantId: ws.tenantId, module: 'support.impersonation', action: 'impersonate.refused' }).lean();
    assert.ok(refused, 'the refusal is on the workspace audit trail');
    assert.equal(refused.result, 'failure');
    assert.equal(refused.actorId, operator.id);
  });

  test('consent is validated and only settings.configure holders can grant or revoke it', async () => {
    const ws = await onboard();
    const viewer = await member(ws.tenantId, 'Viewer');
    const nobody = await member(ws.tenantId);

    const zero = await api('/api/v1/workspace/support-access/grants', { method: 'POST', headers: ws.auth, body: { durationHours: 0 } });
    assert.equal(zero.status, 422);
    const missing = await api('/api/v1/workspace/support-access/grants', { method: 'POST', headers: ws.auth, body: {} });
    assert.equal(missing.status, 422);
    const tooLong = await api('/api/v1/workspace/support-access/grants', {
      method: 'POST',
      headers: ws.auth,
      body: { durationHours: env.support.consentMaxHours + 1 },
    });
    assert.equal(tooLong.status, 400);
    assert.ok(tooLong.json.errors.some((e) => e.field === 'durationHours'));

    for (const who of [viewer, nobody]) {
      const grant = await api('/api/v1/workspace/support-access/grants', { method: 'POST', headers: who.auth, body: { durationHours: 2 } });
      assert.equal(grant.status, 403);
      const read = await api('/api/v1/workspace/support-access', { headers: who.auth });
      assert.equal(read.status, 403);
    }
    assert.equal((await api('/api/v1/workspace/support-access')).status, 401);
    assert.equal(await SupportAccessGrant.countDocuments({}), 0);

    const granted = await grantConsent(ws, { durationHours: 2 });
    assert.equal(granted.kind, 'consent');
    assert.equal(granted.status, 'active');
    assert.equal(granted.grantedBy.id, ws.ownerId);
    const hours = (new Date(granted.expiresAt) - new Date(granted.startsAt)) / 3_600_000;
    assert.equal(Math.round(hours), 2);

    // A new consent supersedes the old one.
    const second = await grantConsent(ws, { durationHours: 1 });
    const first = await SupportAccessGrant.findOne({ grantId: granted.id }).lean();
    assert.equal(first.status, 'revoked');
    const state = await api('/api/v1/workspace/support-access', { headers: ws.auth });
    assert.equal(state.json.data.active.id, second.id);
  });

  /* ------------------------ read-only and time-box --------------------- */

  test('a consented support session is read-only, attributed to the operator, and time-boxed', async () => {
    const operator = await seedAdmin();
    const ws = await onboard();
    const consent = await grantConsent(ws);

    const started = await impersonate(operator, ws.ownerId);
    assert.equal(started.status, 200, JSON.stringify(started.json));
    assert.equal(started.json.data.readOnly, true);
    assert.equal(started.json.data.breakGlass, false);
    assert.equal(started.json.data.grantId, consent.id);
    const auth = supportAuth(started, ws.tenantId);

    // Time-boxed: the session ends with the token.
    const payload = decodeJwt(started.json.data.token);
    assert.equal(payload.impersonation, true);
    const session = await Session.findOne({ sessionId: started.json.data.sessionId }).lean();
    assert.equal(session.impersonatedBy, operator.id);
    assert.ok(Math.abs(new Date(session.expiresAt).getTime() - payload.exp * 1000) <= 2000, 'session expiry equals token expiry');
    assert.ok(payload.exp - payload.iat <= 3600, 'never longer than an hour');

    // Reads work.
    const me = await api('/api/v1/auth/me', { headers: auth });
    assert.equal(me.status, 200, JSON.stringify(me.json));
    const settings = await api('/api/v1/workspace/settings', { headers: auth });
    assert.equal(settings.status, 200);

    // Every unsafe method is refused before the handler, even for an Owner.
    const writes = [
      ['POST', '/api/v1/api-keys', { name: 'support-key' }],
      ['PATCH', '/api/v1/workspace/settings', { timezone: 'Asia/Kolkata' }],
      ['PATCH', '/api/v1/users/me', { name: 'Changed by support' }],
      ['DELETE', '/api/v1/dashboards/0123456789abcdef01234567', undefined],
      ['POST', '/api/v1/workspace/support-access/grants', { durationHours: 72 }],
      ['POST', '/api/v1/auth/logout', {}],
    ];
    for (const [method, path, body] of writes) {
      const res = await api(path, { method, headers: auth, body });
      assert.equal(res.status, 403, `${method} ${path} -> ${res.status}`);
      assert.equal(res.json.code, 'IMPERSONATION_READ_ONLY', `${method} ${path}`);
    }
    const after = await api('/api/v1/workspace/settings', { headers: ws.auth });
    assert.equal(after.json.data.timezone, 'UTC', 'nothing was changed');

    // Attribution: every request of the support session names the operator.
    await accessLogService.flush();
    const rows = await AccessLog.find({ actorId: ws.ownerId, impersonatedBy: operator.id }).lean();
    assert.ok(rows.some((r) => r.method === 'GET' && r.path.startsWith('/api/v1/auth/me') && r.statusCode === 200));
    assert.ok(rows.some((r) => r.method === 'POST' && r.path.startsWith('/api/v1/api-keys') && r.statusCode === 403));
    const ownRows = await AccessLog.find({ actorId: ws.ownerId, impersonatedBy: null }).lean();
    assert.ok(ownRows.every((r) => !r.path.startsWith('/api/v1/api-keys')), 'the customer is not blamed for the refused write');

    // The start row on the workspace trail carries the session facts.
    const startRow = await AuditLog.findOne({ tenantId: ws.tenantId, module: 'support.impersonation', action: 'impersonate' }).lean();
    assert.equal(startRow.actorId, operator.id);
    // Security events keep their facts in metadata.
    assert.equal(startRow.metadata.grantId, consent.id);
    assert.equal(startRow.metadata.readOnly, true);
  });

  test('the read-only guard refuses PUT/POST/PATCH/DELETE for support sessions at the middleware', async () => {
    const operator = await seedAdmin();
    const ws = await onboard();
    await grantConsent(ws);
    const started = await impersonate(operator, ws.ownerId);
    assert.equal(started.status, 200);

    const guard = authenticateToken();
    const run = (method) => new Promise((resolve) => {
      const req = { method, headers: { authorization: `Bearer ${started.json.data.token}` }, id: `req-${method}` };
      guard(req, {}, (err) => resolve({ err, req }));
    });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const { err } = await run(method);
      assert.equal(err?.statusCode, 403, method);
      assert.equal(err?.code, 'IMPERSONATION_READ_ONLY', method);
    }
    const { err, req } = await run('GET');
    assert.equal(err, undefined);
    assert.equal(req.user.impersonation, true);
    assert.equal(req.user.impersonatedBy, operator.id);

    // A normal session is not affected by the guard.
    const normal = await new Promise((resolve) => {
      const r = { method: 'PUT', headers: { authorization: ws.auth.authorization }, id: 'req-normal' };
      guard(r, {}, (e) => resolve({ e, r }));
    });
    assert.equal(normal.e, undefined);
    assert.equal(normal.r.user.impersonatedBy, undefined);
  });

  test('support sessions never refresh, stop working at expiry, and never outlive the grant or an hour', async () => {
    const operator = await seedAdmin();
    const ws = await onboard();
    const consent = await grantConsent(ws);
    const started = await impersonate(operator, ws.ownerId);
    assert.equal(started.status, 200);
    const auth = supportAuth(started, ws.tenantId);

    const session = await Session.findOne({ sessionId: started.json.data.sessionId }).lean();
    await assert.rejects(
      () => sessionService.rotate({ session, refreshToken: sessionService.generateRefreshToken() }),
      (err) => err.statusCode === 401,
    );
    const refresh = await api('/api/v1/auth/refresh', { method: 'POST', headers: { 'X-Tenant-Id': ws.tenantId } });
    assert.equal(refresh.status, 401, 'no refresh cookie was ever issued for a support session');

    await Session.updateOne({ sessionId: started.json.data.sessionId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await api('/api/v1/auth/me', { headers: auth })).status, 401);

    // A configured TTL above an hour is capped.
    env.support.impersonationTokenTtl = '24h';
    const long = await impersonate(operator, ws.ownerId);
    assert.equal(long.status, 200);
    assert.ok(long.json.data.expiresIn <= 3600);

    // A session never outlives the grant it was opened under.
    env.support.impersonationTokenTtl = '30m';
    const grantEnd = new Date(Date.now() + 5 * 60 * 1000);
    await SupportAccessGrant.updateOne({ grantId: consent.id }, { $set: { expiresAt: grantEnd } });
    const short = await impersonate(operator, ws.ownerId);
    assert.equal(short.status, 200);
    const shortSession = await Session.findOne({ sessionId: short.json.data.sessionId }).lean();
    assert.ok(new Date(shortSession.expiresAt).getTime() <= grantEnd.getTime() + 1000);
  });

  test('impersonation is refused for a suspended workspace and live support sessions end with it', async () => {
    const operator = await seedAdmin();
    const ws = await onboard();
    await grantConsent(ws);
    const started = await impersonate(operator, ws.ownerId);
    assert.equal(started.status, 200);

    await Tenant.updateOne({ _id: ws.tenantId }, { $set: { status: 'suspended', suspendedAt: new Date() } });
    actorStatus.clear();

    const me = await api('/api/v1/auth/me', { headers: supportAuth(started, ws.tenantId) });
    assert.equal(me.status, 401);
    assert.equal(me.json.code, 'TENANT_NOT_ACTIVE');

    const again = await impersonate(operator, ws.ownerId);
    assert.equal(again.status, 409);
    assert.equal(again.json.code, 'TENANT_NOT_ACTIVE');
  });

  /* ------------------------------ break-glass -------------------------- */

  test('break-glass needs a different super admin, is flagged, and only the requester can use it', async () => {
    const requester = await seedAdmin();
    const colleague = await seedAdmin();
    const approver = await seedAdmin({ permissions: ['support.approve', 'support.view'], adminType: 'super' });
    const platformApprover = await seedAdmin({ permissions: ['support.approve'], adminType: 'platform' });
    const selfApprover = await seedAdmin({ permissions: ['support.configure', 'support.approve'], adminType: 'super' });
    const ws = await onboard();

    const tooShort = await api('/api/v1/support/access-grants/break-glass', {
      method: 'POST', headers: requester.auth, body: { tenantId: ws.tenantId, reason: 'urgent' },
    });
    assert.equal(tooShort.status, 422);

    const requested = await api('/api/v1/support/access-grants/break-glass', {
      method: 'POST',
      headers: requester.auth,
      body: { tenantId: ws.tenantId, reason: 'Production incident INC-42: dashboards empty', ticket: 'INC-42' },
    });
    assert.equal(requested.status, 201, JSON.stringify(requested.json));
    assert.equal(requested.json.data.status, 'pending');
    assert.equal(requested.json.data.breakGlass, true);
    const grantId = requested.json.data.id;

    // Pending is not usable.
    assert.equal((await impersonate(requester, ws.ownerId)).json.code, 'SUPPORT_CONSENT_REQUIRED');

    // The requester cannot decide (no support.approve) ...
    const noPerm = await api(`/api/v1/support/access-grants/${grantId}/approve`, { method: 'POST', headers: requester.auth, body: { reason: 'self' } });
    assert.equal(noPerm.status, 403);
    // ... a platform (non-super) admin cannot ...
    const notSuper = await api(`/api/v1/support/access-grants/${grantId}/approve`, { method: 'POST', headers: platformApprover.auth, body: { reason: 'looks fine' } });
    assert.equal(notSuper.status, 403);
    assert.equal(notSuper.json.code, 'BREAK_GLASS_APPROVAL_DENIED');
    // ... and a super admin cannot approve their own request (four eyes).
    const own = await api('/api/v1/support/access-grants/break-glass', {
      method: 'POST', headers: selfApprover.auth, body: { tenantId: ws.tenantId, reason: 'Own incident request for testing' },
    });
    const ownDecision = await api(`/api/v1/support/access-grants/${own.json.data.id}/approve`, { method: 'POST', headers: selfApprover.auth, body: { reason: 'mine' } });
    assert.equal(ownDecision.status, 403);
    assert.equal(ownDecision.json.code, 'BREAK_GLASS_APPROVAL_DENIED');

    const approved = await api(`/api/v1/support/access-grants/${grantId}/approve`, { method: 'POST', headers: approver.auth, body: { reason: 'Incident confirmed with on-call' } });
    assert.equal(approved.status, 200, JSON.stringify(approved.json));
    assert.equal(approved.json.data.status, 'active');
    assert.equal(approved.json.data.decidedBy.id, approver.id);
    const twice = await api(`/api/v1/support/access-grants/${grantId}/approve`, { method: 'POST', headers: approver.auth, body: { reason: 'again' } });
    assert.equal(twice.status, 409);

    // Only the requester can use it.
    const other = await impersonate(colleague, ws.ownerId);
    assert.equal(other.status, 403);
    assert.equal(other.json.code, 'SUPPORT_CONSENT_REQUIRED');
    const started = await impersonate(requester, ws.ownerId);
    assert.equal(started.status, 200, JSON.stringify(started.json));
    assert.equal(started.json.data.breakGlass, true);
    assert.equal(started.json.data.grantId, grantId);

    // Flagged everywhere.
    const record = await SupportImpersonation.findOne({ sessionId: started.json.data.sessionId }).lean();
    assert.equal(record.breakGlass, true);
    assert.equal(record.kind, 'break_glass');
    const startRow = await AuditLog.findOne({ tenantId: ws.tenantId, action: 'impersonate' }).lean();
    assert.equal(startRow.metadata.breakGlass, true);
    assert.ok(await AuditLog.findOne({ tenantId: ws.tenantId, module: 'support.access', action: 'break_glass.approved' }).lean());

    // The workspace sees it, and cannot revoke platform break-glass itself.
    const view = await api('/api/v1/workspace/support-access', { headers: ws.auth });
    assert.ok(view.json.data.grants.some((g) => g.id === grantId && g.breakGlass === true));
    assert.ok(view.json.data.sessions.some((s) => s.id === started.json.data.sessionId && s.breakGlass === true));
    const wsRevoke = await api(`/api/v1/workspace/support-access/grants/${grantId}/revoke`, { method: 'POST', headers: ws.auth, body: {} });
    assert.equal(wsRevoke.status, 403);

    // Platform staff can revoke it early, which ends the session.
    const revoked = await api(`/api/v1/support/access-grants/${grantId}/revoke`, { method: 'POST', headers: requester.auth, body: { reason: 'Incident resolved' } });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.json));
    assert.deepEqual(revoked.json.data.endedSessions, [started.json.data.sessionId]);
    assert.equal((await api('/api/v1/auth/me', { headers: supportAuth(started, ws.tenantId) })).status, 401);
  });

  test('a denied break-glass request can never be used', async () => {
    const requester = await seedAdmin();
    const approver = await seedAdmin({ permissions: ['support.approve'], adminType: 'super' });
    const ws = await onboard();
    const requested = await api('/api/v1/support/access-grants/break-glass', {
      method: 'POST', headers: requester.auth, body: { tenantId: ws.tenantId, reason: 'Investigate an export failure' },
    });
    const noReason = await api(`/api/v1/support/access-grants/${requested.json.data.id}/deny`, { method: 'POST', headers: approver.auth, body: {} });
    assert.equal(noReason.status, 422);
    const denied = await api(`/api/v1/support/access-grants/${requested.json.data.id}/deny`, { method: 'POST', headers: approver.auth, body: { reason: 'Ask the customer for consent' } });
    assert.equal(denied.status, 200);
    assert.equal(denied.json.data.status, 'denied');
    assert.equal((await impersonate(requester, ws.ownerId)).status, 403);
    const late = await api(`/api/v1/support/access-grants/${requested.json.data.id}/approve`, { method: 'POST', headers: approver.auth, body: { reason: 'changed my mind' } });
    assert.equal(late.status, 409);
  });

  /* -------------------------------- caps -------------------------------- */

  test('concurrent starts cannot exceed the daily cap (no access-log flush involved)', async () => {
    env.support.impersonationBudgetDailyCap = 3;
    const operator = await seedAdmin();
    const ws = await onboard();
    await grantConsent(ws);

    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => impersonate(operator, ws.ownerId, { reason: `parallel start ${i}` })));
    const ok = results.filter((r) => r.status === 200);
    const capped = results.filter((r) => r.status === 429);
    assert.equal(ok.length, 3, results.map((r) => r.status).join(','));
    assert.equal(capped.length, 5);
    assert.ok(capped.every((r) => r.json.code === 'SUPPORT_IMPERSONATION_CAP_EXCEEDED'));
    assert.equal(await supportAccessRepository.readDailyCounter({ adminId: operator.id }), 3);
    assert.equal(await SupportImpersonation.countDocuments({ adminId: operator.id }), 3);
    assert.equal(await Session.countDocuments({ impersonatedBy: operator.id }), 3);

    // The cap is per admin.
    const other = await seedAdmin();
    assert.equal((await impersonate(other, ws.ownerId)).status, 200);
  });

  test('the atomic daily counter never passes the cap under contention', async () => {
    const adminId = 'adm_contention';
    const counts = await Promise.all(Array.from({ length: 25 }, () => supportAccessRepository.incrementDailyCounter({ adminId, cap: 5 })));
    const granted = counts.filter((c) => c !== null).sort((a, b) => a - b);
    assert.deepEqual(granted, [1, 2, 3, 4, 5]);
    const doc = await SupportImpersonationCounter.findOne({ adminId }).lean();
    assert.equal(doc.count, 5);
    assert.ok(doc.expiresAt > new Date(), 'counter carries a TTL');
    await supportAccessRepository.decrementDailyCounter({ adminId });
    assert.equal(await supportAccessRepository.readDailyCounter({ adminId }), 4);
  });

  /* --------------------------- tenant visibility ----------------------- */

  test('workspaces see their grants, support sessions and support activity; nobody else does', async () => {
    const operator = await seedAdmin();
    const ws = await onboard();
    const otherWs = await onboard();
    const consent = await grantConsent(ws);
    const started = await impersonate(operator, ws.ownerId, { reason: 'Check widget configuration', ticket: 'T-99' });
    assert.equal(started.status, 200);
    const stopped = await api('/api/v1/support/impersonate/stop', {
      method: 'POST', headers: operator.auth, body: { sessionId: started.json.data.sessionId, reason: 'Done' },
    });
    assert.equal(stopped.status, 200);

    const view = await api('/api/v1/workspace/support-access', { headers: ws.auth });
    assert.equal(view.status, 200, JSON.stringify(view.json));
    assert.equal(view.json.data.active.id, consent.id);
    const session = view.json.data.sessions.find((s) => s.id === started.json.data.sessionId);
    assert.ok(session, 'the support session is listed');
    assert.equal(session.operator.id, operator.id);
    assert.equal(session.user.id, ws.ownerId);
    assert.equal(session.status, 'ended');
    assert.equal(session.reason, 'Check widget configuration');
    assert.equal(session.ticket, 'T-99');
    assert.equal(session.readOnly, true);

    const activity = await api('/api/v1/workspace/support-access/activity', { headers: ws.auth });
    assert.equal(activity.status, 200);
    const actions = activity.json.data.map((row) => row.action);
    for (const expected of ['grant.created', 'impersonate', 'impersonate.stop']) {
      assert.ok(actions.includes(expected), `${expected} in ${actions.join(',')}`);
    }
    assert.equal(activity.json.meta.total, activity.json.data.length);
    const json = JSON.stringify(activity.json.data);
    assert.ok(!json.includes('"ip"') && !json.includes('userAgent'), 'no IPs or user agents in the workspace view');

    // Isolation: another workspace sees none of it and cannot act on it.
    const otherView = await api('/api/v1/workspace/support-access', { headers: otherWs.auth });
    assert.equal(otherView.json.data.active, null);
    assert.equal(otherView.json.data.grants.length, 0);
    assert.equal(otherView.json.data.sessions.length, 0);
    const otherActivity = await api('/api/v1/workspace/support-access/activity', { headers: otherWs.auth });
    assert.equal(otherActivity.json.data.length, 0);
    const crossRevoke = await api(`/api/v1/workspace/support-access/grants/${consent.id}/revoke`, { method: 'POST', headers: otherWs.auth, body: {} });
    assert.equal(crossRevoke.status, 404);
    // A forged tenant header does not switch workspaces.
    const forged = await api('/api/v1/workspace/support-access', { headers: { ...otherWs.auth, 'X-Tenant-Id': ws.tenantId } });
    assert.equal(forged.status, 403);
  });

  test('revoking consent ends open support sessions immediately and blocks new ones', async () => {
    const operator = await seedAdmin();
    const ws = await onboard();
    const consent = await grantConsent(ws);
    const started = await impersonate(operator, ws.ownerId);
    assert.equal(started.status, 200);

    const revoked = await api(`/api/v1/workspace/support-access/grants/${consent.id}/revoke`, { method: 'POST', headers: ws.auth, body: { reason: 'No longer needed' } });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.json));
    assert.equal(revoked.json.data.status, 'revoked');
    assert.deepEqual(revoked.json.data.endedSessions, [started.json.data.sessionId]);

    assert.equal((await api('/api/v1/auth/me', { headers: supportAuth(started, ws.tenantId) })).status, 401);
    const record = await SupportImpersonation.findOne({ sessionId: started.json.data.sessionId }).lean();
    assert.equal(record.status, 'ended');
    assert.equal((await impersonate(operator, ws.ownerId)).json.code, 'SUPPORT_CONSENT_REQUIRED');
    const again = await api(`/api/v1/workspace/support-access/grants/${consent.id}/revoke`, { method: 'POST', headers: ws.auth, body: {} });
    assert.equal(again.status, 409);
  });

  test('the workspace can end a support session and a support session can end itself', async () => {
    const operator = await seedAdmin();
    const ws = await onboard();
    await grantConsent(ws);

    const first = await impersonate(operator, ws.ownerId);
    const ended = await api(`/api/v1/workspace/support-access/sessions/${first.json.data.sessionId}/end`, { method: 'POST', headers: ws.auth, body: { reason: 'We are done' } });
    assert.equal(ended.status, 200, JSON.stringify(ended.json));
    assert.equal(ended.json.data.status, 'ended');
    assert.equal((await api('/api/v1/auth/me', { headers: supportAuth(first, ws.tenantId) })).status, 401);
    const endedTwice = await api(`/api/v1/workspace/support-access/sessions/${first.json.data.sessionId}/end`, { method: 'POST', headers: ws.auth, body: {} });
    assert.equal(endedTwice.status, 409);

    const second = await impersonate(operator, ws.ownerId, { reason: 'Second look', ticket: 'T-2' });
    const auth = supportAuth(second, ws.tenantId);
    const current = await api('/api/v1/support-session', { headers: auth });
    assert.equal(current.status, 200);
    assert.equal(current.json.data.active, true);
    assert.equal(current.json.data.readOnly, true);
    assert.equal(current.json.data.operator.id, operator.id);
    assert.equal(current.json.data.user.id, ws.ownerId);
    assert.equal(current.json.data.ticket, 'T-2');
    assert.ok(new Date(current.json.data.expiresAt) > new Date());

    const self = await api('/api/v1/support-session/end', { method: 'POST', headers: auth, body: {} });
    assert.equal(self.status, 200, JSON.stringify(self.json));
    assert.equal(self.json.data.status, 'ended');
    assert.equal((await api('/api/v1/auth/me', { headers: auth })).status, 401);
    const endRow = await AuditLog.findOne({ tenantId: ws.tenantId, action: 'impersonate.end' }).lean();
    assert.equal(endRow.actorId, operator.id);
    assert.equal(endRow.impersonatedBy, operator.id);

    // A normal session is not a support session.
    const normal = await api('/api/v1/support-session', { headers: ws.auth });
    assert.deepEqual(normal.json.data, { active: false });
    const notSupport = await api('/api/v1/support-session/end', { method: 'POST', headers: ws.auth, body: {} });
    assert.equal(notSupport.status, 403);
    assert.equal(notSupport.json.code, 'IMPERSONATION_SESSION_REQUIRED');
    assert.equal((await api('/api/v1/auth/me', { headers: ws.auth })).status, 200, 'the owner session survives');
  });

  /* --------------------------- targets and scope ----------------------- */

  test('support never targets platform staff and never crosses its tenant scope', async () => {
    const wsA = await onboard();
    const wsB = await onboard();
    await grantConsent(wsA);
    await grantConsent(wsB);

    // A workspace user whose email is a platform admin account is protected.
    const staff = await member(wsA.tenantId);
    await seedAdmin({ email: staff.user.email, permissions: ['support.view'] });
    const operator = await seedAdmin();
    const protectedRes = await impersonate(operator, staff.user._id);
    assert.equal(protectedRes.status, 403);
    assert.equal(protectedRes.json.code, 'SUPPORT_TARGET_PROTECTED');

    // A support admin scoped to workspace B.
    const scoped = await seedAdmin({ tenantScope: wsB.tenantId, permissions: ['support.configure', 'support.view'] });
    assert.equal((await impersonate(scoped, wsA.ownerId)).status, 403);
    assert.equal((await api(`/api/v1/support/tenants/${wsA.tenantId}/diagnostics`, { headers: scoped.auth })).status, 403);
    const bg = await api('/api/v1/support/access-grants/break-glass', {
      method: 'POST', headers: scoped.auth, body: { tenantId: wsA.tenantId, reason: 'Out of scope incident request' },
    });
    assert.equal(bg.status, 403);
    assert.equal((await api(`/api/v1/support/access-grants?tenantId=${wsA.tenantId}`, { headers: scoped.auth })).status, 403);

    assert.equal((await api(`/api/v1/support/tenants/${wsB.tenantId}/diagnostics`, { headers: scoped.auth })).status, 200);
    const inScope = await impersonate(scoped, wsB.ownerId);
    assert.equal(inScope.status, 200);
    const grants = await api('/api/v1/support/access-grants', { headers: scoped.auth });
    assert.equal(grants.status, 200);
    assert.ok(grants.json.data.length > 0);
    assert.ok(grants.json.data.every((g) => g.tenantId === wsB.tenantId), 'a scoped admin only lists its tenant');
    const sessions = await api('/api/v1/support/impersonations?status=active', { headers: scoped.auth });
    assert.equal(sessions.status, 200);
    assert.ok(sessions.json.data.every((s) => s.tenantId === wsB.tenantId));
    assert.equal(sessions.json.meta.total, 1);
  });

  /* ------------------------------ diagnostics -------------------------- */

  test('diagnostics return operational facts without secrets or personal data', async () => {
    const billingEmail = `billing-${shortToken(8).toLowerCase()}@acme.test`;
    const ws = await onboard({ billingEmail });
    const connector = await Connector.create({
      tenantId: ws.tenantId,
      type: 'mongodb',
      name: 'Orders DB',
      status: 'error',
      config: 'ENCRYPTED-ENVELOPE-c2VjcmV0',
      fieldMapping: { customer_email: 'mapping-secret-field' },
      lastError: 'connect failed for mongodb://dbuser:hunter2@db.internal:27017/acme (owner jane.doe@acme.test)',
      errorCount: 3,
    });
    await ConnectorRow.create({ tenantId: ws.tenantId, connectorId: connector._id, sourceRowId: 'r1', data: { email: 'row.person@acme.test', secret: 'ROW-SECRET-VALUE' } });
    await SyncRun.create({
      tenantId: ws.tenantId,
      connectorId: String(connector._id),
      status: 'failed',
      error: { code: 'CONNECTOR_UNREACHABLE', message: 'password=hunter2 rejected for jane.doe@acme.test' },
      queuedAt: new Date(),
    });
    // Some traffic in the window.
    await api('/api/v1/workspace/settings', { headers: ws.auth });
    await api('/api/v1/dashboards/0123456789abcdef01234567', { headers: ws.auth });
    await accessLogService.flush();

    const viewer = await seedAdmin({ permissions: ['support.view'] });
    const res = await api(`/api/v1/support/tenants/${ws.tenantId}/diagnostics`, { headers: viewer.auth });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const d = res.json.data;
    assert.equal(d.tenant.id, ws.tenantId);
    assert.equal(d.tenant.status, 'active');
    assert.ok(d.users.total >= 1);
    assert.ok(d.users.byStatus.active >= 1);
    assert.equal(d.connectors.total, 1);
    assert.equal(d.connectors.withErrors, 1);
    assert.equal(d.connectors.items[0].type, 'mongodb');
    assert.match(d.connectors.items[0].lastError, /\*\*\*@db\.internal/);
    assert.match(d.connectors.items[0].lastError, /\[email\]/);
    assert.equal(d.syncRuns.failedInWindow, 1);
    assert.equal(d.syncRuns.recent[0].error.code, 'CONNECTOR_UNREACHABLE');
    assert.ok(d.requests.total >= 2);
    assert.ok(d.requests.topErrors.every((row) => !row.path.includes('?')));
    assert.ok('active' in d.supportAccess && 'openSessions' in d.supportAccess);
    assert.ok(d.usage && typeof d.usage === 'object');

    const json = JSON.stringify(d);
    for (const forbidden of [
      ws.ownerEmail, billingEmail, 'Olivia Owner', 'hunter2', 'ENCRYPTED-ENVELOPE', 'mapping-secret-field',
      'jane.doe@acme.test', 'row.person@acme.test', 'ROW-SECRET-VALUE', 'passwordHash', 'refreshTokenHash',
      'fieldMapping', 'config', 'webhookToken',
    ]) {
      assert.ok(!json.includes(forbidden), `diagnostics leaked "${forbidden}"`);
    }

    // Read is recorded on the workspace trail.
    const row = await AuditLog.findOne({ tenantId: ws.tenantId, module: 'support.diagnostics', action: 'diagnostics.viewed' }).lean();
    assert.equal(row.actorId, viewer.id);

    // Gating.
    const configureOnly = await seedAdmin({ permissions: ['support.configure'] });
    assert.equal((await api(`/api/v1/support/tenants/${ws.tenantId}/diagnostics`, { headers: configureOnly.auth })).status, 403);
    assert.equal((await api(`/api/v1/support/tenants/${ws.tenantId}/diagnostics`)).status, 401);
    assert.equal((await api(`/api/v1/support/tenants/${ws.tenantId}/diagnostics`, { headers: ws.auth })).status, 401, 'a tenant user token is not an admin token');
    assert.equal((await api('/api/v1/support/tenants/0123456789abcdef01234567/diagnostics', { headers: viewer.auth })).status, 404);
  });

  /* ------------------------------ attribution -------------------------- */

  test('audit rows written in a support session context carry the operator', async () => {
    const actor = { type: 'user', id: 'usr_target', tenantId: 'ten_attr', email: 'target@example.com', impersonatedBy: 'adm_operator' };
    const row = await runWithContext({ actor, requestId: 'req-attr' }, () =>
      emitAudit({ actor: { type: 'user', id: 'usr_target' }, action: 'test.write', module: 'test.support', tenantId: 'ten_attr' }));
    assert.equal(row.impersonatedBy, 'adm_operator');

    // The model audit plugin path (row-level changes) is attributed too.
    await runWithContext({ actor, requestId: 'req-attr-2' }, () => Dashboard.create({ tenantId: 'ten_attr', name: 'Created in a support context' }));
    let pluginRow = null;
    for (let i = 0; i < 40 && !pluginRow; i += 1) {
      pluginRow = await AuditLog.findOne({ tenantId: 'ten_attr', module: 'dashboards' }).lean();
      if (!pluginRow) await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(pluginRow, 'the audit consumer wrote the change');
    assert.equal(pluginRow.impersonatedBy, 'adm_operator');
    assert.equal(pluginRow.actorId, 'usr_target');

    // Outside a support context nothing is attributed.
    const plain = await emitAudit({ actor: { type: 'user', id: 'usr_plain' }, action: 'test.write', module: 'test.support', tenantId: 'ten_attr' });
    assert.equal(plain.impersonatedBy, null);
  });
});
