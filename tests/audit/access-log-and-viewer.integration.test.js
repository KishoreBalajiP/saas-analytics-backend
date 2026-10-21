/**
 * Access-log capture and export, and the audit read API (roadmap 2.5;
 * findings gov.12, gov.14).
 *
 *   - authenticated requests are traced without the query string;
 *   - failed and successful logins are traced with ip (sign-in surface);
 *   - API-key traffic is traced as `service` with the key id;
 *   - access-log exports honour the access-log filters and carry real ids
 *     (JSON and CSV); audit CSV exports carry ids too;
 *   - the capture buffer is persisted by the graceful-shutdown step;
 *   - `/audit-logs` filters security events and keeps scoped admins inside
 *     their tenant.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import { shortToken } from '../../src/utils/id.js';
import * as tenantService from '../../src/services/tenant.service.js';
import adminService from '../../src/services/admin.service.js';
import roleService from '../../src/services/role.service.js';
import permissionService from '../../src/services/permission.service.js';
import auditLogService from '../../src/services/auditLog.service.js';
import * as accessLogService from '../../src/services/accessLog.service.js';
import auditExportService from '../../src/services/auditExport.service.js';
import * as storageService from '../../src/services/storage.service.js';
import auditExportRepository from '../../src/repositories/auditExport.repository.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import { sanitizeAccessLogFilters, sanitizeAuditFilters } from '../../src/utils/auditFilters.js';
import { defaultShutdownDeps } from '../../src/jobs/background.js';
import { buildShutdownSteps, runShutdownSteps } from '../../src/jobs/shutdown.js';
import { AccessLog } from '../../src/models/AccessLog.js';
import { User } from '../../src/models/User.js';
// billing: tenants exercising paid features need a plan that includes them.
import { entitleTenant } from '../helpers/billing.js';

const PASSWORD = 'Password123!';

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => {
  await accessLogService.flush();
  await resetMongo();
  await rbacCache.clearAll();
  await cacheService.flushAll();
});
after(async () => { await stopHttp(); await stopMongo(); });

/** Flush the capture buffer and read the trace. */
async function trace(filter = {}) {
  await new Promise((resolve) => setTimeout(resolve, 30)); // let `finish` handlers run
  await accessLogService.flush();
  return AccessLog.find(filter).sort({ occurredAt: 1 }).lean();
}

async function workspace() {
  const owner = { email: `owner-${shortToken(10).toLowerCase()}@example.com`, name: 'Owner', password: PASSWORD };
  const { tenant } = await tenantService.create({ tenant: { name: `Acc ${shortToken(8)}` }, owner, initialize: true, by: 'root' });
  await entitleTenant(tenant._id);
  const tenantId = String(tenant._id);
  const user = await User.findOne({ tenantId, email: owner.email }).lean();
  const login = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email: owner.email, password: PASSWORD } });
  assert.equal(login.status, 200);
  return { tenantId, email: owner.email, userId: String(user._id), auth: { authorization: `Bearer ${login.json.data.accessToken}`, 'X-Tenant-Id': tenantId } };
}

async function ensurePermission(key) {
  const module = key.slice(0, key.lastIndexOf('.'));
  const action = key.slice(key.lastIndexOf('.') + 1);
  try { await permissionService.createModule({ key: module, name: module }); } catch (err) { if (err.statusCode !== 409) throw err; }
  try { await permissionService.createPermission({ module, action }); } catch (err) { if (err.statusCode !== 409) throw err; }
}

async function adminWith(keys, overrides = {}) {
  const admin = await adminService.create({ email: `adm-${shortToken(8).toLowerCase()}@example.com`, password: PASSWORD, adminType: 'platform', ...overrides });
  const role = await roleService.create({ tenantId: null, name: `r_${shortToken(8)}` });
  for (const key of keys) {
    await ensurePermission(key);
    await roleService.addPermission({ roleId: role._id, permissionKey: key, by: null });
  }
  await adminService.assignRole({ adminId: admin._id, roleId: role._id, tenantId: admin.tenantScope ?? null, by: null });
  const login = await api('/api/v1/admin-auth/login', { method: 'POST', body: { email: admin.email, password: PASSWORD } });
  assert.equal(login.status, 200);
  return { admin, auth: { authorization: `Bearer ${login.json.data.accessToken}` } };
}

/* --------------------------------- capture -------------------------------- */

