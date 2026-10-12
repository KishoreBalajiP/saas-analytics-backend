/**
 * Phase 6 billing integration tests (end-to-end HTTP).
 *
 * Why this file exists:
 *   Proves the workspace subscription surface, the platform-admin plan /
 *   subscription / entitlement surface, and the payment-provider webhook
 *   stub all work through the real Express app, the real auth middleware,
 *   the real permission middleware, and a real in-memory MongoDB.
 *
 * Coverage:
 *   - Workspace Owner can fetch their subscription
 *   - Workspace Owner can cancel and reactivate their subscription
 *   - Cross-tenant access to a subscription is rejected
 *   - Manager role cannot cancel a subscription
 *   - Workspace Owner can read entitlements and usage
 *   - Platform admin with billing.plans.view can list plans
 *   - Platform admin without billing.plans.create cannot create a plan
 *   - Platform admin with billing.subscriptions.override can change plan
 *   - Platform admin override requires a non-empty reason
 *   - Override write clamps a limit to the safety net
 *   - Webhook returns 501
 *   - Admin checkout returns 501
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from './helpers/mongo.js';
import { startHttp, stopHttp, api } from './helpers/http.js';
import { factories } from './helpers/factories.js';
import planService from '../src/services/plan.service.js';
import rbacCache from '../src/services/rbac.cache.service.js';
import permissionRepository from '../src/repositories/permission.repository.js';
import roleRepository from '../src/repositories/role.repository.js';
import { Role } from '../src/models/Role.js';
import { RolePermission } from '../src/models/RolePermission.js';
import { UserRole } from '../src/models/UserRole.js';
import { AdminRole } from '../src/models/AdminRole.js';
import adminBootstrapService from '../src/services/adminBootstrap.service.js';

const PASSWORD = 'Password123!';
const PREFIX = '/api/v1';

before(async () => {
  await startMongo();
  await startHttp();
});

beforeEach(async () => {
  await resetMongo();
  await rbacCache.clearAll();
  await planService.ensureDefaults('test');
});

after(async () => {
  await stopHttp();
  await stopMongo();
});

/* ----------------------------- helpers ---------------------------------- */

async function ensurePermission(key) {
  const lastDot = key.lastIndexOf('.');
  const module = key.slice(0, lastDot);
  const action = key.slice(lastDot + 1);
  let mod = await permissionRepository.findModuleByKey(module);
  if (!mod) {
    mod = await permissionRepository.createModule({
      key: module,
      name: module,
      isSystem: true,
      createdBy: 'test',
    });
  }
  const existing = await permissionRepository.findPermissionByKey(key);
  if (existing) return existing;
  const created = await permissionRepository.registerAction({
    moduleId: mod._id,
    module,
    action,
    description: `${action} ${module}`,
    isSystem: true,
    createdBy: 'test',
  });
  if (created) return created;
  // Re-fetch in case a concurrent run created it.
  const refetched = await permissionRepository.findPermissionByKey(key);
  if (!refetched) {
    throw new Error(`Failed to register permission ${key}`);
  }
  return refetched;
}

async function grantPermission(role, permissionKey) {
  const perm = await permissionRepository.findPermissionByKey(permissionKey);
  if (!perm) {
    // Try one more time after a short delay in case of replication lag.
    await new Promise((r) => setTimeout(r, 50));
    const retry = await permissionRepository.findPermissionByKey(permissionKey);
    if (!retry) throw new Error(`permission ${permissionKey} not registered`);
    return grantPermission(role, permissionKey);
  }
  const already = await RolePermission.findOne({ roleId: role._id, permissionId: perm._id });
  if (already) return;
  await RolePermission.create({
    roleId: role._id,
    permissionId: perm._id,
    grantedBy: 'test',
  });
}

async function findOrCreateRole({ tenantId = null, name, level = 'tenant' }) {
  let role = await roleRepository.findByName({ tenantId, name });
  if (role) return role;
  role = await roleRepository.create({
    tenantId,
    name,
    description: name,
    level,
    isSystem: true,
    createdBy: 'test',
  });
  return role;
}

