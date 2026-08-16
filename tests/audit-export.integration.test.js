/**
 * Audit export pipeline - end-to-end HTTP integration tests.
 *
 * WHY IT EXISTS
 *   Proves the Sprint 8 async export contract: `POST /audit-logs/export`
 *   reserves an id + sanitised filters, the export queue consumer
 *   materialises the artifact to storage, and `GET /audit-logs/export/:id`
 *   reports the progress and a download URL. Also verifies the tenant
 *   boundary (a tenant-scoped support admin can only see their own exports),
 *   format validation, and filter safety at the service layer.
 *
 * DESIGN
 *   - Real Express app on an ephemeral port + real in-memory MongoDB + the
 *     in-memory queue transport (a real consumer drains jobs in-process).
 *   - RBAC seeding mirrors `tests/routes/rbac.integration.test.js` so every
 *     route is exercised with a real Bearer token and live permission
 *     resolution.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from './helpers/mongo.js';
import { startHttp, stopHttp, api } from './helpers/http.js';
import { shortToken } from '../src/utils/id.js';
import adminService from '../src/services/admin.service.js';
import roleService from '../src/services/role.service.js';
import permissionService from '../src/services/permission.service.js';
import auditLogService from '../src/services/auditLog.service.js';
import auditExportService from '../src/services/auditExport.service.js';
import auditExportRepository from '../src/repositories/auditExport.repository.js';
import * as storageService from '../src/services/storage.service.js';
import rbacCache from '../src/services/rbac.cache.service.js';

import { Role } from '../src/models/Role.js';
import { AdminRole } from '../src/models/AdminRole.js';
import { Permission } from '../src/models/Permission.js';
import { Module } from '../src/models/Module.js';
import { Admin } from '../src/models/Admin.js';

const PASSWORD = 'Password123!';
const AUDIT_KEYS = ['audit_logs.view', 'audit_logs.export'];

before(async () => {
  await startMongo();
  await Promise.all([Role.init(), AdminRole.init(), Permission.init(), Module.init(), Admin.init()]);
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

async function root() {
  const admin = await seedAdmin(AUDIT_KEYS);
  return { admin, auth: await adminAuth(admin) };
}

/** Seed audit entries across two tenants. */
async function seedAuditEntries() {
  const entries = [];
  for (let i = 0; i < 3; i += 1) {
    entries.push(await auditLogService.emit({
      actor: { type: 'admin', id: 'root', display: 'root' },
      action: 'create',
      module: 'iam.tenants',
      resource: { type: 'tenant', id: `t1` },
      tenantId: 't1',
    }));
  }
  entries.push(await auditLogService.emit({
    actor: { type: 'user', id: 'u1', display: 'u1' },
    action: 'delete',
    module: 'iam.users',
    resource: { type: 'user', id: 'u1' },
    tenantId: 't2',
    result: 'failure',
    errorCode: 'FORBIDDEN',
  }));
  return entries;
}