test('authenticated requests are traced without the query string', async () => {
  const ws = await workspace();
  await api('/api/v1/users/me?token=should-not-be-stored&x=1', { headers: ws.auth });
  const rows = await trace({ actorId: ws.userId, path: /users\/me/ });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, '/api/v1/users/me');
  assert.equal(rows[0].actorType, 'user');
  assert.equal(rows[0].tenantId, ws.tenantId);
  assert.ok(!JSON.stringify(rows).includes('should-not-be-stored'));
});

test('failed and successful logins are traced with ip and the account that signed in', async () => {
  const ws = await workspace();
  const failed = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': ws.tenantId }, body: { email: ws.email, password: 'Wrong-password-1' } });
  assert.equal(failed.status, 401);
  const rows = await trace({ event: 'auth.login' });
  const failure = rows.find((r) => r.statusCode === 401);
  assert.ok(failure, 'the failed login is in the access log');
  assert.equal(failure.actorType, 'system');
  assert.equal(failure.actorId, null);
  assert.equal(failure.method, 'POST');
  assert.equal(failure.path, '/api/v1/auth/login');
  assert.match(failure.ip, /127\.0\.0\.1/);
  assert.equal(failure.error.code, '401');

  const success = rows.find((r) => r.statusCode === 200);
  assert.ok(success, 'the successful login (from workspace()) is in the access log');
  assert.equal(success.actorType, 'user');
  assert.equal(success.actorId, ws.userId);
  assert.equal(success.tenantId, ws.tenantId);
});

