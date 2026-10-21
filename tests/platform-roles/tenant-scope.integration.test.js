/**
 * Tenant-scoped platform admins (roadmap 2.1; findings ten.04, gov.01,
 * adm.07, adm.08).
 *
 * An admin with `tenantScope = A` must only read or act on tenant A on every
 * platform route that touches tenant data (tenants, members, settings,
 * invitations, audit logs, access logs, compliance, support, billing views,
 * dashboard), must be refused on platform-wide surfaces, and must see the
 * same effective permissions on `/admin-auth/me` as the middleware enforces.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import { factories } from '../helpers/factories.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import roleService from '../../src/services/role.service.js';
import adminService from '../../src/services/admin.service.js';
import planService from '../../src/services/plan.service.js';
import subscriptionService from '../../src/services/subscription.service.js';
import entitlementOverrideService from '../../src/services/entitlementOverride.service.js';
import complianceService from '../../src/services/compliance.service.js';
import * as accessLogService from '../../src/services/accessLog.service.js';
import { emit as emitAudit } from '../../src/services/auditLog.service.js';
import { seedPlatformRoles, adminSession, createAdmin, loginAdmin } from './helpers.js';

let tenantA;
let tenantB;
let userA;
let userB;
let A;
let Bid;
let auditA;
let auditB;
let dsrA;
let dsrB;
let superSession;
let supportA;
let platformA;

before(async () => {
  await startMongo();
  await startHttp();
  await resetMongo();
  await rbacCache.clearAll();
  await seedPlatformRoles();
  await planService.ensureDefaults('test');

  tenantA = await factories.tenant.create();
  tenantB = await factories.tenant.create();
  A = String(tenantA._id);
  Bid = String(tenantB._id);
  userA = await factories.user.create({ tenantId: A });
  userB = await factories.user.create({ tenantId: Bid });

  auditA = await emitAudit({ actor: { type: 'system', id: 'test' }, action: 'probe.a', module: 'scope.test', tenantId: A });
  auditB = await emitAudit({ actor: { type: 'system', id: 'test' }, action: 'probe.b', module: 'scope.test', tenantId: Bid });
  for (const [tenantId, path] of [[A, '/probe/a'], [Bid, '/probe/b']]) {
    accessLogService.capture({
      actorType: 'user', actorId: 'u', tenantId, method: 'GET', path, statusCode: 200, event: 'request',
    });
  }
  await accessLogService.flush();
  dsrA = await complianceService.fileRequest({ subjectId: String(userA._id), type: 'export', reason: 'A', tenantScope: [A], by: 'root' });
  dsrB = await complianceService.fileRequest({ subjectId: String(userB._id), type: 'export', reason: 'B', tenantScope: [Bid], by: 'root' });
  await subscriptionService.createForTenant({ tenantId: A, planId: 'free' });
  await subscriptionService.createForTenant({ tenantId: Bid, planId: 'free' });
  await entitlementOverrideService.create({
    tenantId: Bid, metric: 'connectors', kind: 'limit', value: { max: 5, hard: true }, reason: 'B headroom', by: 'root',
  });

  superSession = await adminSession({ adminType: 'super', roleName: 'super_admin' });
  supportA = await adminSession({ adminType: 'support', roleName: 'support_operator', tenantScope: A });
  platformA = await adminSession({ adminType: 'platform', roleName: 'platform_admin', tenantScope: A });
});

after(async () => {
  await stopHttp();
  await stopMongo();
});

const get = (path, auth) => api(`/api/v1${path}`, { headers: auth });
const post = (path, auth, body = {}) => api(`/api/v1${path}`, { method: 'POST', headers: auth, body });

function assertScopeDenied(res, label) {
  assert.equal(res.status, 403, `${label}: expected 403, got ${res.status} ${res.json?.message}`);
  assert.equal(res.json.code, 'ADMIN_SCOPE_DENIED', label);
}

test('tenants: a scoped admin lists and reads only its own tenant', async () => {
  const list = await get('/tenants', supportA.auth);
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.data.map((t) => t._id), [A]);
  // Search still cannot reach outside the scope (B's unique slug).
  const searched = await get(`/tenants?search=${encodeURIComponent(tenantB.slug)}`, supportA.auth);
  assert.deepEqual(searched.json.data, []);
  const platformSearch = await get(`/tenants?search=${encodeURIComponent(tenantB.slug)}`, superSession.auth);
  assert.deepEqual(platformSearch.json.data.map((t) => t._id), [Bid], 'search works for platform admins');

  for (const suffix of ['', '/members', '/stats', '/billing', '/settings', '/invitations']) {
    assert.equal((await get(`/tenants/${A}${suffix}`, supportA.auth)).status, 200, `own tenant ${suffix}`);
    assertScopeDenied(await get(`/tenants/${Bid}${suffix}`, supportA.auth), `GET /tenants/B${suffix}`);
  }
});

test('tenants: a scoped admin cannot act on another tenant even with the permission', async () => {
  const before = (await get(`/tenants/${Bid}`, superSession.auth)).json.data;
  for (const action of ['suspend', 'restore', 'disable']) {
    assertScopeDenied(await post(`/tenants/${Bid}/${action}`, platformA.auth, { reason: 'scope test' }), `POST ${action}`);
  }
  assertScopeDenied(
    await api(`/api/v1/tenants/${Bid}`, { method: 'PATCH', headers: platformA.auth, body: { name: 'Hijacked' } }),
    'PATCH /tenants/B',
  );
  assertScopeDenied(await post(`/tenants/${Bid}/invitations`, platformA.auth, { email: 'x@example.com', roleName: 'Viewer' }), 'invite into B');
  assertScopeDenied(await post('/tenants', platformA.auth, { name: 'New tenant' }), 'create tenant');
  const afterRead = (await get(`/tenants/${Bid}`, superSession.auth)).json.data;
  assert.equal(afterRead.status, before.status);
  assert.equal(afterRead.name, before.name);
});

test('dashboard: a scoped admin gets a summary of its own tenant only', async () => {
  const res = await get('/admin/dashboard/summary', supportA.auth);
  assert.equal(res.status, 200);
  assert.equal(res.json.data.counts.total, 1);
  assert.deepEqual(res.json.data.recentTenants.map((t) => t.id), [A]);
  assert.equal(res.json.data.health, null);
  assert.ok(res.json.data.recentActions.every((a) => a.id !== String(auditB._id)));
  const platformWide = await get('/admin/dashboard/summary', superSession.auth);
  assert.ok(platformWide.json.data.counts.total >= 2);
});

test('audit logs: list, module view and detail are clamped to the scope', async () => {
  const list = await get('/audit-logs?module=scope.test', supportA.auth);
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.data.map((e) => e._id), [String(auditA._id)]);
  assertScopeDenied(await get(`/audit-logs?tenantId=${Bid}`, supportA.auth), 'list ?tenantId=B');
  assertScopeDenied(await get(`/audit-logs/modules/scope.test?tenantId=${Bid}`, supportA.auth), 'module ?tenantId=B');
  const byModule = await get('/audit-logs/modules/scope.test', supportA.auth);
  assert.deepEqual(byModule.json.data.map((e) => e._id), [String(auditA._id)]);
  assert.equal((await get(`/audit-logs/${auditA._id}`, supportA.auth)).status, 200);
  assert.equal((await get(`/audit-logs/${auditB._id}`, supportA.auth)).status, 404);
  // A platform-wide admin still sees both tenants.
  const all = await get('/audit-logs?module=scope.test', superSession.auth);
  assert.equal(all.json.data.length, 2);
});

test('access logs: clamped to the scope; explicit other-tenant filters are refused', async () => {
  const list = await get('/access-logs', supportA.auth);
  assert.equal(list.status, 200);
  assert.ok(list.json.data.length >= 1);
  assert.ok(list.json.data.every((row) => row.tenantId === A));
  assertScopeDenied(await get(`/access-logs?tenantId=${Bid}`, supportA.auth), 'access logs ?tenantId=B');
  assertScopeDenied(await get(`/access-logs/top-paths?tenantId=${Bid}`, supportA.auth), 'top paths ?tenantId=B');
});

test('compliance: only requests inside the scope are visible or cancellable', async () => {
  const list = await get('/compliance/requests', supportA.auth);
  assert.equal(list.status, 200);
  const ids = list.json.data.map((r) => r.requestId);
  assert.ok(ids.includes(dsrA.requestId));
  assert.ok(!ids.includes(dsrB.requestId));
  assert.equal((await get(`/compliance/requests/${dsrB.requestId}`, supportA.auth)).status, 404);
  assert.equal((await get(`/compliance/requests/${dsrA.requestId}`, supportA.auth)).status, 200);
});

test('support tooling: a scoped operator reaches only its own tenant and users', async () => {
  assert.equal((await get(`/support/tenants/${A}/lookups`, supportA.auth)).status, 200);
  assertScopeDenied(await get(`/support/tenants/${Bid}/lookups`, supportA.auth), 'lookup B');
  assertScopeDenied(
    await post('/support/notifications/broadcast', supportA.auth, { tenantId: Bid, title: 'x', reason: 'scope test' }),
    'broadcast to B',
  );
  const recoverB = await post('/support/account/recover', supportA.auth, { userId: String(userB._id), reason: 'scope test' });
  assert.equal(recoverB.status, 403);
  const revokeB = await post('/support/account/revoke-sessions', supportA.auth, { userId: String(userB._id), reason: 'scope test' });
  assert.equal(revokeB.status, 403);
  const revokeA = await post('/support/account/revoke-sessions', supportA.auth, { userId: String(userA._id), reason: 'scope test' });
  assert.equal(revokeA.status, 200);
});

test('billing views: subscriptions and entitlements are clamped to the scope', async () => {
  const subs = await get('/admin/subscriptions', platformA.auth);
  assert.equal(subs.status, 200);
  assert.deepEqual(subs.json.data.map((s) => s.tenantId), [A]);
  assert.equal((await get(`/admin/subscriptions/${A}`, platformA.auth)).status, 200);
  for (const path of [
    `/admin/subscriptions/${Bid}`,
    `/admin/subscriptions/${Bid}/timeline`,
    `/admin/subscriptions/${Bid}/transactions`,
    `/admin/entitlements/overrides/${Bid}`,
    `/admin/entitlements/tenants/${Bid}`,
    `/admin/entitlements/usage/${Bid}`,
  ]) {
    assertScopeDenied(await get(path, platformA.auth), `GET ${path}`);
  }
  const overrides = await get('/admin/entitlements/overrides', platformA.auth);
  assert.equal(overrides.status, 200);
  assert.deepEqual(overrides.json.data, [], "B's override is not visible to A's admin");
});

test('platform-wide surfaces refuse tenant-scoped admins even when they hold the permission', async () => {
  for (const path of ['/admin/admins', '/roles', '/permissions', '/admin/plans', '/monitoring/health/system', '/access-requests']) {
    assertScopeDenied(await get(path, platformA.auth), `GET ${path}`);
  }
  assertScopeDenied(await post('/master-data/countries', platformA.auth, { code: 'xx', name: 'X' }), 'master-data create');
});

test('/admin-auth/me returns the effective scope and the permissions the middleware enforces', async () => {
  const me = await get('/admin-auth/me', supportA.auth);
  assert.equal(me.status, 200);
  assert.deepEqual(me.json.data.scope, { type: 'tenant', tenantId: A });
  assert.deepEqual(me.json.data.roles, ['support_operator']);
  assert.ok(me.json.data.permissions.includes('iam.tenants.view'));
  assert.ok(me.json.data.permissions.includes('support.update'));
  assert.ok(!me.json.data.permissions.includes('iam.tenants.update'));
  // Every permission /me shows is honoured within the scope...
  assert.equal((await get(`/tenants/${A}`, supportA.auth)).status, 200);
  assert.equal((await get('/audit-logs', supportA.auth)).status, 200);
  // ...and permissions it does not show are refused.
  const denied = await api(`/api/v1/tenants/${A}`, { method: 'PATCH', headers: supportA.auth, body: { name: 'x' } });
  assert.equal(denied.status, 403);
});

test('platform and tenant-scoped grants resolve to the same set on /me and in the middleware', async () => {
  const scopedRole = await roleService.create({ tenantId: null, name: 'scope_test_tenant_reader' });
  await roleService.addPermission({ roleId: String(scopedRole._id), permissionKey: 'iam.tenants.view', by: null });
  const platformRole = await roleService.create({ tenantId: null, name: 'scope_test_audit_reader' });
  await roleService.addPermission({ roleId: String(platformRole._id), permissionKey: 'audit_logs.view', by: null });

  const admin = await createAdmin({ adminType: 'support', tenantScope: A });
  await adminService.assignRole({ adminId: String(admin._id), roleId: String(scopedRole._id), tenantId: A, by: null });
  await adminService.assignRole({ adminId: String(admin._id), roleId: String(platformRole._id), tenantId: null, by: null });
  const auth = await loginAdmin(admin);

  const me = await get('/admin-auth/me', auth);
  assert.deepEqual(me.json.data.permissions, ['audit_logs.view', 'iam.tenants.view']);
  assert.equal((await get(`/tenants/${A}`, auth)).status, 200, 'tenant-scoped grant is enforced');
  assert.equal((await get('/audit-logs', auth)).status, 200, 'platform grant is enforced');
  assertScopeDenied(await get(`/tenants/${Bid}`, auth), 'scoped grant never reaches B');

  // A grant scoped to a tenant the admin is not confined to is refused.
  await assert.rejects(
    () => adminService.assignRole({ adminId: String(admin._id), roleId: String(scopedRole._id), tenantId: Bid, by: null }),
    (err) => err.statusCode === 400,
  );
});

test('a tenant-scoped grant can be revoked through the API', async () => {
  const role = await roleService.create({ tenantId: null, name: 'scope_test_revocable' });
  await roleService.addPermission({ roleId: String(role._id), permissionKey: 'compliance.view', by: null });
  const admin = await createAdmin({ adminType: 'support', tenantScope: A });
  const grant = await api(`/api/v1/admin/admins/${admin._id}/roles`, {
    method: 'POST', headers: superSession.auth, body: { roleId: String(role._id), tenantId: A },
  });
  assert.equal(grant.status, 200, JSON.stringify(grant.json));
  const mismatch = await api(`/api/v1/admin/admins/${admin._id}/roles`, {
    method: 'POST', headers: superSession.auth, body: { roleId: String(role._id), tenantId: Bid },
  });
  assert.equal(mismatch.status, 400);

  const withoutTenant = await api(`/api/v1/admin/admins/${admin._id}/roles/${role._id}`, { method: 'DELETE', headers: superSession.auth });
  assert.equal(withoutTenant.json.data.removed, 0, 'a platform revoke does not touch the scoped grant');
  const revoked = await api(`/api/v1/admin/admins/${admin._id}/roles/${role._id}?tenantId=${A}`, { method: 'DELETE', headers: superSession.auth });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.json.data.removed, 1);
  const auth = await loginAdmin(admin);
  assert.deepEqual((await get('/admin-auth/me', auth)).json.data.permissions, []);
});

test('re-scoping an admin applies on its next request without signing in again', async () => {
  const session = await adminSession({ adminType: 'support', roleName: 'support_operator', tenantScope: A });
  assert.equal((await get(`/tenants/${A}`, session.auth)).status, 200);

  const patched = await api(`/api/v1/admin/admins/${session.admin._id}`, {
    method: 'PATCH', headers: superSession.auth, body: { tenantScope: Bid },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  assertScopeDenied(await get(`/tenants/${A}`, session.auth), 'old tenant after re-scope');
  assert.equal((await get(`/tenants/${Bid}`, session.auth)).status, 200);

  const unknown = await api(`/api/v1/admin/admins/${session.admin._id}`, {
    method: 'PATCH', headers: superSession.auth, body: { tenantScope: '0a1b2c3d4e5f60718293a4b5' },
  });
  assert.equal(unknown.status, 400, 'a scope must reference an existing tenant');
});

test('clearing tenantScope with null makes the admin platform-wide again', async () => {
  const session = await adminSession({ adminType: 'support', roleName: 'support_operator', tenantScope: A });
  assertScopeDenied(await get(`/tenants/${Bid}`, session.auth), 'B before clearing the scope');

  // A scoped peer cannot clear it (only active super admins change scope).
  const bySupport = await api(`/api/v1/admin/admins/${session.admin._id}`, {
    method: 'PATCH', headers: supportA.auth, body: { tenantScope: null },
  });
  assert.equal(bySupport.status, 403);

  const cleared = await api(`/api/v1/admin/admins/${session.admin._id}`, {
    method: 'PATCH', headers: superSession.auth, body: { tenantScope: null },
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
  assert.equal(cleared.json.data.tenantScope, null);
  assert.equal((await get(`/tenants/${Bid}`, session.auth)).status, 200, 'B is reachable on the next request');
  assert.deepEqual((await get('/admin-auth/me', session.auth)).json.data.scope, { type: 'platform', tenantId: null });

  // An empty string clears it too; omitting the field leaves the scope alone.
  await adminService.update({ id: String(session.admin._id), patch: { tenantScope: A }, by: null });
  const renamed = await api(`/api/v1/admin/admins/${session.admin._id}`, {
    method: 'PATCH', headers: superSession.auth, body: { name: 'Renamed operator' },
  });
  assert.equal(renamed.json.data.tenantScope, A, 'a patch without tenantScope keeps the scope');
  const emptied = await api(`/api/v1/admin/admins/${session.admin._id}`, {
    method: 'PATCH', headers: superSession.auth, body: { tenantScope: '' },
  });
  assert.equal(emptied.status, 200);
  assert.equal(emptied.json.data.tenantScope, null);
});

test("the cross-tenant scope '*' is platform-wide, never a tenant called '*'", async () => {
  // Only system callers (bootstrap, scripts) can set '*'; requests cannot.
  const session = await adminSession({ adminType: 'support', roleName: 'support_operator', tenantScope: '*' });
  const me = await get('/admin-auth/me', session.auth);
  assert.deepEqual(me.json.data.scope, { type: 'platform', tenantId: null });
  assert.equal(me.json.data.tenantScope, '*');

  const list = await get('/tenants', session.auth);
  assert.equal(list.status, 200);
  const ids = list.json.data.map((t) => t._id);
  assert.ok(ids.includes(A) && ids.includes(Bid), 'every tenant is listed');
  assert.equal((await get(`/tenants/${A}`, session.auth)).status, 200);
  assert.equal((await get(`/tenants/${Bid}`, session.auth)).status, 200);
  const audit = await get('/audit-logs?module=scope.test', session.auth);
  assert.equal(audit.json.data.length, 2);

  const refused = await api(`/api/v1/admin/admins/${session.admin._id}`, {
    method: 'PATCH', headers: superSession.auth, body: { tenantScope: '*' },
  });
  assert.equal(refused.status, 400, 'a request may only scope an admin to an existing tenant');
});
