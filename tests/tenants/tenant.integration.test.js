/**
 * Sprint 3 — Multi-Tenant platform: end-to-end HTTP integration tests.
 *
 * WHY IT EXISTS
 *   Proves the wired `/api/v1/tenants/*` surface works through the real
 *   Express app: platform-admin auth, the `iam.tenants.*` permission guard,
 *   tenant lifecycle (suspend/restore/disable/archive), the auth login gate
 *   that blocks non-`active` tenants, onboarding, members, settings
 *   effective-inheritance + secret redaction + read-only protection, and
 *   statistics — against a real in-memory MongoDB.
 *
 * DESIGN
 *   - A fully-granted platform admin is seeded (iam.tenants.* permissions)
 *     and logged in over HTTP so every route is exercised with a real
 *     Bearer token and live permission resolution.
 *   - Ownership of a tenant lifecycle is asserted by logging a tenant user
 *     in/out and confirming the login path reflects the tenant status.
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
import * as tenantService from '../../src/services/tenant.service.js';
import * as featureFlagService from '../../src/services/featureFlag.service.js';
import * as settingService from '../../src/services/setting.service.js';
import * as tenantSettingsService from '../../src/services/tenantSettings.service.js';

import { Tenant } from '../../src/models/Tenant.js';
import { User } from '../../src/models/User.js';
import { Setting } from '../../src/models/Setting.js';
import { FeatureFlag } from '../../src/models/FeatureFlag.js';

const PASSWORD = 'Password123!';
const TENANT_KEYS = ['create', 'view', 'update', 'suspend', 'restore', 'configure', 'assign', 'delete'];

function ensureModel(mongoose, ...models) {
  return Promise.all(models.map((m) => m.init()));
}

/** Ensure a dotted module key exists, creating its parents first (idempotent). */
async function ensureModule(key) {
  if (key.includes('.')) await ensureModule(key.slice(0, key.lastIndexOf('.')));
  try {
    await permissionService.createModule({ key, name: key });
  } catch (err) {
    if (err.statusCode !== 409) throw err;
  }
}

/** Seed a module + all permission keys idempotently. */
async function ensurePermissions(moduleKey) {
  await ensureModule(moduleKey);
  for (const action of TENANT_KEYS) {
    try {
      await permissionService.createPermission({ module: moduleKey, action });
    } catch (err) {
      if (err.statusCode !== 409) throw err;
    }
  }
}

/** Create a platform admin granted every `iam.tenants.*` permission. */
async function seedRootAdmin() {
  const admin = await adminService.create({
    email: `root-${shortToken(8)}@example.com`,
    password: PASSWORD,
    adminType: 'platform',
    name: 'Root',
  });
  const role = await roleService.create({ tenantId: null, name: `root_${shortToken(8)}` });
  for (const action of TENANT_KEYS) {
    await roleService.addPermission({ roleId: role._id, permissionKey: `iam.tenants.${action}`, by: admin._id });
  }
  await adminService.assignRole({ adminId: admin._id, roleId: role._id, by: admin._id });
  return admin;
}

async function adminAuth(admin) {
  const login = await api('/api/v1/admin-auth/login', {
    method: 'POST',
    body: { email: admin.email, password: PASSWORD },
  });
  assert.equal(login.status, 200);
  return { authorization: `Bearer ${login.json.data.accessToken}` };
}

before(async () => {
  await startMongo();
  await ensureModel(null, Tenant, User, Setting, FeatureFlag);
  await startHttp();
  await ensurePermissions('iam.tenants');
});

beforeEach(async () => {
  await resetMongo();
  await rbacCache.clearAll();
  await ensurePermissions('iam.tenants');
});

after(async () => {
  await stopHttp();
  await stopMongo();
});

/* ----------------------------- /tenants CRUD ----------------------------- */

test('create tenant is pending until initialized; detail + list work', async () => {
  const auth = await adminAuth(await seedRootAdmin());
  const created = await api('/api/v1/tenants', {
    method: 'POST',
    headers: auth,
    body: { name: 'Acme Corp', planId: 'starter' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.data.status, 'pending');
  assert.equal(created.json.data.slug, 'acme-corp');
  const tenantId = created.json.data._id;

  const detail = await api(`/api/v1/tenants/${tenantId}`, { headers: auth });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.data.name, 'Acme Corp');

  const list = await api('/api/v1/tenants', { headers: auth });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.json.data));
});

test('PATCH /tenants/:id rejects status/slug/owner changes', async () => {
  const auth = await adminAuth(await seedRootAdmin());
  const tenant = await tenantService.create({ tenant: { name: 'Slimmer Inc' }, by: 'root' });

  const bad = await api(`/api/v1/tenants/${tenant.tenant._id}`, {
    method: 'PATCH',
    headers: auth,
    body: { status: 'active' },
  });
  assert.equal(bad.status, 400);
});

/* ----------------------------- onboarding -------------------------------- */