test('API-key traffic is traced as a service actor with the key id; refused keys are traced too', async () => {
  const ws = await workspace();
  const created = await api('/api/v1/api-keys', { method: 'POST', headers: ws.auth, body: { name: 'ci', scopes: ['datasets:read'] } });
  assert.equal(created.status, 201);
  const keyId = String(created.json.data.key.id);
  const ok = await api('/api/v1/external/datasets?page=1', { headers: { 'X-Api-Key': created.json.data.secret } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  await api('/api/v1/external/datasets', { headers: { 'X-Api-Key': 'sak_nope.' + 'x'.repeat(40) } });

  const rows = await trace({ event: 'api_key' });
  const call = rows.find((r) => r.statusCode === 200);
  assert.equal(call.actorType, 'service');
  assert.equal(call.actorId, keyId);
  assert.equal(call.tenantId, ws.tenantId);
  assert.equal(call.path, '/api/v1/external/datasets');
  const refused = rows.find((r) => r.statusCode === 401);
  assert.ok(refused);
  assert.equal(refused.actorId, null);
  assert.ok(!JSON.stringify(rows).includes(created.json.data.secret));
});

/* ---------------------------------- export --------------------------------- */

test('the export filter whitelists keep access-log and audit keys and drop unknown or object values', () => {
  const kept = sanitizeAccessLogFilters({
    method: 'POST', path: '/api/v1/auth/login', statusCode: 401, event: 'auth.login', actorType: 'system',
    dateFrom: '2026-01-01', bogus: 'x', $where: 'evil', tenantId: { $ne: null },
  });
  assert.deepEqual(kept, {
    actorType: 'system', method: 'POST', path: '/api/v1/auth/login', statusCode: '401', event: 'auth.login', dateFrom: '2026-01-01',
  });
  assert.deepEqual(sanitizeAuditFilters({ category: 'security', severity: 'warning', path: '/x' }), { category: 'security', severity: 'warning' });
});

test('an access-log export honours method/path/statusCode/event filters end to end', async () => {
  const ws = await workspace();
  await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': ws.tenantId }, body: { email: ws.email, password: 'Wrong-password-1' } });
  await api('/api/v1/users/me', { headers: ws.auth });
  await trace();
  const failedLogins = await AccessLog.countDocuments({ method: 'POST', statusCode: 401, event: 'auth.login' });
  assert.equal(failedLogins, 1);
  assert.ok((await AccessLog.countDocuments({})) > failedLogins, 'other traffic exists and must be filtered out');

  for (const format of ['json', 'csv']) {
    const { exportId, filters } = await accessLogService.requestExport({
      tenantId: null, requestedBy: 'root', format,
      filters: { method: 'POST', statusCode: 401, event: 'auth.login', path: '/api/v1/auth/login' },
    });
    assert.deepEqual(filters, { method: 'POST', path: '/api/v1/auth/login', statusCode: '401', event: 'auth.login' });
    await accessLogService.processExport({ exportId }).catch(() => {});
    const row = await auditExportRepository.findByExportId(exportId);
    assert.equal(row.status, 'completed', row.error ?? '');
    assert.equal(row.recordCount, 1);
    const stored = await AccessLog.findOne({ method: 'POST', statusCode: 401 }).lean();
    try {
      if (format === 'json') {
        const artifact = await storageService.getJson(row.storageKey);
        assert.equal(artifact.rows.length, 1);
        assert.equal(artifact.rows[0].id, String(stored._id));
      } else {
        const lines = (await storageService.get(row.storageKey)).toString('utf8').split('\n');
        const header = lines[0].split(',');
        const cells = lines[1].split(',');
        assert.equal(cells[header.indexOf('id')], String(stored._id), 'the id column is filled');
        assert.equal(cells[header.indexOf('errorCode')], '401');
        assert.match(cells[header.indexOf('occurredAt')], /^\d{4}-\d{2}-\d{2}T/);
      }
    } finally {
      await storageService.del(row.storageKey);
    }
  }
});

test('audit CSV exports carry ids, category and chain position', async () => {
  const entry = await auditLogService.emit({ actor: { type: 'admin', id: 'root' }, action: 'x', module: 'm', category: 'security', severity: 'notice' });
  const { exportId } = await auditExportService.requestExport({ tenantId: null, requestedBy: 'root', format: 'csv', filters: { category: 'security' } });
  await auditExportService.processExport({ exportId }).catch(() => {});
  const row = await auditExportRepository.findByExportId(exportId);
  assert.equal(row.status, 'completed', row.error ?? '');
  try {
    const lines = (await storageService.get(row.storageKey)).toString('utf8').split('\n');
    const header = lines[0].split(',');
    const cells = lines.slice(1).map((line) => line.split(',')).find((c) => c[header.indexOf('id')] === String(entry._id));
    assert.ok(cells, 'the exported row has its id');
    assert.equal(cells[header.indexOf('category')], 'security');
    assert.equal(cells[header.indexOf('seq')], String(entry.seq));
    assert.equal(cells[header.indexOf('hash')], entry.hash);
  } finally {
    await storageService.del(row.storageKey);
  }
});

/* --------------------------------- shutdown -------------------------------- */

test('the graceful-shutdown access-log step persists everything captured, including batches in flight', async () => {
  const capture = (i) => accessLogService.capture({ actorType: 'user', actorId: `u${i}`, method: 'GET', path: `/p/${i}`, statusCode: 200 });
  // A full batch starts writing on its own; more captures wait in the buffer.
  for (let i = 0; i < accessLogService.BATCH_SIZE + 7; i += 1) capture(i);
  assert.equal(accessLogService.pendingCount(), 7);

  const deps = {
    stopScheduler: async () => {}, closeQueues: async () => {}, closeLocks: async () => {},
    flushAccessLog: defaultShutdownDeps().flushAccessLog,
    closeCache: async () => {}, closeMail: async () => {}, disconnectDatabase: async () => {},
  };
  const outcome = await runShutdownSteps(buildShutdownSteps({ drainTimeoutMs: 100, deps }), { timeoutMs: 5000 });
  assert.equal(outcome.steps.find((s) => s.name === 'access-log').status, 'ok');
  assert.equal(accessLogService.pendingCount(), 0);
  assert.equal(await AccessLog.countDocuments({ path: /^\/p\// }), accessLogService.BATCH_SIZE + 7);
});

/* ---------------------------- login attempt trail --------------------------- */

test('GET /access-logs/login-attempts lists every sign-in attempt; scoped admins see their tenant only', async () => {
  const a = await workspace();
  const b = await workspace();
  for (let i = 0; i < 2; i += 1) {
    const res = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': a.tenantId }, body: { email: a.email, password: 'Wrong-password-1' } });
    assert.equal(res.status, 401);
  }
  await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': b.tenantId }, body: { email: b.email, password: 'Wrong-password-1' } });

  const platform = await adminWith(['access_logs.view']);
  const failed = await api(`/api/v1/access-logs/login-attempts?success=false&email=${encodeURIComponent(a.email.toUpperCase())}`, { headers: platform.auth });
  assert.equal(failed.status, 200, JSON.stringify(failed.json));
  assert.equal(failed.json.data.length, 2, 'each attempt is kept (the audit trail de-duplicates, this does not)');
  for (const row of failed.json.data) {
    assert.equal(row.success, false);
    assert.equal(row.reason, 'invalid_credentials');
    assert.equal(row.tenantId, a.tenantId);
    assert.match(row.ip, /127\.0\.0\.1/);
    assert.equal(row.password, undefined);
  }
  assert.equal(failed.json.meta.total, 2);

  const ok = await api(`/api/v1/access-logs/login-attempts?success=true&tenantId=${b.tenantId}`, { headers: platform.auth });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.ok(ok.json.data.length >= 1);
  assert.ok(ok.json.data.every((r) => r.success === true && r.tenantId === b.tenantId));
  const admins = await api('/api/v1/access-logs/login-attempts?actorType=admin', { headers: platform.auth });
  assert.ok(admins.json.data.some((r) => r.actorType === 'admin' && r.email === platform.admin.email), 'admin-portal sign-ins are listed for platform admins');

  const scoped = await adminWith(['access_logs.view'], { adminType: 'support', tenantScope: a.tenantId });
  // Asking for another tenant explicitly is refused (roles: ADMIN_SCOPE_DENIED);
  // without a tenant filter the scoped admin only ever sees its own tenant.
  const other = await api(`/api/v1/access-logs/login-attempts?tenantId=${b.tenantId}&limit=100`, { headers: scoped.auth });
  assert.equal(other.status, 403, JSON.stringify(other.json));
  assert.equal(other.json.code, 'ADMIN_SCOPE_DENIED');
  const mine = await api('/api/v1/access-logs/login-attempts?limit=100', { headers: scoped.auth });
  assert.equal(mine.status, 200, JSON.stringify(mine.json));
  assert.ok(mine.json.data.length >= 2);
  assert.ok(mine.json.data.every((r) => r.tenantId === a.tenantId), 'a scoped admin cannot read another tenant');

  assert.equal((await api('/api/v1/access-logs/login-attempts?reason=bogus', { headers: platform.auth })).status, 422);
  assert.equal((await api('/api/v1/access-logs/login-attempts?success=maybe', { headers: platform.auth })).status, 422);
  const noPerm = await adminWith(['audit_logs.view']);
  assert.equal((await api('/api/v1/access-logs/login-attempts', { headers: noPerm.auth })).status, 403);
  assert.equal((await api('/api/v1/access-logs/login-attempts')).status, 401);
});

/* ------------------------------ audit read API ----------------------------- */

test('GET /audit-logs filters security events; scoped admins only see their tenant', async () => {
  const platform = await adminWith(['audit_logs.view']);
  await auditLogService.emit({ actor: { type: 'admin', id: 'x' }, action: 'demo', module: 'demo', tenantId: 'tenant-a' });
  const sec = await auditLogService.emit({ actor: { type: 'user', id: 'u' }, action: 'auth.login.failed', module: 'iam.auth', category: 'security', severity: 'notice', tenantId: 'tenant-a', result: 'failure' });
  const other = await auditLogService.emit({ actor: { type: 'user', id: 'v' }, action: 'auth.login.failed', module: 'iam.auth', category: 'security', severity: 'notice', tenantId: 'tenant-b', result: 'failure' });

  const security = await api('/api/v1/audit-logs?category=security&limit=100', { headers: platform.auth });
  assert.equal(security.status, 200, JSON.stringify(security.json));
  assert.ok(security.json.data.length >= 2);
  assert.ok(security.json.data.every((r) => r.category === 'security'));
  const changes = await api('/api/v1/audit-logs?category=change&limit=100', { headers: platform.auth });
  assert.ok(changes.json.data.every((r) => r.category !== 'security'));
  assert.ok(changes.json.data.some((r) => r.module === 'demo'));
  const warnings = await api('/api/v1/audit-logs?category=security&severity=notice&tenantId=tenant-a', { headers: platform.auth });
  assert.deepEqual(warnings.json.data.map((r) => String(r._id)), [String(sec._id)]);
  assert.equal((await api('/api/v1/audit-logs?category=bogus', { headers: platform.auth })).status, 422);

  const scoped = await adminWith(['audit_logs.view'], { adminType: 'support', tenantScope: 'tenant-a' });
  const otherTenant = await api('/api/v1/audit-logs?tenantId=tenant-b&limit=100', { headers: scoped.auth });
  assert.equal(otherTenant.status, 403, JSON.stringify(otherTenant.json));
  assert.equal(otherTenant.json.code, 'ADMIN_SCOPE_DENIED');
  const mine = await api('/api/v1/audit-logs?limit=100', { headers: scoped.auth });
  assert.equal(mine.status, 200, JSON.stringify(mine.json));
  assert.ok(mine.json.data.length > 0);
  assert.ok(mine.json.data.every((r) => r.tenantId === 'tenant-a'), 'a scoped admin cannot read another tenant');
  assert.equal((await api(`/api/v1/audit-logs/${other._id}`, { headers: scoped.auth })).status, 404);
  assert.equal((await api(`/api/v1/audit-logs/${sec._id}`, { headers: scoped.auth })).status, 200);
});