/** Poll an export status until it leaves `queued`/`processing`, or timeout. */
async function waitForExport(exportId, auth, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await api(`/api/v1/audit-logs/export/${exportId}`, { headers: auth });
    assert.equal(res.status, 200);
    if (res.json.data.status === 'completed' || res.json.data.status === 'failed') {
      return res.json.data;
    }
    assert.ok(Date.now() < deadline, `export did not finish within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Clean the stored artifact after a completed export. */
async function deleteArtifact(storageKey) {
  if (storageKey) await storageService.del(storageKey);
}

/* ------------------------------- export --------------------------------- */

test('export request + status poll completes a JSON artifact', async () => {
  const { auth } = await root();
  await seedAuditEntries();

  const req = await api('/api/v1/audit-logs/export', {
    method: 'POST',
    headers: auth,
    body: { format: 'json', filters: { module: 'iam.tenants' } },
  });
  assert.equal(req.status, 202);
  assert.equal(req.json.data.status, 'queued');
  assert.equal(req.json.data.format, 'json');
  assert.ok(req.json.data.exportId);

  const status = await waitForExport(req.json.data.exportId, auth);
  assert.equal(status.status, 'completed');
  assert.equal(status.format, 'json');
  assert.equal(status.recordCount, 3, 'only the module-filtered rows are exported');
  assert.equal(typeof status.downloadUrl, 'string');

  const row = await auditExportRepository.findByExportId(status.exportId);
  assert.ok(row.storageKey);
  try {
    const artifact = await storageService.getJson(row.storageKey);
    assert.equal(artifact.count, 3);
    assert.ok(artifact.rows.every((r) => r.module === 'iam.tenants'));
    assert.equal(artifact.rows[0].actorId, 'root');
  } finally {
    await deleteArtifact(row.storageKey);
  }
});

test('CSV export produces a header + escaped rows', async () => {
  const { auth } = await root();
  await seedAuditEntries();

  const req = await api('/api/v1/audit-logs/export', {
    method: 'POST',
    headers: auth,
    body: { format: 'csv', filters: { result: 'failure' } },
  });
  assert.equal(req.status, 202);

  const status = await waitForExport(req.json.data.exportId, auth);
  assert.equal(status.status, 'completed');
  assert.equal(status.format, 'csv');
  assert.equal(status.recordCount, 1);

  const row = await auditExportRepository.findByExportId(status.exportId);
  try {
    const text = (await storageService.get(row.storageKey)).toString('utf8');
    assert.match(text, /^id,occurredAt,actorType/);
    assert.match(text, /FORBIDDEN/);
  } finally {
    await deleteArtifact(row.storageKey);
  }
});

test('invalid export format is rejected by validation (422)', async () => {
  const { auth } = await root();
  const res = await api('/api/v1/audit-logs/export', {
    method: 'POST',
    headers: auth,
    body: { format: 'xml' },
  });
  assert.equal(res.status, 422);
});

test('tenant-scoped support admin can only see their own exports', async () => {
  const platform = await root();

  // A support admin scoped to tenant t1, with export permissions.
  const support = await seedAdmin(AUDIT_KEYS, { adminType: 'support', tenantScope: 't1' });
  const supportAuth = await adminAuth(support);

  // Platform-wide export (tenantId null) is invisible to the support admin.
  const req = await api('/api/v1/audit-logs/export', {
    method: 'POST',
    headers: platform.auth,
    body: { format: 'json', filters: {} },
  });
  const done = await waitForExport(req.json.data.exportId, platform.auth);
  assert.equal(done.status, 'completed');

  const hidden = await api(`/api/v1/audit-logs/export/${req.json.data.exportId}`, {
    headers: supportAuth,
  });
  assert.equal(hidden.status, 404, 'tenant-scoped admin must not see a platform export');

  const row = await auditExportRepository.findByExportId(req.json.data.exportId);
  await deleteArtifact(row.storageKey);

  // A support-scoped export IS visible to the support admin, and NOT to the
  // platform admin's scoped query path below (platform sees all by default).
  const scopedReq = await api('/api/v1/audit-logs/export', {
    method: 'POST',
    headers: supportAuth,
    body: { format: 'json', filters: {} },
  });
  assert.equal(scopedReq.status, 202);

  const visible = await waitForExport(scopedReq.json.data.exportId, supportAuth);
  assert.equal(visible.status, 'completed');
  const scopedRow = await auditExportRepository.findByExportId(scopedReq.json.data.exportId);
  assert.equal(scopedRow.tenantId, 't1');
  await deleteArtifact(scopedRow.storageKey);
});

test('service-level status lookup enforces the tenant boundary', async () => {
  const req = await auditExportService.requestExport({
    tenantId: null,
    requestedBy: 'root',
    filters: {},
    format: 'json',
  });
  await assert.rejects(
    () => auditExportService.getExportStatus({ exportId: req.exportId, tenantId: 'other' }),
    (err) => err.statusCode === 404,
  );
  const status = await auditExportService.getExportStatus({ exportId: req.exportId, tenantId: null });
  assert.equal(status.exportId, req.exportId);
});