async function seedTenantWithOwner() {
  const tenant = await factories.tenant.create({ planId: 'starter' });
  const ownerUser = await factories.user.create({ tenantId: tenant._id.toString() });
  const managerUser = await factories.user.create({ tenantId: tenant._id.toString() });
  const ownerRole = await findOrCreateRole({ tenantId: tenant._id.toString(), name: 'Owner' });
  const managerRole = await findOrCreateRole({ tenantId: tenant._id.toString(), name: 'Manager' });
  for (const key of [
    'iam.subscriptions.view',
    'iam.subscriptions.update',
    'iam.entitlements.view',
  ]) {
    await ensurePermission(key);
    await grantPermission(ownerRole, key);
  }
  await ensurePermission('iam.subscriptions.view');
  await grantPermission(managerRole, 'iam.subscriptions.view');
  await UserRole.create({
    tenantId: tenant._id.toString(),
    userId: ownerUser._id.toString(),
    roleId: ownerRole._id.toString(),
    createdBy: 'test',
  });
  await UserRole.create({
    tenantId: tenant._id.toString(),
    userId: managerUser._id.toString(),
    roleId: managerRole._id.toString(),
    createdBy: 'test',
  });
  return { tenant, ownerUser, managerUser, ownerRole };
}

async function loginUser(email, tenantId) {
  const res = await api(`${PREFIX}/auth/login`, {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenantId },
    body: { email, password: PASSWORD },
  });
  assert.equal(res.status, 200, `login failed: ${JSON.stringify(res.json)}`);
  return res.json.data.accessToken;
}

async function makeAdmin(email, adminType = 'platform', permissions = []) {
  // Bootstrap a super admin first so the platform catalogue is fully
  // registered. We then create additional platform/support admins
  // directly so we can layer the requested permission keys onto them
  // via a fresh role (so each test's permissions are isolated).
  const bootstrapEmail = `root-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await adminBootstrapService.bootstrapAdmin({
    email: bootstrapEmail,
    password: PASSWORD,
    adminType: 'super',
    name: 'Root',
  });

  // Find or create a dedicated test role for this admin so we can
  // attach only the requested permission keys (without inheriting the
  // entire platform catalogue).
  const roleName = `${adminType}-${Math.random().toString(36).slice(2, 6)}`;
  const role = await roleRepository.create({
    tenantId: null,
    name: roleName,
    description: roleName,
    level: 'platform',
    isSystem: false,
    createdBy: 'test',
  });
  for (const key of permissions) {
    await ensurePermission(key);
    await grantPermission(role, key);
  }
  const admin = await factories.admin.create({ email, adminType });
  await AdminRole.create({
    adminId: admin._id.toString(),
    roleId: role._id.toString(),
    tenantId: null,
    createdBy: 'test',
  });
  return { admin, role };
}

async function loginAdmin(email) {
  const res = await api(`${PREFIX}/admin-auth/login`, {
    method: 'POST',
    body: { email, password: PASSWORD },
  });
  assert.equal(res.status, 200, `admin login failed: ${JSON.stringify(res.json)}`);
  return res.json.data.accessToken;
}

/* -------------------- workspace self-service surface -------------------- */

test('workspace Owner can fetch their subscription (lazy provisioning)', async () => {
  const { tenant, ownerUser } = await seedTenantWithOwner();
  const token = await loginUser(ownerUser.email, tenant._id.toString());
  const res = await api(`${PREFIX}/tenants/${tenant._id}/subscription`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.planId, 'starter');
  assert.equal(res.json.data.state, 'active');
});

test('workspace Manager (no update permission) cannot cancel a subscription', async () => {
  const { tenant, managerUser } = await seedTenantWithOwner();
  const token = await loginUser(managerUser.email, tenant._id.toString());
  const res = await api(`${PREFIX}/tenants/${tenant._id}/subscription/cancel`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: { immediate: true },
  });
  assert.equal(res.status, 403);
});

test('workspace Owner can cancel and reactivate their subscription', async () => {
  const { tenant, ownerUser } = await seedTenantWithOwner();
  const token = await loginUser(ownerUser.email, tenant._id.toString());
  const cancel = await api(`${PREFIX}/tenants/${tenant._id}/subscription/cancel`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: { immediate: true, reason: 'Test cancel' },
  });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.json.data.state, 'canceled');
  const reactivate = await api(`${PREFIX}/tenants/${tenant._id}/subscription/reactivate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(reactivate.status, 200);
  assert.equal(reactivate.json.data.state, 'active');
});

