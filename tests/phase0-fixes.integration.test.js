/**
 * Regression tests for the Phase 0 audit fixes (docs/audit-2026-10-19).
 *
 * Each test exercises a defect the audit found, over real HTTP against an
 * in-memory MongoDB, so the fix stays fixed:
 *   - tenant profile returns roles + permissions (UI gating)
 *   - API keys: create/list/external use/revoke, tenant isolation, suspension
 *   - embed tokens: mint for a published dashboard, public read, suspension
 *   - invitation role ceiling and real revocation
 *   - workspace cannot self-assign a paid plan
 *   - admin list never returns credential material; MFA re-enrol refused;
 *     admins cannot escalate themselves
 *   - analytics rejects expression-smuggling filters
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startMongo, stopMongo, resetMongo } from './helpers/mongo.js';
import { startHttp, stopHttp, api } from './helpers/http.js';
import * as emailService from '../src/services/email.service.js';
import tenantService from '../src/services/tenant.service.js';
import tenantLifecycle from '../src/services/tenantLifecycle.service.js';
import invitationService from '../src/services/tenantInvitation.service.js';
import adminService from '../src/services/admin.service.js';
import roleService from '../src/services/role.service.js';
import planService from '../src/services/plan.service.js';
import mfaService from '../src/modules/iam/auth/mfa.service.js';
import adminRepository from '../src/repositories/admin.repository.js';
import { ApiKey } from '../src/models/ApiKey.js';
// billing: tenants exercising paid features need a plan that includes them.
import { entitleTenant } from './helpers/billing.js';

const PASSWORD = 'Phase0Password123!';

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => { await resetMongo(); });
after(async () => { await emailService.close(); await stopHttp(); await stopMongo(); });

/** Capture the single invitation link sent while `fn` runs and return its token. */
async function captureInviteToken(fn) {
  const sink = [];
  emailService.captureInto(sink);
  try {
    await fn();
  } finally {
    emailService.stopCapture();
  }
  const link = sink.map((m) => m.text).join('\n').match(/https?:\/\/[^\s]+/u)?.[0];
  return link ? new URL(link).searchParams.get('token') : null;
}

/** Create an initialised workspace whose owner has accepted and can log in. */
async function workspace() {
  const email = `owner-${randomBytes(4).toString('hex')}@example.com`;
  let result;
  const token = await captureInviteToken(async () => {
    result = await tenantService.create({
      tenant: { name: `Phase0 ${randomBytes(3).toString('hex')}` },
      owner: { email, name: 'Owner' },
      initialize: true,
      by: 'platform-admin',
    });
  });
  await invitationService.accept({ token, name: 'Owner', password: PASSWORD });
  await entitleTenant(result.tenant._id, 'pro');
  const auth = await login(result.tenant.slug, email);
  return { tenant: result.tenant, slug: result.tenant.slug, email, auth };
}

async function login(slug, email, password = PASSWORD) {
  const res = await api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'X-Tenant-Id': slug },
    body: { email, password },
  });
  assert.equal(res.status, 200, `login should succeed: ${JSON.stringify(res.json)}`);
  return { authorization: `Bearer ${res.json.data.accessToken}` };
}

/** Add an active member with the given default role to a workspace. */
async function member(ws, roleName) {
  const email = `${roleName.toLowerCase()}-${randomBytes(4).toString('hex')}@example.com`;
  const token = await captureInviteToken(() => invitationService.create({
    tenantId: String(ws.tenant._id), email, name: roleName, roleName, invitedBy: 'platform-admin',
  }));
  await invitationService.accept({ token, name: roleName, password: PASSWORD });
  return { email, auth: await login(ws.slug, email) };
}

test('tenant profile returns roles and permissions so the UI can gate pages', async () => {
  const ws = await workspace();
  for (const path of ['/api/v1/users/me', '/api/v1/auth/me']) {
    const res = await api(path, { headers: ws.auth });
    assert.equal(res.status, 200);
    assert.ok(res.json.data.id, `${path} returns id`);
    assert.ok(res.json.data.roles.includes('Owner'), `${path} returns roles`);
    assert.ok(res.json.data.permissions.includes('connectors.view'), `${path} returns permissions`);
    assert.equal(res.json.data.passwordHash, undefined);
  }
});

