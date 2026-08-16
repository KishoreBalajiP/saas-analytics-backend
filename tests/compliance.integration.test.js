/**
 * Compliance pipeline - end-to-end HTTP integration tests (Sprint 8).
 *
 * WHY IT EXISTS
 *   Proves the data-subject request contract end to end: admin filing and
 *   cancellation, queued fulfillment (export evidence artifact, erasure of a
 *   user), the subject-facing HMAC poll surface, and the tenant-scoped admin
 *   boundary.
 *
 * DESIGN
 *   - Real Express app on an ephemeral port + real in-memory MongoDB + the
 *     in-memory queue transport (the export worker registered by `app.js`
 *     drains jobs in-process).
 *   - RBAC seeding mirrors `tests/routes/rbac.integration.test.js`.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from './helpers/mongo.js';
import { startHttp, stopHttp, api } from './helpers/http.js';
import { factories } from './helpers/factories.js';
import { shortToken } from '../src/utils/id.js';
import adminService from '../src/services/admin.service.js';
import roleService from '../src/services/role.service.js';
import permissionService from '../src/services/permission.service.js';
import complianceService from '../src/services/compliance.service.js';
import complianceRepository from '../src/repositories/compliance.repository.js';
import userRepository from '../src/repositories/user.repository.js';
import * as storageService from '../src/services/storage.service.js';
import rbacCache from '../src/services/rbac.cache.service.js';

import { Role } from '../src/models/Role.js';
import { AdminRole } from '../src/models/AdminRole.js';
import { Permission } from '../src/models/Permission.js';
import { Module } from '../src/models/Module.js';
import { Admin } from '../src/models/Admin.js';
import { ComplianceLog } from '../src/models/ComplianceLog.js';

const PASSWORD = 'Password123!';
const COMPLIANCE_KEYS = ['compliance.view', 'compliance.create', 'compliance.update'];

before(async () => {
  await startMongo();
  await Promise.all([Role.init(), AdminRole.init(), Permission.init(), Module.init(), Admin.init(), ComplianceLog.init()]);
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

/* ------------------------------- helpers -------------------------------- */

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

async function seedAdmin(keys, overrides = {}) {
  const admin = await adminService.create({
    email: `root-${shortToken(8)}@example.com`,
    password: PASSWORD,
    adminType: 'platform',
    name: 'Root',
    ...overrides,
  });
  const role = await roleService.create({ tenantId: null, name: `root_${shortToken(8)}` });
  for (const key of keys) {
    await ensurePermission(key);
    await roleService.addPermission({ roleId: role._id, permissionKey: key, by: admin._id });
  }
  await adminService.assignRole({
    adminId: admin._id,
    roleId: role._id,
    tenantId: admin.tenantScope ?? null,
    by: admin._id,
  });
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

async function root(overrides = {}) {
  const admin = await seedAdmin(COMPLIANCE_KEYS, overrides);
  return { admin, auth: await adminAuth(admin) };
}

/** Create a real tenant + an active subject user under it. */
async function seedSubject() {
  const tenant = await factories.tenant.create();
  const user = await factories.user.create({ tenantId: tenant._id.toString() });
  return { tenant, user };
}

/** User-portal login -> Bearer header for the public endpoints. */
async function userAuth(user, tenant) {
  const login = await api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenant._id.toString() },
    body: { email: user.email, password: PASSWORD },
  });
  assert.equal(login.status, 200);
  return { authorization: `Bearer ${login.json.data.accessToken}` };
}

