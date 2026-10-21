/**
 * Retention HTTP surface (roadmap 2.7):
 *   - expired audit exports answer 410 EXPORT_EXPIRED and never get a new
 *     download URL; cleanup removes the stored file (finding gov.11);
 *   - mail/outbox health, outbox listing and dead-letter requeue, and the
 *     retention status page, with their permission and tenant-scope gates.
 */

import test, { describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import { shortToken } from '../../src/utils/id.js';
import clock from '../../src/utils/clock.js';
import adminService from '../../src/services/admin.service.js';
import roleService from '../../src/services/role.service.js';
import permissionService from '../../src/services/permission.service.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import auditLogService from '../../src/services/auditLog.service.js';
import auditExportRepository from '../../src/repositories/auditExport.repository.js';
import retentionService from '../../src/services/retention.service.js';
import outboxService from '../../src/services/outbox.service.js';
import * as storageService from '../../src/services/storage.service.js';
import { OutboundEmail } from '../../src/models/OutboundEmail.js';
import { Role } from '../../src/models/Role.js';
import { AdminRole } from '../../src/models/AdminRole.js';
import { Permission } from '../../src/models/Permission.js';
import { Module } from '../../src/models/Module.js';
import { Admin } from '../../src/models/Admin.js';

const PASSWORD = 'Password123!';

before(async () => {
  await startMongo();
  await Promise.all([Role.init(), AdminRole.init(), Permission.init(), Module.init(), Admin.init()]);
  await startHttp();
});

beforeEach(async () => {
  await resetMongo();
  await rbacCache.clearAll();
  outboxService.resetOutboxStateForTests();
  outboxService.setDispatchOnEnqueue(false);
});

afterEach(() => {
  clock.reset();
});

after(async () => {
  clock.reset();
  outboxService.resetOutboxStateForTests();
  await stopHttp();
  await stopMongo();
});

async function ensureModule(key) {
  if (key.includes('.')) await ensureModule(key.slice(0, key.lastIndexOf('.')));
  try { await permissionService.createModule({ key, name: key }); } catch (err) { if (err.statusCode !== 409) throw err; }
}

async function ensurePermission(key) {
  const module = key.slice(0, key.lastIndexOf('.'));
  const action = key.slice(key.lastIndexOf('.') + 1);
  await ensureModule(module);
  try { await permissionService.createPermission({ module, action }); } catch (err) { if (err.statusCode !== 409) throw err; }
}

async function adminWith(keys, overrides = {}) {
  const admin = await adminService.create({
    email: `ret-${shortToken(8)}@platform.test`, password: PASSWORD, adminType: 'platform', name: 'Retention', ...overrides,
  });
  const role = await roleService.create({ tenantId: null, name: `ret_${shortToken(8)}` });
  for (const key of keys) {
    await ensurePermission(key);
    await roleService.addPermission({ roleId: role._id, permissionKey: key, by: null /* fixture seeding */ });
  }
  await adminService.assignRole({ adminId: admin._id, roleId: role._id, tenantId: admin.tenantScope ?? null, by: null /* fixture seeding */ });
  const login = await api('/api/v1/admin-auth/login', { method: 'POST', body: { email: admin.email, password: PASSWORD } });
  assert.equal(login.status, 200);
  return { authorization: `Bearer ${login.json.data.accessToken}` };
}

/* ----------------------------- export expiry ----------------------------- */

describe('audit export expiry', () => {
  test('an expired export answers 410, never re-signs a URL, and cleanup deletes the file', async () => {
    const auth = await adminWith(['audit_logs.view', 'audit_logs.export']);
    await auditLogService.emit({ actor: { type: 'admin', id: 'root' }, action: 'create', module: 'iam.tenants', resource: { type: 'tenant', id: 't1' }, tenantId: 't1' });

    const req = await api('/api/v1/audit-logs/export', { method: 'POST', headers: auth, body: { format: 'json', filters: {} } });
    assert.equal(req.status, 202);
    const exportId = req.json.data.exportId;
    let status;
    for (let i = 0; i < 50; i += 1) {
      status = await api(`/api/v1/audit-logs/export/${exportId}`, { headers: auth });
      if (status.json.data?.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(status.status, 200);
    assert.equal(status.json.data.status, 'completed');
    assert.equal(typeof status.json.data.downloadUrl, 'string');
    const expiresAt = new Date(status.json.data.expiresAt);
    const row = await auditExportRepository.findByExportId(exportId);
    assert.equal(await storageService.exists(row.storageKey), true);

    // Past the window: 410 with the typed code and no URL.
    clock.set(new Date(expiresAt.getTime() + 1000));
    const expired = await api(`/api/v1/audit-logs/export/${exportId}`, { headers: auth });
    assert.equal(expired.status, 410);
    assert.equal(expired.json.code, 'EXPORT_EXPIRED');
    assert.equal(expired.json.data?.downloadUrl, undefined);

    // Cleanup deletes the stored object; polls still answer 410.
    const report = await retentionService.runRetention({ now: clock.now(), dryRun: false, only: ['exportArtifacts'] });
    assert.equal(report.policies[0].objectsDeleted, 1);
    assert.equal(await storageService.exists(row.storageKey), false);
    const after = await api(`/api/v1/audit-logs/export/${exportId}`, { headers: auth });
    assert.equal(after.status, 410);

    // Unknown ids are still 404, not 410.
    const missing = await api('/api/v1/audit-logs/export/exp_does_not_exist', { headers: auth });
    assert.equal(missing.status, 404);
  });
});

/* --------------------------- monitoring surface -------------------------- */

async function seedMessages() {
  const a = await outboxService.enqueueEmail({ tenantId: 't1', to: 'alice@example.com', template: 'auth.password_reset', variables: { resetUrl: 'https://app.example.com/login/reset?token=secret body' }, idempotencyKey: 'k1' });
  const b = await outboxService.enqueueEmail({ tenantId: 't2', to: 'bob@example.com', template: 'auth.password_reset', variables: { resetUrl: 'https://app.example.com/login/reset?token=secret body' }, idempotencyKey: 'k2' });
  await OutboundEmail.updateOne({ _id: b.id }, { $set: { status: 'dead', deadAt: new Date(), lastError: { code: 'SEND_FAILED', message: 'boom' } } });
  return { a, b };
}

describe('mail and outbox monitoring', () => {
  test('endpoints require an admin with monitoring.view', async () => {
    for (const path of ['/api/v1/monitoring/health/mail', '/api/v1/monitoring/outbox', '/api/v1/monitoring/retention']) {
      const anon = await api(path);
      assert.equal(anon.status, 401, path);
    }
    const other = await adminWith(['audit_logs.view']);
    for (const path of ['/api/v1/monitoring/health/mail', '/api/v1/monitoring/outbox', '/api/v1/monitoring/retention']) {
      const denied = await api(path, { headers: other });
      assert.equal(denied.status, 403, path);
    }
  });

  test('mail health, outbox listing (masked) and the retention status', async () => {
    const headers = await adminWith(['monitoring.view']);
    await seedMessages();

    const health = await api('/api/v1/monitoring/health/mail', { headers });
    assert.equal(health.status, 200);
    assert.equal(health.json.data.status, 'disabled');
    assert.equal(health.json.data.outbox.dead, 1);

    const list = await api('/api/v1/monitoring/outbox?limit=10', { headers });
    assert.equal(list.status, 200);
    assert.equal(list.json.meta.total, 2);
    const body = JSON.stringify(list.json.data);
    assert.ok(!body.includes('alice@example.com'), 'recipients are masked');
    assert.ok(!body.includes('variablesEnc') && !body.includes('secret body'), 'variables never returned');
    const dead = await api('/api/v1/monitoring/outbox?status=dead', { headers });
    assert.equal(dead.json.meta.total, 1);
    const bad = await api('/api/v1/monitoring/outbox?status=nope', { headers });
    assert.equal(bad.status, 400);

    const retention = await api('/api/v1/monitoring/retention', { headers });
    assert.equal(retention.status, 200);
    assert.equal(retention.json.data.job.name, 'cleanup');
    const keys = retention.json.data.policies.map((p) => p.key);
    for (const key of ['auditLogs', 'accessLogs', 'exportArtifacts', 'outboundEmails', 'idempotencyKeys']) assert.ok(keys.includes(key), key);

    const aggregate = await api('/api/v1/monitoring/health/aggregate', { headers });
    assert.equal(aggregate.status, 200);
    assert.equal(aggregate.json.data.mail.status, 'disabled');
  });

  test('requeue needs monitoring.update and only applies to dead letters', async () => {
    const { a, b } = await seedMessages();
    const viewer = await adminWith(['monitoring.view']);
    const denied = await api(`/api/v1/monitoring/outbox/${b.id}/requeue`, { method: 'POST', headers: viewer });
    assert.equal(denied.status, 403);

    const operator = await adminWith(['monitoring.update']);
    const ok = await api(`/api/v1/monitoring/outbox/${b.id}/requeue`, { method: 'POST', headers: operator });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.data.status, 'pending');
    assert.equal(ok.json.data.attempts, 0);

    const notDead = await api(`/api/v1/monitoring/outbox/${a.id}/requeue`, { method: 'POST', headers: operator });
    assert.equal(notDead.status, 409);
    const unknown = await api('/api/v1/monitoring/outbox/not-an-id/requeue', { method: 'POST', headers: operator });
    assert.equal(unknown.status, 404);
  });

  test('a tenant-scoped admin only sees and requeues its own tenant\'s messages', async () => {
    const { b } = await seedMessages();
    const scoped = await adminWith(['monitoring.view', 'monitoring.update'], { adminType: 'support', tenantScope: 't1' });
    // Naming another tenant is refused (roles: ADMIN_SCOPE_DENIED); without a
    // filter the scoped admin only sees its own tenant's messages.
    const other = await api('/api/v1/monitoring/outbox?tenantId=t2', { headers: scoped });
    assert.equal(other.status, 403, JSON.stringify(other.json));
    assert.equal(other.json.code, 'ADMIN_SCOPE_DENIED');
    const list = await api('/api/v1/monitoring/outbox', { headers: scoped });
    assert.equal(list.status, 200, JSON.stringify(list.json));
    assert.equal(list.json.meta.total, 1);
    assert.equal(list.json.data[0].tenantId, 't1');
    const requeue = await api(`/api/v1/monitoring/outbox/${b.id}/requeue`, { method: 'POST', headers: scoped });
    assert.equal(requeue.status, 404, 'another tenant\'s message is invisible');
  });
});
