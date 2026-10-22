/**
 * Members package (roadmap 2.10; ten.14): workspace deletion with a grace
 * period and a verified purge.
 *
 * Covers: the Owner's request needs the typed slug and the password, closes
 * the workspace at once and schedules the purge; the grace period is
 * honoured; the purge deletes the tenant's records in every collection of
 * the registry (soft-deleted rows included) and its stored files, leaves
 * other tenants untouched, and stores a zero-count verification report;
 * retained collections are reported with their policy; platform admins see
 * and cancel pending deletions; a live workspace is never purged; every
 * model with tenant data is covered by the purge registry.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import * as emailService from '../../src/services/email.service.js';
import * as storageService from '../../src/services/storage.service.js';
import adminService from '../../src/services/admin.service.js';
import roleService from '../../src/services/role.service.js';
import permissionService from '../../src/services/permission.service.js';
import tenantDeletionService from '../../src/services/tenantDeletion.service.js';
import tenantDeletionRepository from '../../src/repositories/tenantDeletion.repository.js';
import tenantRepository from '../../src/repositories/tenant.repository.js';
import { PURGE_REGISTRY, PURGE_EXEMPT } from '../../src/services/tenantPurge.registry.js';
import { TenantDeletion } from '../../src/models/TenantDeletion.js';
import { Role } from '../../src/models/Role.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { PASSWORD, createWorkspace, addMember, signIn } from './helpers.js';
import tenantPurgeJob from '../../src/jobs/tenantPurge.job.js';
import { runJob, getRegisteredJobs, resetSchedulerForTests } from '../../src/jobs/scheduler.js';
import { JobRun } from '../../src/models/JobRun.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DAY = 24 * 60 * 60 * 1000;

before(async () => {
  // Load every model so the coverage check sees all of them.
  const modelsDir = path.resolve(here, '../../src/models');
  for (const file of (await readdir(modelsDir)).filter((f) => f.endsWith('.js'))) {
    await import(pathToFileURL(path.join(modelsDir, file)).href);
  }
  await startMongo();
  await startHttp();
});
beforeEach(async () => { await resetMongo(); });
after(async () => { await emailService.close(); await storageService.close?.(); await stopHttp(); await stopMongo(); });

/* -------------------------------- fixtures -------------------------------- */