/** Poll an admin request until terminal, or timeout. */
async function waitForRequest(requestId, auth, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await api(`/api/v1/compliance/requests/${requestId}`, { headers: auth });
    assert.equal(res.status, 200);
    const status = res.json.data.status;
    if (status !== 'received' && status !== 'in_progress') return res.json.data;
    assert.ok(Date.now() < deadline, `request did not finish within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Clean the stored evidence artifact after a completed request. */
async function deleteEvidence(storageKey) {
  if (storageKey) await storageService.del(storageKey);
}

/** Poll the public status surface until the request reaches a terminal state. */
async function waitForPublicRequest(requestId, token, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await api(`/api/v1/compliance/public/requests/${requestId}?token=${token}`);
    assert.equal(res.status, 200);
    if (!['received', 'in_progress'].includes(res.json.data.status)) return res.json.data;
    assert.ok(Date.now() < deadline, `request did not finish within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/* --------------------------- admin export flow --------------------------- */

test('admin files an export request; queue materialises evidence with audit trail', async () => {
  const { auth } = await root();
  const { user } = await seedSubject();

  const req = await api('/api/v1/compliance/requests', {
    method: 'POST',
    headers: auth,
    body: { subjectId: user._id.toString(), type: 'export', reason: 'SAR request from subject' },
  });
  assert.equal(req.status, 202);
  assert.equal(req.json.data.status, 'received');
  assert.ok(req.json.data.requestId.startsWith('crq_'));

  const done = await waitForRequest(req.json.data.requestId, auth);
  assert.equal(done.status, 'completed');
  assert.ok(done.evidenceKey, 'completed request carries an evidence reference');
  assert.ok(typeof done.evidenceUrl === 'string', 'completed request exposes a download URL');

  try {
    const artifact = await storageService.getJson(done.evidenceKey);
    assert.equal(artifact.type, 'export');
    assert.equal(artifact.subjectId, user._id.toString());
    assert.ok(Array.isArray(artifact.records));
  } finally {
    await deleteEvidence(done.evidenceKey);
  }
});

test('admin files a delete request; the subject user is erased and state flips', async () => {
  const { auth } = await root();
  const { tenant, user } = await seedSubject();

  const req = await api('/api/v1/compliance/requests', {
    method: 'POST',
    headers: auth,
    body: { subjectId: user._id.toString(), type: 'delete', reason: 'Right to erasure' },
  });
  assert.equal(req.status, 202);

  const done = await waitForRequest(req.json.data.requestId, auth);
  assert.equal(done.status, 'completed');

  assert.equal(await userRepository.findById(user._id.toString()), null, 'user is soft-deleted');

  const state = await complianceService.getSubjectComplianceState({ subjectId: user._id.toString() });
  assert.equal(state.deleted, true);
  assert.equal(state.restricted, false);

  await deleteEvidence(done.evidenceKey);
});

/* ----------------------------- admin cancel ------------------------------ */

test('admin cancels a request before work starts', async () => {
  const { auth } = await root();
  const { user } = await seedSubject();

  const req = await api('/api/v1/compliance/requests', {
    method: 'POST',
    headers: auth,
    body: { subjectId: user._id.toString(), type: 'export', reason: 'SAR - cancelling' },
  });
  assert.equal(req.status, 202);
  const requestId = req.json.data.requestId;

  // Cancel immediately - the in-process worker may or may not have finished.
  // If the job already completed, the cancel must conflict (409) and the
  // request stays completed; otherwise it flips to `cancelled`.
  const cancel = await api(`/api/v1/compliance/requests/${requestId}/cancel`, {
    method: 'POST',
    headers: auth,
    body: { reason: 'Subject withdrew the request' },
  });
  assert.ok([200, 409].includes(cancel.status), `cancel returned ${cancel.status}`);

  const done = await waitForRequest(requestId, auth);
  assert.ok(
    done.status === 'cancelled' || done.status === 'completed',
    `terminal state must be cancelled or completed, got ${done.status}`,
  );

  // Re-cancel must always conflict (terminal state).
  const again = await api(`/api/v1/compliance/requests/${requestId}/cancel`, {
    method: 'POST',
    headers: auth,
    body: { reason: 'double cancel' },
  });
  assert.equal(again.status, 409);

  await deleteEvidence(done.evidenceKey);
});

/* --------------------------- public subject flow ------------------------- */

test('subject files on their own behalf and polls status with a signed token', async () => {
  const { tenant, user } = await seedSubject();
  const auth = await userAuth(user, tenant);

  const req = await api('/api/v1/compliance/public/requests', {
    method: 'POST',
    headers: auth,
    body: { type: 'restrict', reason: 'I want my processing paused' },
  });
  assert.equal(req.status, 202);
  assert.equal(req.json.data.subjectId, user._id.toString());
  assert.ok(req.json.data.pollToken, 'subject receives a non-bearer poll token');

  // The signed token is the only way to read status: poll until terminal.
  const poll = await waitForPublicRequest(req.json.data.requestId, req.json.data.pollToken);
  assert.equal(poll.requestId, req.json.data.requestId);
  assert.equal(poll.status, 'completed');
  assert.equal(poll.evidenceAvailable, true);
  assert.ok(!('evidenceKey' in poll), 'public projection hides internal evidence refs');

  // The restriction is now active for the subject.
  const state = await complianceService.getSubjectComplianceState({ subjectId: user._id.toString() });
  assert.equal(state.restricted, true);

  // A tampered token must be rejected (403), not leak status.
  const bad = await api(`/api/v1/compliance/public/requests/${req.json.data.requestId}?token=${req.json.data.pollToken}x`);
  assert.equal(bad.status, 403);

  const row = await complianceRepository.findByRequestId(req.json.data.requestId);
  await deleteEvidence(row.evidenceKey);
});

/* --------------------------- tenant admin boundary ------------------------ */

test('tenant-scoped support admin only sees requests inside their tenant scope', async () => {
  const platform = await root();
  const { user } = await seedSubject();

  // Platform-wide request (empty tenantScope) - invisible to a tenant admin.
  const req = await api('/api/v1/compliance/requests', {
    method: 'POST',
    headers: platform.auth,
    body: { subjectId: user._id.toString(), type: 'export', reason: 'Platform SAR' },
  });
  assert.equal(req.status, 202);
  await waitForRequest(req.json.data.requestId, platform.auth);

  const support = await seedAdmin(COMPLIANCE_KEYS, { adminType: 'support', tenantScope: 't1' });
  const supportAuth = await adminAuth(support);

  const hidden = await api(`/api/v1/compliance/requests/${req.json.data.requestId}`, { headers: supportAuth });
  assert.equal(hidden.status, 404, 'tenant-scoped admin must not see a platform-wide request');

  // A request scoped to the support admin's tenant IS visible.
  const scoped = await api('/api/v1/compliance/requests', {
    method: 'POST',
    headers: supportAuth,
    body: {
      subjectId: user._id.toString(),
      type: 'export',
      reason: 'Tenant SAR',
      tenantScope: ['t1'],
    },
  });
  assert.equal(scoped.status, 202);
  await waitForRequest(scoped.json.data.requestId, supportAuth);
  const visible = await api(`/api/v1/compliance/requests/${scoped.json.data.requestId}`, { headers: supportAuth });
  assert.equal(visible.status, 200);
  assert.equal(visible.json.data.status, 'completed');

  const row = await complianceRepository.findByRequestId(scoped.json.data.requestId);
  await deleteEvidence(row.evidenceKey);
});