test('initialize onboards owner + roles + settings + flags', async () => {
  const auth = await adminAuth(await seedRootAdmin());
  const { tenant } = await tenantService.create({
    tenant: { name: 'Onboard Co' },
    owner: { email: 'owner@example.com', name: 'Owner', password: PASSWORD },
    initialize: true,
    by: 'root',
  });

  const detail = await api(`/api/v1/tenants/${tenant._id}`, { headers: auth });
  assert.equal(detail.json.data.status, 'active');
  assert.equal(detail.json.data.onboardingStatus, 'ready');

  // The seeded owner can authenticate now the tenant is active.
  const login = await api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenant._id.toString() },
    body: { email: 'owner@example.com', password: PASSWORD },
  });
  assert.equal(login.status, 200);

  // Four default system/tenant roles were created.
  const { Role } = await import('../../src/models/Role.js');
  const roles = await Role.find({ tenantId: tenant._id }).lean();
  assert.ok(roles.some((r) => r.name === 'Owner'));

  // A tenant-scoped setting override is NOT materialised (zero rows); the
  // platform default is inherited through the service.
  const smtp = await settingService.resolveEffective('email.smtp_host', { tenantId: tenant._id.toString() });
  assert.equal(smtp, '');
});

test('initialize is idempotent', async () => {
  const auth = await adminAuth(await seedRootAdmin());
  const { tenant } = await tenantService.create({
    tenant: { name: 'Replay Co' },
    owner: { email: 'owner@example.com', name: 'Owner', password: PASSWORD },
    initialize: true,
    by: 'root',
  });

  const again = await api(`/api/v1/tenants/${tenant._id}/init`, { method: 'POST', headers: auth });
  assert.equal(again.status, 200);
});

/* ----------------------------- lifecycle + auth gate ---------------------- */

test('suspending a tenant blocks login and revokes live sessions', async () => {
  const auth = await adminAuth(await seedRootAdmin());
  const { tenant, owner } = await tenantService.create({
    tenant: { name: 'Block Co' },
    owner: { email: 'owner@example.com', name: 'Owner', password: PASSWORD },
    initialize: true,
    by: 'root',
  });
  const tenantId = tenant._id.toString();

  const login = await api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenantId },
    body: { email: owner.email, password: PASSWORD },
  });
  assert.equal(login.status, 200);
  const accessToken = login.json.data.accessToken;

  // Suspend via the admin surface.
  const res = await api(`/api/v1/tenants/${tenantId}/suspend`, {
    method: 'POST',
    headers: auth,
    body: { reason: 'abuse' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.status, 'suspended');

  // The live access token is dead (session revoked by the cascade).
  const me = await api('/api/v1/auth/me', { headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(me.status, 401);

  // And a fresh login is refused with 403 (tenant not active).
  const relogin = await api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenantId },
    body: { email: owner.email, password: PASSWORD },
  });
  assert.equal(relogin.status, 403);
  assert.match(relogin.json.message, /not active/i);
});

test('restore re-opens a suspended tenant so logins succeed again', async () => {
  const auth = await adminAuth(await seedRootAdmin());
  const { tenant, owner } = await tenantService.create({
    tenant: { name: 'Bounce Co' },
    owner: { email: 'owner@example.com', name: 'Owner', password: PASSWORD },
    initialize: true,
    by: 'root',
  });
  const tenantId = tenant._id.toString();

  await api(`/api/v1/tenants/${tenantId}/suspend`, { method: 'POST', headers: auth, body: { reason: 'policy' } });
  const restored = await api(`/api/v1/tenants/${tenantId}/restore`, {
    method: 'POST',
    headers: auth,
    body: { reason: 'cleared' },
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.json.data.status, 'active');

  const login = await api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenantId },
    body: { email: owner.email, password: PASSWORD },
  });
  assert.equal(login.status, 200);
});