async function seedPlatformAdmin() {
  for (const action of ['view', 'restore']) {
    try { await permissionService.createModule({ key: 'iam' }); } catch { /* exists */ }
    try { await permissionService.createModule({ key: 'iam.tenants' }); } catch { /* exists */ }
    try { await permissionService.createPermission({ module: 'iam.tenants', action }); } catch { /* exists */ }
  }
  const email = `root-${randomBytes(4).toString('hex')}@example.com`;
  const admin = await adminService.create({ email, password: PASSWORD, adminType: 'platform', name: 'Root' });
  const role = await roleService.create({ tenantId: null, name: `root_${randomBytes(4).toString('hex')}` });
  for (const action of ['view', 'restore']) {
    await roleService.addPermission({ roleId: role._id, permissionKey: `iam.tenants.${action}`, by: null });
  }
  await adminService.assignRole({ adminId: admin._id, roleId: role._id, by: null });
  const login = await api('/api/v1/admin-auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return { authorization: `Bearer ${login.json.data.accessToken}` };
}

const rand = () => randomBytes(6).toString('hex');

/** Unique-ish fields so raw seed rows never collide on a unique index. */
function uniques(tenantId = 'seed') {
  return {
    sessionId: `ses_${rand()}`,
    refreshTokenHash: rand(),
    prefix: `pk_${rand()}`,
    tokenHash: rand(),
    reference: `REQ-${rand()}`,
    exportId: `exp_${rand()}`,
    dedupeKey: `dk_${rand()}`,
    grantId: `grant_${rand()}`,
    kind: `tenant.request.${rand()}`,
    subject: `tenant:${tenantId}`,
    bucket: new Date(Date.now() + randomBytes(2).readUInt16BE(0)),
    connectorId: rand(),
    sourceRowId: rand(),
    metric: `m_${rand()}`,
    period: rand(),
    key: `k_${rand()}`,
    providerOrderId: `order_${rand()}`,
    email: `${rand()}@seed.example.com`,
    name: `seed ${rand()}`,
    userId: rand(),
    roleId: rand(),
    adminId: rand(),
    scope: 'tenant',
    invitedEmail: `${rand()}@seed.example.com`,
    status: 'seeded',
  };
}

/**
 * Put at least one raw document for `tenantId` into every collection of
 * the registry (plus a soft-deleted one), and files in its storage prefixes.
 */
async function seedEverything(tenantId) {
  const objectId = new mongoose.Types.ObjectId(tenantId);
  const roles = await Role.collection.find({ tenantId }).toArray();
  for (const entry of PURGE_REGISTRY) {
    const col = entry.model.collection;
    switch (entry.name) {
      case 'Tenant':
      case 'Subscription': // one per tenant, created with the workspace
        break;
      case 'RolePermission':
        await col.insertOne({ roleId: String(roles[0]._id), permissionId: rand() });
        break;
      case 'FeatureFlag':
        await col.insertOne({ key: `flag_${rand()}`, name: 'seed', rollout: { tenantIds: [tenantId, 'someone-else'] }, deletedAt: null });
        break;
      case 'JobLock':
        await col.updateOne({ _id: `tenant-members:${tenantId}` }, { $set: { owner: 'seed' } }, { upsert: true });
        break;
      case 'WebhookEvent':
        await col.insertOne({ provider: 'razorpay', eventId: `evt_${rand()}`, eventType: 'payment.captured', tenantId: objectId });
        break;
      case 'ComplianceLog':
        await col.insertOne({ subjectId: tenantId, subjectType: 'tenant', requestId: `cmp_${rand()}`, type: 'export' });
        break;
      default:
        await col.insertOne({ tenantId, seed: true, ...uniques(tenantId) });
        // A soft-deleted row must be purged too.
        try {
          await col.insertOne({ tenantId, seed: true, deletedAt: new Date(), ...uniques(tenantId) });
        } catch (err) {
          // Some tenant collections intentionally have one-row-per-tenant
          // unique indexes; one raw fixture row is sufficient for coverage.
          if (err?.code !== 11000) throw err;
        }
    }
  }
  await storageService.put(`reports/${tenantId}/r1/run1.csv`, 'a,b\n1,2\n', { contentType: 'text/csv' });
  await storageService.put(`audit/exports/${tenantId}/e1.json`, '{}', { contentType: 'application/json' });
}

async function countFor(entry, ctx) {
  return entry.model.collection.countDocuments(entry.filter(ctx));
}

function ctxFor(tenantId, roleIds = []) {
  return { tenantId, tenantObjectId: new mongoose.Types.ObjectId(tenantId), userIds: [], roleIds };
}

/* --------------------------------- request -------------------------------- */

test('deletion requires the typed slug and the password, then closes the workspace', async () => {
  const ws = await createWorkspace('Doomed');
  const admin = await addMember({ tenantId: ws.tenantId, roleName: 'Admin' });
  const owner = await signIn(ws.tenant, ws.ownerEmail);
  const asAdmin = await signIn(ws.tenant, admin.email);

  const context = await api('/api/v1/workspace/deletion', { headers: owner });
  assert.equal(context.status, 200);
  assert.equal(context.json.data.workspace.slug, ws.tenant.slug);
  assert.equal(context.json.data.graceDays, 30);
  assert.equal(context.json.data.pending, null);
  const contextByAdmin = await api('/api/v1/workspace/deletion', { headers: asAdmin });
  assert.equal(contextByAdmin.status, 403);

  const wrongSlug = await api('/api/v1/workspace/deletion', {
    method: 'POST', headers: owner, body: { confirm: 'not-the-slug', password: PASSWORD },
  });
  assert.equal(wrongSlug.status, 422);
  assert.equal(wrongSlug.json.errors[0].field, 'confirm');

  const wrongPassword = await api('/api/v1/workspace/deletion', {
    method: 'POST', headers: owner, body: { confirm: ws.tenant.slug, password: 'wrong-password' },
  });
  assert.equal(wrongPassword.status, 403);
  assert.equal(wrongPassword.json.code, 'STEP_UP_FAILED');

  const byAdmin = await api('/api/v1/workspace/deletion', {
    method: 'POST', headers: asAdmin, body: { confirm: ws.tenant.slug, password: PASSWORD },
  });
  assert.equal(byAdmin.status, 403, 'only Owners hold workspace.delete');
  assert.equal(await TenantDeletion.countDocuments({ tenantId: ws.tenantId }), 0);

  const sink = [];
  emailService.captureInto(sink);
  const before = Date.now();
  const ok = await api('/api/v1/workspace/deletion', {
    method: 'POST', headers: owner, body: { confirm: ws.tenant.slug.toUpperCase(), password: PASSWORD, reason: 'closing down' },
  });
  emailService.stopCapture();
  assert.equal(ok.status, 202, JSON.stringify(ok.json));
  assert.equal(ok.json.data.status, 'scheduled');
  const purgeAfter = new Date(ok.json.data.purgeAfter).getTime();
  assert.ok(purgeAfter >= before + 30 * DAY - 5000 && purgeAfter <= Date.now() + 30 * DAY + 5000, 'default 30-day grace');

  const tenant = await tenantRepository.findById(ws.tenantId);
  assert.equal(tenant.status, 'disabled');
  const cutOff = await api('/api/v1/users/me', { headers: owner });
  assert.equal(cutOff.status, 401, 'every session is revoked at once');
  const login = await api('/api/v1/auth/login', {
    method: 'POST', headers: { 'X-Tenant-Id': ws.tenant.slug }, body: { email: ws.ownerEmail, password: PASSWORD },
  });
  assert.notEqual(login.status, 200);
  assert.ok(sink.some((m) => m.to === ws.ownerEmail && /scheduled for deletion/.test(m.subject)), 'owners are notified');
  assert.ok(await AuditLog.findOne({ action: 'tenant.deletion_requested', tenantId: ws.tenantId }).lean());
  assert.ok(await AuditLog.findOne({ action: 'tenant.deletion.requested', tenantId: ws.tenantId }).lean(), 'security event');

  // A second request is refused (the record is unique while open).
  await assert.rejects(
    () => tenantDeletionService.requestDeletion({ tenantId: ws.tenantId, by: String(ws.owner._id), confirm: ws.tenant.slug, password: PASSWORD }),
    (err) => err.statusCode === 409,
  );
});

/* ---------------------------------- purge --------------------------------- */

test('the purge honours the grace period, deletes every collection and records a zero-count verification', async () => {
  const doomed = await createWorkspace('Doomed');
  const keeper = await createWorkspace('Keeper');
  await addMember({ tenantId: doomed.tenantId, roleName: 'Viewer' });
  await addMember({ tenantId: keeper.tenantId, roleName: 'Viewer' });
  const now = new Date();
  const deletion = await tenantDeletionService.requestDeletion({
    tenantId: doomed.tenantId, by: String(doomed.owner._id), confirm: doomed.tenant.slug, password: PASSWORD, now,
  });
  const doomedRoleIds = (await Role.collection.find({ tenantId: doomed.tenantId }).toArray()).map((r) => String(r._id));
  const keeperRoleIds = (await Role.collection.find({ tenantId: keeper.tenantId }).toArray()).map((r) => String(r._id));
  await seedEverything(doomed.tenantId);
  await seedEverything(keeper.tenantId);
  // Audit rows exist for both (retained under the audit policy).
  assert.ok(await AuditLog.countDocuments({ tenantId: doomed.tenantId }) > 0);

  // Inside the grace period nothing happens.
  const early = await tenantDeletionService.runDuePurges({ now: new Date(now.getTime() + 29 * DAY) });
  assert.equal(early.claimed, 0);
  assert.ok(await tenantRepository.findById(doomed.tenantId), 'workspace still present during grace');

  const late = await tenantDeletionService.runDuePurges({ now: new Date(new Date(deletion.purgeAfter).getTime() + 60_000) });
  assert.equal(late.claimed, 1);
  assert.equal(late.purged, 1, JSON.stringify(late));

  const record = await tenantDeletionRepository.findById(deletion.id);
  assert.equal(record.status, 'purged');
  assert.equal(record.open, false);
  assert.ok(record.purgedAt);
  assert.equal(record.verification.ok, true);
  const names = record.verification.collections.map((c) => c.name);
  for (const entry of PURGE_REGISTRY.filter((e) => e.mode !== 'retain')) {
    assert.ok(names.includes(entry.name), `${entry.name} is in the verification report`);
  }
  assert.ok(record.verification.collections.every((c) => c.remaining === 0), 'every purged collection counts 0');
  assert.ok(record.verification.collections.find((c) => c.name === 'ConnectorRow').deleted >= 2, 'soft-deleted rows purged too');
  const retainedAudit = record.verification.retained.find((r) => r.name === 'AuditLog');
  assert.ok(retainedAudit.count > 0);
  assert.match(retainedAudit.policy, /audit/);
  assert.equal(record.verification.storage.remaining, 0);
  assert.ok(record.verification.storage.deleted >= 2);

  // Independent recount: nothing of the doomed tenant is left ...
  const doomedCtx = ctxFor(doomed.tenantId, doomedRoleIds);
  for (const entry of PURGE_REGISTRY.filter((e) => e.mode === 'delete' || e.mode === 'detach')) {
    assert.equal(await countFor(entry, doomedCtx), 0, `${entry.name} has no rows of the purged tenant`);
  }
  assert.equal(await tenantRepository.findById(doomed.tenantId), null);
  assert.deepEqual(await storageService.list(`reports/${doomed.tenantId}/`), []);
  // ... and the other tenant is untouched.
  const keeperCtx = ctxFor(keeper.tenantId, keeperRoleIds);
  for (const entry of PURGE_REGISTRY) {
    if (entry.name === 'JobLock') continue;
    assert.ok(await countFor(entry, keeperCtx) > 0, `${entry.name} still holds the other tenant's rows`);
  }
  assert.equal((await storageService.list(`reports/${keeper.tenantId}/`)).length, 1);
  assert.ok(await AuditLog.findOne({ action: 'tenant.purged', tenantId: doomed.tenantId }).lean());

  // The record outlives the tenant; a further run finds nothing to do.
  const again = await tenantDeletionService.runDuePurges({ now: new Date(now.getTime() + 60 * DAY) });
  assert.equal(again.claimed, 0);
});

test('a live workspace is never purged, whatever the record says', async () => {
  const ws = await createWorkspace('Live');
  await tenantDeletionRepository.create({
    tenantId: ws.tenantId, source: 'admin', requestedBy: { type: 'system', id: 'test' },
    requestedAt: new Date(Date.now() - 2 * DAY), purgeAfter: new Date(Date.now() - DAY), previousStatus: 'active',
  });
  const result = await tenantDeletionService.runDuePurges();
  assert.equal(result.failed, 1);
  assert.ok(await tenantRepository.findById(ws.tenantId));
  const record = await tenantDeletionRepository.findOpenByTenant(ws.tenantId);
  assert.equal(record.status, 'failed');
  assert.equal(record.lastError.code, 'TENANT_ACTIVE');
  await assert.rejects(() => tenantDeletionService.purgeTenant({ deletion: { tenantId: 'not-an-id' } }), /Invalid tenant id/);
});

/* ------------------------------ platform admin ----------------------------- */

test('platform admins see and cancel pending deletions; restore is blocked while one is pending', async () => {
  const ws = await createWorkspace('Rescued');
  const adminAuth = await seedPlatformAdmin();
  await tenantDeletionService.requestDeletion({
    tenantId: ws.tenantId, by: String(ws.owner._id), confirm: ws.tenant.slug, password: PASSWORD,
  });

  const list = await api('/api/v1/admin/tenant-deletions?status=scheduled', { headers: adminAuth });
  assert.equal(list.status, 200, JSON.stringify(list.json));
  assert.equal(list.json.data.length, 1);
  assert.equal(list.json.data[0].tenantSlug, ws.tenant.slug);
  assert.equal(list.json.meta.total, 1);

  const detail = await api(`/api/v1/tenants/${ws.tenantId}/deletion`, { headers: adminAuth });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.data.status, 'scheduled');

  const restore = await api(`/api/v1/tenants/${ws.tenantId}/restore`, { method: 'POST', headers: adminAuth, body: { reason: 'oops' } });
  assert.equal(restore.status, 409);
  assert.equal(restore.json.code, 'DELETION_PENDING');

  const noReason = await api(`/api/v1/tenants/${ws.tenantId}/deletion/cancel`, { method: 'POST', headers: adminAuth, body: {} });
  assert.equal(noReason.status, 422);

  const tenantToken = await api('/api/v1/tenants', { headers: { Authorization: 'Bearer nope' } });
  assert.equal(tenantToken.status, 401);

  const cancelled = await api(`/api/v1/tenants/${ws.tenantId}/deletion/cancel`, {
    method: 'POST', headers: adminAuth, body: { reason: 'Owner asked support to keep the workspace' },
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
  assert.equal(cancelled.json.data.status, 'cancelled');
  assert.equal(cancelled.json.data.reopened, true);
  assert.equal((await tenantRepository.findById(ws.tenantId)).status, 'active');
  await signIn(ws.tenant, ws.ownerEmail);
  assert.ok(await AuditLog.findOne({ action: 'tenant.deletion_cancelled', tenantId: ws.tenantId }).lean());

  const again = await api(`/api/v1/tenants/${ws.tenantId}/deletion/cancel`, {
    method: 'POST', headers: adminAuth, body: { reason: 'second time' },
  });
  assert.equal(again.status, 404);

  // A purge that already started cannot be cancelled.
  await tenantDeletionService.requestDeletion({
    tenantId: ws.tenantId, by: String(ws.owner._id), confirm: ws.tenant.slug, password: PASSWORD,
  });
  await TenantDeletion.updateOne({ tenantId: ws.tenantId, open: true }, { $set: { status: 'purging' } });
  const late = await api(`/api/v1/tenants/${ws.tenantId}/deletion/cancel`, {
    method: 'POST', headers: adminAuth, body: { reason: 'too late' },
  });
  assert.equal(late.status, 409);

  // Tenant users never reach the admin surface.
  const other = await createWorkspace('Other');
  const userAuth = await signIn(other.tenant, other.ownerEmail);
  const denied = await api('/api/v1/admin/tenant-deletions', { headers: userAuth });
  assert.equal(denied.status, 401);
});

/* ---------------------------------- job ---------------------------------- */

test('the purge runs as a scheduled job under the scheduler lock and records a JobRun', async () => {
  resetSchedulerForTests();
  const registered = getRegisteredJobs().map((j) => j.name);
  assert.ok(registered.includes('tenant-purge'));
  assert.ok(registered.includes('invitation-expiry'));
  assert.equal(getRegisteredJobs().find((j) => j.name === 'tenant-purge').enabled, false, 'disabled by default');

  const ws = await createWorkspace('Job');
  await tenantDeletionService.requestDeletion({
    tenantId: ws.tenantId, by: String(ws.owner._id), confirm: ws.tenant.slug, password: PASSWORD,
  });
  await TenantDeletion.updateOne({ tenantId: ws.tenantId, open: true }, { $set: { purgeAfter: new Date(Date.now() - 1000) } });
  const run = await runJob(tenantPurgeJob, { trigger: 'manual' });
  assert.equal(run.status, 'succeeded', JSON.stringify(run));
  assert.equal(run.counts.purged, 1);
  const recorded = await JobRun.findById(run.runId).lean();
  assert.equal(recorded.job, 'tenant-purge');
  assert.equal(recorded.status, 'succeeded');
  assert.equal(await tenantRepository.findById(ws.tenantId), null);
});

/* -------------------------------- coverage -------------------------------- */

test('every model that can hold tenant data is covered by the purge registry', () => {
  const covered = new Set(PURGE_REGISTRY.map((e) => e.name));
  const exempt = new Set(Object.keys(PURGE_EXEMPT));
  for (const name of mongoose.modelNames()) {
    const model = mongoose.model(name);
    const hasTenantPath = Boolean(model.schema.path('tenantId'));
    assert.ok(
      covered.has(name) || exempt.has(name),
      `model ${name}${hasTenantPath ? ' (has tenantId)' : ''} must be listed in tenantPurge.registry.js (PURGE_REGISTRY or PURGE_EXEMPT)`,
    );
    // Only the deletion evidence itself may keep a tenantId outside the purge.
    if (hasTenantPath && !covered.has(name)) assert.equal(name, 'TenantDeletion', `${name} has a tenantId path and must be purged or retained explicitly`);
  }
  for (const entry of PURGE_REGISTRY) {
    assert.ok(['delete', 'detach', 'retain'].includes(entry.mode));
    if (entry.mode === 'retain') assert.ok(entry.policy, `${entry.name} names its retention policy`);
  }
});
