/**
 * Support surface - end-to-end HTTP integration tests (Sprint 8).
 *
 * WHY IT EXISTS
 *   Proves the admin support tooling end-to-end: RBAC gating, secure
 *   impersonation (token shape, session tagging, daily budget), stopping
 *   impersonation, account recovery, session revocation, tenant lookups,
 *   and tenant-scoped broadcasts - plus the audit-trail record.
 *
 * DESIGN
 *   - Real Express app on an ephemeral port + real in-memory MongoDB.
 *   - RBAC seeding mirrors `tests/compliance.integration.test.js`.
 *   - The impersonation budget cap is raised for the happy path and set to
 *     1 for the budget test so the whole suite fits under the default cap.
 */

import test, { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from './helpers/mongo.js';
import { startHttp, stopHttp, api } from './helpers/http.js';
import { factories } from './helpers/factories.js';
import { shortToken } from '../src/utils/id.js';
import adminService from '../src/services/admin.service.js';
import roleService from '../src/services/role.service.js';
import permissionService from '../src/services/permission.service.js';
import sessionRepository from '../src/repositories/session.repository.js';
import * as accessLogService from '../src/services/accessLog.service.js';
import { AuditLog } from '../src/models/AuditLog.js';
import rbacCache from '../src/services/rbac.cache.service.js';
import env from '../src/config/env.js';

const PASSWORD = 'Password123!';
const supportModule = 'support';

/** Create the dotted module tree for a `<module>.<action>` key. */
async function ensureModule(key) {
  if (key.includes('.')) await ensureModule(key.slice(0, key.lastIndexOf('.')));
  try {
    await permissionService.createModule({ key, name: key });
  } catch (err) {
    if (err.statusCode !== 409) throw err;
  }
}

/** Register a `<module>.<action>` permission (idempotent). */
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

/** Seed a platform admin holding `<moduleKey>.<action>` on a fresh role. */
async function seedAdminWithPermission({ moduleKey, action }) {
  const admin = await adminService.create({
    email: `admin-${shortToken(8)}@platform.test`,
    password: PASSWORD,
    adminType: 'platform',
    name: 'Support Tester',
  });
  const role = await roleService.create({ tenantId: null, name: `role_${shortToken(8)}` });
  await ensurePermission(`${moduleKey}.${action}`);
  await roleService.addPermission({ roleId: role._id, permissionKey: `${moduleKey}.${action}`, by: admin._id });
  await adminService.assignRole({ adminId: admin._id, roleId: role._id, tenantId: null, by: admin._id });
  const login = await api('/api/v1/admin-auth/login', {
    method: 'POST',
    body: { email: admin.email, password: PASSWORD },
  });
  assert.equal(login.status, 200);
  return { admin, token: login.json.data.accessToken };
}

/** Create a normal active tenant user. */
async function createTenantUser() {
  const tenant = await factories.tenant.create();
  const user = await factories.user.create({ tenantId: tenant._id });
  return { tenant, user };
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

describe('support surface', () => {
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
  });

  test('rejects unauthenticated support requests with 401', async () => {
    const res = await api('/api/v1/support/impersonate', { method: 'POST', body: {} });
    assert.equal(res.status, 401);
  });

  test('rejects an admin without the support.configure permission', async () => {
    const { token } = await seedAdminWithPermission({ moduleKey: 'compliance', action: 'view' });
    const res = await api('/api/v1/support/impersonate', {
      method: 'POST',
      headers: bearer(token),
      body: { targetUserId: 'usr_x', reason: 'test' },
    });
    assert.equal(res.status, 403);
  });

  test('impersonation returns a user-scoped token and is audited', async () => {
    env.support.impersonationBudgetDailyCap = 1000;
    try {
      const { token, admin } = await seedAdminWithPermission({ moduleKey: supportModule, action: 'configure' });
      const { user } = await createTenantUser();

      const res = await api('/api/v1/support/impersonate', {
        method: 'POST',
        headers: bearer(token),
        body: { targetUserId: user._id, reason: 'investigate a billing issue' },
      });

      assert.equal(res.status, 200);
      assert.equal(res.json.data.impersonation, true);
      assert.equal(typeof res.json.data.token, 'string');
      assert.equal(res.json.data.sessionId.slice(0, 4), 'ses_');
      assert.equal(res.json.data.user.id, String(user._id));
      assert.equal(res.json.data.user.tenantId, String(user.tenantId));

      const payload = JSON.parse(Buffer.from(res.json.data.token.split('.')[1], 'base64url').toString('utf8'));
      assert.equal(payload.aud, 'user');
      assert.equal(payload.sub, String(user._id));
      assert.equal(payload.impersonation, true);
      assert.equal(payload.sessionId, res.json.data.sessionId);

      const session = await sessionRepository.findById(res.json.data.sessionId);
      assert.equal(session.impersonatedBy, String(admin._id));
      assert.equal(session.actorId, String(user._id));

      const audit = await AuditLog.findOne({ module: 'support.impersonation', action: 'impersonate' }).lean();
      assert.ok(audit, 'impersonation must be audited');
      assert.equal(String(audit.actorId), String(admin._id));
      assert.equal(String(audit.resourceId), String(user._id));
    } finally {
      env.support.impersonationBudgetDailyCap = 20;
    }
  });

  test('impersonation requires a reason', async () => {
    const { token } = await seedAdminWithPermission({ moduleKey: supportModule, action: 'configure' });
    const { user } = await createTenantUser();
    const res = await api('/api/v1/support/impersonate', {
      method: 'POST',
      headers: bearer(token),
      body: { targetUserId: user._id, reason: '' },
    });
    assert.equal(res.status, 422);
  });

  test('daily impersonation budget is enforced', async () => {
    const originalCap = env.support.impersonationBudgetDailyCap;
    env.support.impersonationBudgetDailyCap = 1;
    try {
      const { token } = await seedAdminWithPermission({ moduleKey: supportModule, action: 'configure' });
      const { user } = await createTenantUser();

      const first = await api('/api/v1/support/impersonate', {
        method: 'POST',
        headers: bearer(token),
        body: { targetUserId: user._id, reason: 'first use' },
      });
      assert.equal(first.status, 200);
      await accessLogService.flush();

      const second = await api('/api/v1/support/impersonate', {
        method: 'POST',
        headers: bearer(token),
        body: { targetUserId: user._id, reason: 'over budget' },
      });
      assert.equal(second.status, 429);
    } finally {
      env.support.impersonationBudgetDailyCap = originalCap;
    }
  });

  test('stopping impersonation revokes the tagged session', async () => {
    const { token, admin } = await seedAdminWithPermission({ moduleKey: supportModule, action: 'configure' });
    const { user } = await createTenantUser();

    const start = await api('/api/v1/support/impersonate', {
      method: 'POST',
      headers: bearer(token),
      body: { targetUserId: user._id, reason: 'investigate' },
    });
    assert.equal(start.status, 200);

    const stop = await api('/api/v1/support/impersonate/stop', {
      method: 'POST',
      headers: bearer(token),
      body: { sessionId: start.json.data.sessionId, reason: 'resolved' },
    });
    assert.equal(stop.status, 200);
    assert.equal(stop.json.data.status, 'revoked');

    const session = await sessionRepository.findById(start.json.data.sessionId);
    assert.notEqual(session.status, 'active');

    const audit = await AuditLog.findOne({ module: 'support.impersonation', action: 'impersonate.stop' }).lean();
    assert.ok(audit, 'stop must be audited');
    assert.equal(String(audit.actorId), String(admin._id));
  });

  test('an admin cannot stop another admin session', async () => {
    const { token: tokenA } = await seedAdminWithPermission({ moduleKey: supportModule, action: 'configure' });
    const { token: tokenB } = await seedAdminWithPermission({ moduleKey: supportModule, action: 'configure' });
    const { user } = await createTenantUser();

    const start = await api('/api/v1/support/impersonate', {
      method: 'POST',
      headers: bearer(tokenA),
      body: { targetUserId: user._id, reason: 'investigate' },
    });
    assert.equal(start.status, 200);

    const stop = await api('/api/v1/support/impersonate/stop', {
      method: 'POST',
      headers: bearer(tokenB),
      body: { sessionId: start.json.data.sessionId, reason: 'not mine' },
    });
    assert.equal(stop.status, 403);

    const session = await sessionRepository.findById(start.json.data.sessionId);
    assert.equal(session.status, 'active', 'session must survive a foreign stop');
  });

  test('account recovery requests a password reset by email', async () => {
    const { token } = await seedAdminWithPermission({ moduleKey: supportModule, action: 'configure' });
    const { user } = await createTenantUser();

    const res = await api('/api/v1/support/account/recover', {
      method: 'POST',
      headers: bearer(token),
      body: { userId: user._id, reason: 'user forgot password' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.ok, true);
    assert.equal(res.json.data.method, 'password_reset_email');
    assert.equal(res.json.data.resetRequested, true);

    const audit = await AuditLog.findOne({ module: 'support.account.recover', action: 'account.recover' }).lean();
    assert.ok(audit, 'recovery must be audited');
    assert.equal(String(audit.resourceId), String(user._id));
  });

  test('revoke-all-sessions completes for a user', async () => {
    const { token } = await seedAdminWithPermission({ moduleKey: supportModule, action: 'configure' });
    const { user } = await createTenantUser();

    const res = await api('/api/v1/support/account/revoke-sessions', {
      method: 'POST',
      headers: bearer(token),
      body: { userId: user._id, reason: 'suspected compromise' },
    });
    assert.equal(res.status, 200);
    assert.equal(typeof res.json.data.revokedCount, 'number');
    assert.equal(res.json.data.status, 'completed');
  });

  test('tenant lookups return the tenant plus live statistics', async () => {
    const { token } = await seedAdminWithPermission({ moduleKey: supportModule, action: 'configure' });
    const { tenant } = await createTenantUser();

    const res = await api(`/api/v1/support/tenants/${tenant._id}/lookups`, { headers: bearer(token) });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.tenant._id, String(tenant._id));
    assert.equal(typeof res.json.data.statistics.userCount, 'number');
  });

  test('tenant-scoped broadcast notifies active users and is audited', async () => {
    const { token } = await seedAdminWithPermission({ moduleKey: supportModule, action: 'configure' });
    const { tenant } = await createTenantUser();

    const res = await api('/api/v1/support/notifications/broadcast', {
      method: 'POST',
      headers: bearer(token),
      body: { tenantId: tenant._id, title: 'Maintenance window', body: 'Downtime 02:00 UTC', reason: 'planned maintenance' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.targetTenantId, String(tenant._id));
    assert.equal(res.json.data.recipientCount, 1);

    const audit = await AuditLog.findOne({ module: 'support.notifications.broadcast', action: 'notification.broadcast' }).lean();
    assert.ok(audit, 'broadcast must be audited');
    assert.equal(String(audit.resourceId), String(tenant._id));
  });
});