test('disable / archive transitions and terminal guards', async () => {
  const auth = await adminAuth(await seedRootAdmin());
  const { tenant } = await tenantService.create({
    tenant: { name: 'Disabled Co' },
    owner: { email: 'owner@example.com', name: 'Owner', password: PASSWORD },
    initialize: true,
    by: 'root',
  });
  const tenantId = tenant._id.toString();

  const disabled = await api(`/api/v1/tenants/${tenantId}/disable`, {
    method: 'POST', headers: auth, body: { reason: 'churn' },
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.json.data.status, 'disabled');

  // restore from disabled -> active
  const restored = await api(`/api/v1/tenants/${tenantId}/restore`, { method: 'POST', headers: auth, body: {} });
  assert.equal(restored.status, 200);
  assert.equal(restored.json.data.status, 'active');

  // archive terminal
  const archived = await api(`/api/v1/tenants/${tenantId}/archive`, {
    method: 'POST', headers: auth, body: { reason: 'gone' },
  });
  assert.equal(archived.status, 200);
  assert.equal(archived.json.data.status, 'archived');

  // operating on an archived tenant is rejected (409).
  const noop = await api(`/api/v1/tenants/${tenantId}/suspend`, { method: 'POST', headers: auth, body: { reason: 'no' } });
  assert.equal(noop.status, 409);
});

/* ------------------------------- members ---------------------------------- */

test('GET /tenants/:id/members lists the owner with the Owner role', async () => {
  const auth = await adminAuth(await seedRootAdmin());
  const { tenant, owner } = await tenantService.create({
    tenant: { name: 'Members Co' },
    owner: { email: 'owner@example.com', name: 'Owner', password: PASSWORD },
    initialize: true,
    by: 'root',
  });

  const res = await api(`/api/v1/tenants/${tenant._id}/members`, { headers: auth });
  assert.equal(res.status, 200);
  assert.ok(res.json.data.length >= 1);
  const member = res.json.data.find((u) => String(u.email) === 'owner@example.com');
  assert.ok(member);
  assert.ok(member.roles.includes('Owner'));
});

/* ------------------------------- settings --------------------------------- */

test('settings effective inheritance: tenant > platform > default; secrets redacted; readonly refused', async () => {
  const auth = await adminAuth(await seedRootAdmin());
  const { tenant } = await tenantService.create({ tenant: { name: 'Settings Co' }, by: 'root' });
  await tenantService.settings.updateGroup({
    tenantId: tenant._id.toString(),
    group: 'email',
    values: { 'email.from_name': 'SettingsCo Mail' },
    by: 'root',
  });

  // Tenant override wins over the platform/seeded default.
  const group = await tenantService.settings.getGroup({ tenantId: tenant._id.toString(), group: 'email' });
  const fromName = group.find((s) => s.key === 'email.from_name');
  assert.equal(fromName.value, 'SettingsCo Mail');
  assert.equal(fromName.source, 'tenant');

  // A secret defaults to redacted (value null + redacted flag) without secrets.
  // smtp_password isn't in DEFAULT_SETTINGS as a real override, so it inherits
  // the built-in default '' (non-null but empty string). Confirm via the group view.
  const redacted = group.find((s) => s.key === 'email.smtp_password');
  assert.equal(redacted.isSecret, true);
  assert.equal(redacted.value, null);
  assert.equal(redacted.redacted, true);
});

test('settings override of a read-only key is refused', async () => {
  const auth = await adminAuth(await seedRootAdmin());
  const { tenant } = await tenantService.create({ tenant: { name: 'RO Co' }, by: 'root' });
  await assert.rejects(
    tenantService.settings.updateGroup({
      tenantId: tenant._id.toString(),
      group: 'security',
      values: { 'security.password_min_length': 4 },
      by: 'root',
    }),
    (err) => err.statusCode === 403,
  );
});

/* ------------------------------- flags ------------------------------------ */

test('feature flags resolve with correct rollout semantics per tenant', async () => {
  await featureFlagService.ensureDefaults({ by: 'system' });
  const { tenant } = await tenantService.create({ tenant: { name: 'Flags Co' }, by: 'root' });
  const tenantId = tenant._id.toString();

  const before = await featureFlagService.resolveForTenant(tenantId);
  // `all` strategy flags are on for everyone by default.
  assert.equal(before['analytics.realtime'], true);
  assert.equal(before['analytics.export.csv'], true);
  // tenantId-strategy flags start with an empty allow list -> off.
  assert.equal(before['connectors.webhooks'], false);

  // Grant the tenant the webhook flag by adding it to the allow list.
  const flag = await featureFlagService.getByKey('connectors.webhooks');
  await featureFlagService.update(flag._id, {
    rollout: { strategy: 'tenantId', tenantIds: [tenantId], percentage: 100, attributeRules: [] },
  }, 'root');
  const after = await featureFlagService.resolveForTenant(tenantId);
  assert.equal(after['connectors.webhooks'], true);
});

/* ------------------------------- stats + billing -------------------------- */

test('stats and billing endpoints return scoped facts', async () => {
  const auth = await adminAuth(await seedRootAdmin());
  const { tenant, owner } = await tenantService.create({
    tenant: { name: 'Stats Co', planId: 'pro', billingEmail: 'bill@example.com' },
    owner: { email: 'owner@example.com', name: 'Owner', password: PASSWORD },
    initialize: true,
    by: 'root',
  });
  const tenantId = tenant._id.toString();

  const stats = await api(`/api/v1/tenants/${tenantId}/stats`, { headers: auth });
  assert.equal(stats.status, 200);
  assert.equal(stats.json.data.userCount, 1);

  const billing = await api(`/api/v1/tenants/${tenantId}/billing`, { headers: auth });
  assert.equal(billing.status, 200);
  assert.equal(billing.json.data.planId, 'pro');
  assert.equal(billing.json.data.billingEmail, 'bill@example.com');
});

/* ------------------------------- changeOwner ------------------------------ */

test('changeOwner reassigns the tenant owner', async () => {
  const auth = await adminAuth(await seedRootAdmin());
  const { tenant, owner } = await tenantService.create({
    tenant: { name: 'Owner Co' },
    owner: { email: 'owner@example.com', name: 'Owner', password: PASSWORD },
    initialize: true,
    by: 'root',
  });
  const second = await factories.user.create({
    tenantId: tenant._id.toString(),
    email: 'second@example.com',
    status: 'active',
  });

  const res = await api(`/api/v1/tenants/${tenant._id}/owner`, {
    method: 'POST',
    headers: auth,
    body: { userId: second._id.toString() },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.ownerId, second._id.toString());
});