test('API keys: create, list, authenticate, revoke; isolated per tenant; blocked when tenant is suspended', async () => {
  const a = await workspace();
  const b = await workspace();

  const created = await api('/api/v1/api-keys', {
    method: 'POST', headers: a.auth, body: { name: 'ci', scopes: ['datasets:read'] },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const { key, secret } = created.json.data;
  assert.match(secret, /^sak_[^.]+\.[^.]{16,}$/u, 'secret is the full prefix.secret credential');

  const list = await api('/api/v1/api-keys', { headers: a.auth });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.json.data), 'list data is an array');
  assert.equal(list.json.data.length, 1);
  assert.equal(list.json.meta.total, 1);

  // Tenant B cannot see, change or revoke tenant A's key.
  assert.equal((await api(`/api/v1/api-keys/${key.id}`, { headers: b.auth })).status, 404);
  assert.equal((await api(`/api/v1/api-keys/${key.id}/revoke`, { method: 'POST', headers: b.auth, body: {} })).status, 404);
  assert.equal((await api('/api/v1/api-keys', { headers: b.auth })).json.data.length, 0);

  const ext = await api('/api/v1/external/datasets', { headers: { 'X-Api-Key': secret } });
  assert.equal(ext.status, 200);

  await tenantLifecycle.suspend({ tenantId: String(a.tenant._id), reason: 'test', by: 'platform-admin' });
  assert.equal((await api('/api/v1/external/datasets', { headers: { 'X-Api-Key': secret } })).status, 401);
  await tenantLifecycle.restore({ tenantId: String(a.tenant._id), reason: 'test', by: 'platform-admin' });
  assert.equal((await api('/api/v1/external/datasets', { headers: { 'X-Api-Key': secret } })).status, 200);

  const fresh = await login(a.slug, a.email);
  const revoked = await api(`/api/v1/api-keys/${key.id}/revoke`, { method: 'POST', headers: fresh, body: {} });
  assert.equal(revoked.status, 200);
  assert.equal((await api('/api/v1/external/datasets', { headers: { 'X-Api-Key': secret } })).status, 401);
  assert.equal(await ApiKey.countDocuments({ tenantId: String(b.tenant._id) }), 0);
});

test('embed: token minted for a published dashboard serves data without internal fields; suspension blocks it', async () => {
  const ws = await workspace();
  const dash = await api('/api/v1/dashboards', { method: 'POST', headers: ws.auth, body: { name: 'Public KPIs' } });
  assert.equal(dash.status, 201);
  const dashboardId = dash.json.data._id;
  assert.equal((await api(`/api/v1/dashboards/${dashboardId}/publish`, { method: 'POST', headers: ws.auth })).status, 200);

  // embedding (roadmap 3.2): signed origin-bound tokens exchanged for an embed session.
  const minted = await api('/api/v1/embed/tokens', { method: 'POST', headers: ws.auth, body: { dashboardId, ttlSec: 600, allowedOrigins: ['https://host.example.com'] } });
  assert.equal(minted.status, 201, JSON.stringify(minted.json));
  const embedSecret = minted.json.data.secret;
  const origin = { origin: 'https://host.example.com' };
  const session = await api('/api/v1/embed/public/session', { method: 'POST', headers: origin, body: { token: embedSecret } });
  assert.equal(session.status, 200, JSON.stringify(session.json));

  const view = await api('/api/v1/embed/public/view', { method: 'POST', headers: { ...origin, authorization: `Bearer ${session.json.data.sessionToken}` }, body: {} });
  assert.equal(view.status, 200);
  assert.equal(view.json.data.dashboard.name, 'Public KPIs');
  assert.equal(view.json.data.dashboard.shares, undefined, 'share recipients are never exposed');
  assert.equal(view.json.data.dashboard.createdBy, undefined);

  const tokens = await api('/api/v1/embed/tokens', { headers: ws.auth });
  assert.ok(Array.isArray(tokens.json.data));

  await tenantLifecycle.suspend({ tenantId: String(ws.tenant._id), reason: 'test', by: 'platform-admin' });
  assert.equal((await api('/api/v1/embed/public/session', { method: 'POST', headers: origin, body: { token: embedSecret } })).status, 401);
});

