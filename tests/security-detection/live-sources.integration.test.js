/**
 * Security detection over the platform's real writers (roadmap 2.6): the
 * rules fire on events produced by the actual sign-in, admin sign-in,
 * support impersonation and authorization paths over HTTP, not only on
 * synthetic rows.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import { factories } from '../helpers/factories.js';
import { shortToken } from '../../src/utils/id.js';
import adminService from '../../src/services/admin.service.js';
import roleService from '../../src/services/role.service.js';
import permissionService from '../../src/services/permission.service.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import * as accessLogService from '../../src/services/accessLog.service.js';
import { runDetection } from '../../src/services/securityDetection/engine.js';
import { getRule } from '../../src/services/securityDetection/rules/index.js';
import { SecurityAlert } from '../../src/models/SecurityAlert.js';
// support: impersonation needs workspace consent (roadmap 2.3).
import * as supportAccessService from '../../src/services/supportAccess.service.js';

const PASSWORD = 'Password123!';

async function ensureModule(key) {
  if (key.includes('.')) await ensureModule(key.slice(0, key.lastIndexOf('.')));
  try { await permissionService.createModule({ key, name: key }); } catch (err) { if (err.statusCode !== 409) throw err; }
}

async function adminWith(permissionKey) {
  const admin = await adminService.create({
    email: `live-${shortToken(8).toLowerCase()}@platform.test`, password: PASSWORD, adminType: 'platform', name: 'Live',
  });
  if (permissionKey) {
    const role = await roleService.create({ tenantId: null, name: `role_${shortToken(8)}` });
    const module = permissionKey.slice(0, permissionKey.lastIndexOf('.'));
    await ensureModule(module);
    try { await permissionService.createPermission({ module, action: permissionKey.slice(permissionKey.lastIndexOf('.') + 1) }); } catch (err) { if (err.statusCode !== 409) throw err; }
    await roleService.addPermission({ roleId: role._id, permissionKey, by: null /* fixture seeding */ });
    await adminService.assignRole({ adminId: admin._id, roleId: role._id, tenantId: null, by: null /* fixture seeding */ });
  }
  return admin;
}

async function adminToken(admin) {
  const login = await api('/api/v1/admin-auth/login', { method: 'POST', body: { email: admin.email, password: PASSWORD } });
  assert.equal(login.status, 200);
  return { authorization: `Bearer ${login.json.data.accessToken}` };
}

/** Evaluate one rule as if the detector ran a few minutes from now. */
function detect(ruleId) {
  return runDetection({
    rules: [getRule(ruleId)],
    now: new Date(Date.now() + 5 * 60 * 1000),
    settingOverrides: {},
    notify: false,
  });
}

before(async () => { await startMongo(); await startHttp(); });
after(async () => { await stopHttp(); await stopMongo(); });
beforeEach(async () => { await resetMongo(); await rbacCache.clearAll(); });

test('failed tenant sign-ins for many accounts from one client raise a credential stuffing alert', async () => {
  const tenant = await factories.tenant.create();
  for (let i = 0; i < 20; i += 1) {
    const res = await api('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'X-Tenant-Id': String(tenant._id) },
      body: { email: `guess${i % 10}@example.com`, password: 'wrong-password' },
    });
    assert.equal(res.status, 401);
  }
  const summary = await detect('auth.credential_stuffing');
  assert.equal(summary.raised, 1);
  const [alert] = await SecurityAlert.find({}).lean();
  assert.equal(alert.subject.type, 'ip');
  assert.equal(alert.evidence.counts.accounts, 10);
  assert.ok(alert.evidence.details.reasons.some((r) => r.value === 'unknown_email'));
});

test('repeated wrong passwords on an admin account raise an admin alert', async () => {
  const admin = await adminWith(null);
  for (let i = 0; i < 5; i += 1) {
    const res = await api('/api/v1/admin-auth/login', { method: 'POST', body: { email: admin.email, password: 'not-the-password' } });
    assert.ok([401, 429].includes(res.status));
  }
  const summary = await detect('auth.admin_failed_logins');
  assert.equal(summary.raised, 1);
  const [alert] = await SecurityAlert.find({}).lean();
  assert.equal(alert.subject.id, String(admin._id));
  assert.equal(alert.subject.display, admin.email);
  assert.ok(alert.evidence.counts.lockouts >= 1, 'the lockout is part of the evidence');
});

test('a support impersonation raises an impersonation alert', async () => {
  const support = await adminWith('support.configure');
  const headers = await adminToken(support);
  const tenant = await factories.tenant.create();
  const user = await factories.user.create({ tenantId: tenant._id });
  await supportAccessService.grantConsent({ tenantId: String(tenant._id), user: { id: String(user._id) }, durationHours: 4 });
  const res = await api('/api/v1/support/impersonate', {
    method: 'POST', headers, body: { targetUserId: user._id, reason: 'ticket 1234' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const summary = await detect('support.impersonation');
  assert.equal(summary.raised, 1);
  const [alert] = await SecurityAlert.find({}).lean();
  assert.equal(alert.subject.id, String(support._id));
  assert.deepEqual(alert.evidence.details.targetUserIds, [String(user._id)]);
});

test('repeated 403s for one caller raise an authorization alert', async () => {
  const curious = await adminWith('compliance.view');
  const headers = await adminToken(curious);
  for (let i = 0; i < 20; i += 1) {
    const res = await api('/api/v1/monitoring/health/system', { headers });
    assert.equal(res.status, 403);
  }
  await accessLogService.flush();
  const summary = await detect('authz.repeated_denials');
  assert.equal(summary.raised, 1);
  const [alert] = await SecurityAlert.find({}).lean();
  assert.equal(alert.subject.type, 'admin');
  assert.equal(alert.subject.id, String(curious._id));
  assert.equal(alert.severity, 'medium');
  assert.equal(alert.evidence.counts.denials, 20);
});