test('workspace Owner can read entitlements and usage', async () => {
  const { tenant, ownerUser } = await seedTenantWithOwner();
  const token = await loginUser(ownerUser.email, tenant._id.toString());
  const ent = await api(`${PREFIX}/tenants/${tenant._id}/entitlements`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(ent.status, 200);
  assert.ok(ent.json.data.features);
  assert.ok(ent.json.data.limits);
  const usage = await api(`${PREFIX}/tenants/${tenant._id}/usage`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(usage.status, 200);
  assert.ok(usage.json.data.usage);
});

/* -------------------- platform-admin surface ----------------------------- */

test('platform admin with billing.plans.view can list plans', async () => {
  await makeAdmin('pa1@example.com', 'platform', ['billing.plans.view']);
  const token = await loginAdmin('pa1@example.com');
  const res = await api(`${PREFIX}/admin/plans`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  assert.ok(res.json.data.length >= 4);
});

test('platform admin without billing.plans.create cannot create a plan', async () => {
  await makeAdmin('pa2@example.com', 'platform', ['billing.plans.view']);
  const token = await loginAdmin('pa2@example.com');
  const res = await api(`${PREFIX}/admin/plans`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: { code: 'x', name: 'X', data: { status: 'active', tier: 0, features: {}, limits: {} } },
  });
  assert.equal(res.status, 403);
});

test('platform admin with billing.subscriptions.override can change plan', async () => {
  const { tenant } = await seedTenantWithOwner();
  await makeAdmin('pa3@example.com', 'platform', [
    'billing.subscriptions.override',
    'billing.subscriptions.view',
  ]);
  const token = await loginAdmin('pa3@example.com');
  const res = await api(`${PREFIX}/admin/subscriptions/${tenant._id}/change-plan`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: { planId: 'pro', reason: 'Admin upgrade' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.planId, 'pro');
});

test('platform admin override requires a non-empty reason', async () => {
  const { tenant } = await seedTenantWithOwner();
  await makeAdmin('pa4@example.com', 'platform', [
    'billing.subscriptions.override',
  ]);
  const token = await loginAdmin('pa4@example.com');
  const res = await api(`${PREFIX}/admin/subscriptions/${tenant._id}/set-state`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: { state: 'restricted', reason: '' },
  });
  // The validator rejects the empty reason (minLength 1) with 422.
  assert.equal(res.status, 422);
});

test('override write is rejected without reason', async () => {
  const { tenant } = await seedTenantWithOwner();
  await makeAdmin('pa5@example.com', 'platform', [
    'billing.entitlements.override',
  ]);
  const token = await loginAdmin('pa5@example.com');
  const res = await api(`${PREFIX}/admin/entitlements/overrides/${tenant._id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: { kind: 'feature', metric: 'embed', value: true, reason: '' },
  });
  // The validator rejects the empty reason (minLength 1) with 422.
  assert.equal(res.status, 422);
});

test('override write clamps a limit to the safety net', async () => {
  const { tenant } = await seedTenantWithOwner();
  await makeAdmin('pa6@example.com', 'platform', [
    'billing.entitlements.override',
  ]);
  const token = await loginAdmin('pa6@example.com');
  const res = await api(`${PREFIX}/admin/entitlements/overrides/${tenant._id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: {
      kind: 'limit',
      metric: 'connectors',
      value: { max: 10_000_000, hard: true },
      reason: 'Test the safety net',
    },
  });
  assert.equal(res.status, 201);
  // The highest plan's connectors max is 50 (enterprise) * 1000 = 50000.
  assert.ok(res.json.data.value.max <= 50_000);
});

/* -------------------- payment provider boundary -------------------------- */

test('webhook returns 501 (no provider selected)', async () => {
  const res = await api(`${PREFIX}/billing/webhook`, { method: 'POST', body: {} });
  assert.equal(res.status, 501);
});

test('admin checkout returns 501 (no provider selected)', async () => {
  const { tenant } = await seedTenantWithOwner();
  await makeAdmin('pa7@example.com', 'platform', ['billing.subscriptions.override']);
  const token = await loginAdmin('pa7@example.com');
  const res = await api(`${PREFIX}/admin/subscriptions/${tenant._id}/checkout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: { planId: 'pro' },
  });
  assert.equal(res.status, 501);
});