test('invitations: an Admin cannot invite an Owner; revoked invitees cannot get in through password reset', async () => {
  const ws = await workspace();
  const admin = await member(ws, 'Admin');

  const asOwner = await api('/api/v1/invitations', {
    method: 'POST', headers: admin.auth, body: { email: 'escalate@example.com', roleName: 'Owner' },
  });
  assert.equal(asOwner.status, 403);
  const asViewer = await api('/api/v1/invitations', {
    method: 'POST', headers: admin.auth, body: { email: 'viewer@example.com', roleName: 'Viewer' },
  });
  assert.ok([200, 201, 202].includes(asViewer.status), JSON.stringify(asViewer.json));

  const invitation = asViewer.json.data.invitation;
  await invitationService.revoke({ id: invitation._id, tenantId: String(ws.tenant._id), by: 'platform-admin' });

  const sink = [];
  emailService.captureInto(sink);
  const forgot = await api('/api/v1/auth/password/forgot', {
    method: 'POST', headers: { 'X-Tenant-Id': ws.slug }, body: { email: 'viewer@example.com' },
  });
  emailService.stopCapture();
  assert.equal(forgot.status, 200);
  assert.equal(sink.length, 0, 'no reset email for a revoked, never-activated invitee');
});

test('workspace users cannot assign themselves a paid plan or lift a restriction without payment', async () => {
  await planService.ensureDefaults();
  const ws = await workspace();
  const res = await api(`/api/v1/tenants/${ws.tenant._id}/subscription/change-plan`, {
    method: 'POST', headers: ws.auth, body: { planId: 'enterprise' },
  });
  assert.equal(res.status, 403, JSON.stringify(res.json));
});

test('admin listings never include credential material; MFA re-enrolment is refused; admins cannot escalate themselves', async () => {
  const platformAdmin = await adminService.create({
    email: `ops-${randomBytes(3).toString('hex')}@example.com`, password: PASSWORD, adminType: 'platform',
  });
  const list = await adminService.list({});
  for (const doc of list.docs) {
    assert.equal(doc.passwordHash, undefined);
    assert.equal(doc.mfaSecret, undefined);
  }

  await adminRepository.updateMfa(String(platformAdmin._id), { mfaSecret: 'enc', mfaEnabled: true });
  await assert.rejects(
    () => mfaService.enroll({ adminId: String(platformAdmin._id), email: platformAdmin.email }),
    (err) => err.statusCode === 409,
  );

  const role = await roleService.create({ tenantId: null, name: `ops_${randomBytes(3).toString('hex')}` });
  await assert.rejects(
    () => adminService.assignRole({ adminId: String(platformAdmin._id), roleId: String(role._id), by: String(platformAdmin._id) }),
    (err) => err.statusCode === 403,
  );
  await assert.rejects(
    () => adminService.update({ id: String(platformAdmin._id), patch: { adminType: 'super' }, by: String(platformAdmin._id) }),
    (err) => err.statusCode === 403,
  );
});

test('analytics rejects filter values that smuggle aggregation expressions', async () => {
  const ws = await workspace();
  const filters = encodeURIComponent(JSON.stringify([{ field: 'a', op: 'eq', value: { $range: [0, 100000000] } }]));
  const res = await api(`/api/v1/analytics?filters=${filters}`, { headers: ws.auth });
  assert.equal(res.status, 400);
  // Roadmap 1.1: query-contract rejections carry the dedicated code.
  assert.equal(res.json.code, 'INVALID_QUERY');
  assert.ok(res.json.errors.some((e) => e.field === 'filters[0].value'));
});
