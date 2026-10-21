/**
 * Audit plugin coverage and allow-list payloads (roadmap 2.5; findings
 * gov.02, gov.04, gov.05, db.11).
 *
 *   - findOneAndUpdate (hydrated and lean) records a real before/after diff;
 *   - deleteOne / doc.deleteOne / findOneAndDelete record what was deleted;
 *   - updateMany / updateOne / deleteMany record the filter and counts;
 *   - bookkeeping-only writes and `off` models write no rows;
 *   - payloads keep only allow-listed fields (no hashes, tokens, encrypted
 *     config, raw provider payloads, secret settings) and store dates and
 *     ObjectIds as ISO / hex strings;
 *   - every audited model has a policy entry;
 *   - the auth status cache still hears User/Admin/Tenant changes.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import mongoose from 'mongoose';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { shortToken } from '../../src/utils/id.js';
import { runWithContext } from '../../src/utils/actorContext.js';
import { initAuditConsumer } from '../../src/services/auditConsumer.service.js';
import { AUDIT_POLICY } from '../../src/models/plugins/auditPolicy.js';
import { auditRegistry } from '../../src/models/plugins/audit.js';
import { toAuditValue, isSensitiveKey } from '../../src/utils/auditPayload.js';
import auditLogService from '../../src/services/auditLog.service.js';
import userRepository from '../../src/repositories/user.repository.js';
import sessionRepository from '../../src/repositories/session.repository.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { Role } from '../../src/models/Role.js';
import { RolePermission } from '../../src/models/RolePermission.js';
import { User } from '../../src/models/User.js';
import { Tenant } from '../../src/models/Tenant.js';
import { Session } from '../../src/models/Session.js';
import { ApiKey } from '../../src/models/ApiKey.js';
import { EmbedToken } from '../../src/models/EmbedToken.js';
import { Connector } from '../../src/models/Connector.js';
import { Setting } from '../../src/models/Setting.js';
import WebhookEvent from '../../src/models/WebhookEvent.js';
import { PasswordResetToken } from '../../src/models/PasswordResetToken.js';
import { UsageCounter } from '../../src/models/UsageCounter.js';
import { Admin } from '../../src/models/Admin.js';

const MODELS_DIR = new URL('../../src/models/', import.meta.url);

const ADMIN = { type: 'admin', id: 'adm-plugin', email: 'ops@example.com' };
const TENANT = '64b0000000000000000000aa';

before(async () => {
  // Load every model file so the policy check sees every audited model.
  for (const file of readdirSync(MODELS_DIR).filter((f) => f.endsWith('.js'))) {
    await import(new URL(file, MODELS_DIR).href);
  }
  await startMongo();
  initAuditConsumer();
});
beforeEach(async () => { await resetMongo(); });
after(async () => { await stopMongo(); });

const asAdmin = (fn) => runWithContext({ actor: ADMIN, requestId: `req-${shortToken(8)}` }, fn);

async function waitFor(filter, { timeoutMs = 4000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await AuditLog.findOne(filter).sort({ occurredAt: -1 }).lean();
    if (row) return row;
    assert.ok(Date.now() < deadline, `no audit row matched ${JSON.stringify(filter)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Let fire-and-forget consumer writes land, then count. */
async function settledCount(filter) {
  await new Promise((resolve) => setTimeout(resolve, 150));
  return AuditLog.countDocuments(filter);
}

function platformRole(name) {
  return { tenantId: null, level: 'platform', isSystem: false, name };
}

async function seedUser(overrides = {}) {
  return User.create({
    tenantId: TENANT,
    email: `u-${shortToken(8).toLowerCase()}@example.com`,
    passwordHash: 'hash-value-that-must-never-be-audited',
    status: 'active',
    profile: { name: 'U', phone: '+15550001111' },
    ...overrides,
  });
}

/* ------------------------------ update paths ------------------------------ */

test('a hydrated findOneAndUpdate records the prior state (it used to be dropped)', async () => {
  const role = await asAdmin(() => Role.create(platformRole(`r_${shortToken(8)}`)));
  await asAdmin(async () => { await Role.findOneAndUpdate({ _id: role._id }, { $set: { description: 'changed' } }, { new: true }); });
  const row = await waitFor({ module: 'iam.roles', action: 'update', resourceId: String(role._id) });
  assert.equal(row.before.description, '');
  assert.equal(row.after.description, 'changed');
  assert.deepEqual(row.metadata.changedFields, ['description']);
  assert.equal(row.metadata.operation, 'findOneAndUpdate');
  assert.equal(row.actorId, ADMIN.id);
});

test('a findOneAndUpdate that returns the ORIGINAL document (Mongoose default new:false) still records the change', async () => {
  const role = await asAdmin(() => Role.create(platformRole(`r_${shortToken(8)}`)));
  // No `new` option: Mongoose hands back the pre-update document.
  const returned = await asAdmin(() => Role.findOneAndUpdate({ _id: role._id }, { $set: { description: 'after-default' } }));
  assert.equal(returned.description, '', 'the caller still gets the original document');
  const row = await waitFor({ module: 'iam.roles', action: 'update', resourceId: String(role._id), 'after.description': 'after-default' });
  assert.equal(row.before.description, '');
  assert.deepEqual(row.metadata.changedFields, ['description']);

  // Same with the explicit driver-style option on a lean query.
  await asAdmin(() => Role.findOneAndUpdate(
    { _id: role._id }, { $set: { description: 'lean-before' } }, { returnDocument: 'before', lean: true },
  ));
  const lean = await waitFor({ module: 'iam.roles', action: 'update', resourceId: String(role._id), 'after.description': 'lean-before' });
  assert.equal(lean.before.description, 'after-default');

  // An upsert that inserts (and returns the original, i.e. null) is a create.
  const name = `r_${shortToken(8)}`;
  await asAdmin(() => Role.findOneAndUpdate(
    { tenantId: null, name },
    { $set: { description: 'upserted' }, $setOnInsert: { level: 'platform', isSystem: false } },
    { upsert: true },
  ));
  const created = await waitFor({ module: 'iam.roles', action: 'create', 'after.name': name });
  assert.equal(created.after.description, 'upserted');
});

test('insertMany (which skips save hooks) records one summary row with the count and ids', async () => {
  const roleId = new mongoose.Types.ObjectId();
  const docs = await asAdmin(() => RolePermission.insertMany([
    { roleId, permissionId: new mongoose.Types.ObjectId(), grantedAt: new Date() },
    { roleId, permissionId: new mongoose.Types.ObjectId(), grantedAt: new Date() },
  ]));
  const row = await waitFor({ module: 'iam.roles', action: 'createMany', resourceType: 'rolepermission' });
  assert.equal(row.metadata.operation, 'insertMany');
  assert.equal(row.metadata.insertedCount, 2);
  assert.deepEqual([...row.metadata.ids].sort(), docs.map((d) => String(d._id)).sort());
  assert.equal(row.actorId, ADMIN.id);
  assert.equal(await settledCount({ module: 'iam.roles', action: 'createMany' }), 1);
});

test('a lean user suspend carries before.status; credential and PII fields never appear', async () => {
  const user = await seedUser();
  await asAdmin(() => userRepository.update(String(user._id), { status: 'suspended' }));
  const row = await waitFor({ module: 'iam.users', action: 'update', resourceId: String(user._id) });
  assert.equal(row.before.status, 'active');
  assert.equal(row.after.status, 'suspended');
  assert.equal(row.tenantId, TENANT);

  const create = await waitFor({ module: 'iam.users', action: 'create', resourceId: String(user._id) });
  assert.equal(create.after.passwordHash, undefined, 'passwordHash is not allow-listed');
  assert.equal(create.after.profile.name, 'U');
  assert.equal(create.after.profile.phone, undefined, 'phone is not allow-listed');
  assert.match(create.after.email, /@example\.com$/);
});

test('bookkeeping-only writes (failed attempts, last login, session touch, key last use) write no rows', async () => {
  const user = await seedUser();
  await waitFor({ module: 'iam.users', action: 'create', resourceId: String(user._id) });
  await userRepository.incrementFailedAttempts(String(user._id));
  await userRepository.touchLastLogin(String(user._id));
  const session = await Session.create({
    sessionId: `ses_${shortToken(12)}`, actorId: String(user._id), actorType: 'user', tenantId: TENANT,
    refreshTokenHash: `h_${shortToken(16)}`, expiresAt: new Date(Date.now() + 60_000), status: 'active',
  });
  await sessionRepository.touchLastUsed(session.sessionId);
  const key = await ApiKey.create({
    tenantId: TENANT, name: 'k', prefix: `sak_${shortToken(8)}`, secretHash: 'f'.repeat(64), scopes: ['datasets:read'],
    expiresAt: new Date(Date.now() + 86_400_000), status: 'active',
  });
  await ApiKey.findByIdAndUpdate(key._id, { $set: { lastUsedAt: new Date() } }, { lean: true });

  assert.equal(await settledCount({ module: 'iam.users', action: 'update' }), 0);
  assert.equal(await settledCount({ module: 'iam.sessions' }), 0, 'session create/touch are not model rows');
  assert.equal(await settledCount({ module: 'api_keys', action: 'update' }), 0);
});

test('high-volume models are kept out of the trail (usage counters)', async () => {
  await UsageCounter.findOneAndUpdate(
    { tenantId: TENANT, metric: 'apiCallsPerDay', period: '2026-10-20' },
    { $inc: { value: 1 } },
    { upsert: true, new: true },
  );
  assert.equal(await settledCount({ module: 'iam.usage' }), 0);
});

/* ------------------------------ delete paths ------------------------------ */

test('RolePermission.deleteOne records what was deleted', async () => {
  const roleId = new mongoose.Types.ObjectId();
  const permissionId = new mongoose.Types.ObjectId();
  await RolePermission.create({ roleId, permissionId, grantedBy: 'root', grantedAt: new Date() });
  await asAdmin(async () => { await RolePermission.deleteOne({ roleId, permissionId }); });
  const row = await waitFor({ module: 'iam.roles', resourceType: 'rolepermission', action: 'delete' });
  assert.equal(row.before.roleId, String(roleId), 'ObjectIds are stored as hex strings');
  assert.equal(row.before.permissionId, String(permissionId));
  assert.match(row.before.grantedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(row.metadata.operation, 'deleteOne');
  assert.equal(row.actorId, ADMIN.id);
});

test('findOneAndDelete (findByIdAndDelete) and a query deleteOne record the deleted document once', async () => {
  const role = await Role.create(platformRole(`r_${shortToken(8)}`));
  await asAdmin(async () => { await Role.deleteOne({ _id: role._id }); });
  const row = await waitFor({ module: 'iam.roles', resourceType: 'role', action: 'delete', resourceId: String(role._id) });
  assert.equal(row.before.name, role.name);
  assert.equal(await settledCount({ action: 'delete', resourceId: String(role._id) }), 1, 'no double row');

  const user = await seedUser();
  await asAdmin(async () => { await userRepository.hardDelete(String(user._id)); });
  const gone = await waitFor({ module: 'iam.users', action: 'delete', resourceId: String(user._id) });
  assert.equal(gone.metadata.operation, 'findOneAndDelete');
  assert.equal(gone.before.status, 'active');
  assert.equal(gone.before.passwordHash, undefined);
});

test('deleteMany records the filter and deleted count', async () => {
  const roleId = new mongoose.Types.ObjectId();
  for (let i = 0; i < 3; i += 1) {
    await RolePermission.create({ roleId, permissionId: new mongoose.Types.ObjectId(), grantedAt: new Date() });
  }
  await asAdmin(async () => { await RolePermission.deleteMany({ roleId }); });
  const row = await waitFor({ module: 'iam.roles', action: 'deleteMany' });
  assert.equal(row.metadata.deletedCount, 3);
  assert.deepEqual(JSON.parse(row.metadata.filter), { roleId: String(roleId) });
  assert.equal(row.actorId, ADMIN.id);
});

test('updateMany records the filter, the update and the counts; secrets in filters are redacted', async () => {
  const user = await seedUser();
  for (let i = 0; i < 2; i += 1) {
    await Session.create({
      sessionId: `ses_${shortToken(12)}`, actorId: String(user._id), actorType: 'user', tenantId: TENANT,
      refreshTokenHash: `secret-hash-${i}`, expiresAt: new Date(Date.now() + 60_000), status: 'active',
    });
  }
  const revoked = await asAdmin(() => sessionRepository.revokeAllForActor(String(user._id), 'admin_forced'));
  assert.equal(revoked, 2);
  const row = await waitFor({ module: 'iam.sessions', action: 'updateMany' });
  assert.equal(row.metadata.modifiedCount, 2);
  assert.equal(row.metadata.matchedCount, 2);
  const filter = JSON.parse(row.metadata.filter);
  assert.equal(filter.actorId, String(user._id));
  assert.equal(filter.status, 'active');
  const update = JSON.parse(row.metadata.update);
  assert.equal(update.$set.status, 'revoked');
  assert.equal(update.$set.revokedReason, 'admin_forced');

  // A filter on a credential field never stores the value.
  await Session.updateMany({ refreshTokenHash: 'secret-hash-0' }, { $set: { status: 'expired' } });
  const byHash = await waitFor({ module: 'iam.sessions', action: 'updateMany', 'metadata.filter': /REDACTED/ });
  assert.ok(!JSON.stringify(byHash).includes('secret-hash-0'));

  // Nothing modified -> no row.
  const before = await AuditLog.countDocuments({ module: 'iam.sessions' });
  await Session.updateMany({ actorId: 'nobody' }, { $set: { status: 'revoked' } });
  assert.equal(await settledCount({ module: 'iam.sessions' }), before);
});

test('updateOne without a document is recorded with its filter and counts', async () => {
  const tenant = await Tenant.create({ name: 'Acme', slug: `acme-${shortToken(8).toLowerCase()}`, status: 'active' });
  await asAdmin(async () => { await Tenant.updateOne({ _id: tenant._id }, { $set: { status: 'suspended', suspendedReason: 'billing' } }); });
  const row = await waitFor({ module: 'iam.tenants', action: 'update', resourceId: String(tenant._id), 'metadata.operation': 'updateOne' });
  assert.equal(row.metadata.modifiedCount, 1);
  assert.equal(JSON.parse(row.metadata.update).$set.status, 'suspended');
});

/* ------------------------------- allow-lists ------------------------------ */

test('sensitive model fields are never stored and dates/ObjectIds are serialised', async () => {
  const dashboardId = new mongoose.Types.ObjectId();
  const expiresAt = new Date(Date.now() + 3_600_000);
  const key = await ApiKey.create({
    tenantId: TENANT, name: 'ci', prefix: `sak_${shortToken(8)}`, secretHash: 'a'.repeat(64), scopes: ['datasets:read'],
    expiresAt, status: 'active',
  });
  const embed = await EmbedToken.create({
    tenantId: TENANT, dashboardId, name: 'e', tokenHash: 'b'.repeat(64), status: 'active', expiresAt,
  });
  const connector = await Connector.create({
    tenantId: TENANT, type: 'webhook', name: 'hook', config: `enc:v1:${'c'.repeat(16)}`, webhookToken: 'wh_token_value_123456',
  });
  const reset = await PasswordResetToken.create({ portal: 'user', actorId: 'u1', tenantId: TENANT, tokenHash: 'd'.repeat(64), expiresAt });
  const hook = await WebhookEvent.create({ provider: 'razorpay', eventId: `evt_${shortToken(8)}`, eventType: 'payment.captured', raw: { email: 'payer@example.com', contact: '+15550002222' } });
  const setting = await Setting.create({ key: `smtp.password.${shortToken(8).toLowerCase()}`, scope: 'platform', group: 'mail', type: 'string', value: 'super-secret-value', isSecret: true });

  const keyRow = await waitFor({ module: 'api_keys', action: 'create', resourceId: String(key._id) });
  assert.equal(keyRow.after.secretHash, undefined);
  assert.equal(keyRow.after.expiresAt, expiresAt.toISOString(), 'dates are ISO strings, not {}');
  assert.deepEqual(keyRow.after.scopes, ['datasets:read']);

  const embedRow = await waitFor({ module: 'embed', action: 'create', resourceId: String(embed._id) });
  assert.equal(embedRow.after.dashboardId, String(dashboardId), 'ObjectIds are hex strings, not byte maps');
  assert.equal(embedRow.after.tokenHash, undefined);

  const connectorRow = await waitFor({ module: 'connectors', action: 'create', resourceId: String(connector._id) });
  assert.equal(connectorRow.after.config, undefined);
  assert.equal(connectorRow.after.webhookToken, undefined);
  assert.equal(connectorRow.after.name, 'hook');

  const resetRow = await waitFor({ module: 'iam.password_resets', action: 'create', resourceId: String(reset._id) });
  assert.equal(resetRow.after.tokenHash, undefined);

  const hookRow = await waitFor({ module: 'billing.webhooks', action: 'create', resourceId: String(hook._id) });
  assert.equal(hookRow.after.raw, undefined, 'raw provider payloads are not duplicated');

  const settingRow = await waitFor({ module: 'platform.settings', action: 'create', resourceId: String(setting._id) });
  assert.equal(settingRow.after.value, '[REDACTED]', 'secret settings are redacted');

  const text = JSON.stringify(await AuditLog.find({}).lean());
  for (const secret of ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(16), 'wh_token_value_123456', 'd'.repeat(64), 'payer@example.com', 'super-secret-value']) {
    assert.ok(!text.includes(secret), `secret stored in the trail: ${secret.slice(0, 8)}`);
  }
});

test('a password change is visible as a changed field name without its value', async () => {
  const user = await seedUser();
  await asAdmin(() => userRepository.update(String(user._id), { passwordHash: 'new-hash-value-xyz' }));
  const row = await waitFor({ module: 'iam.users', action: 'update', resourceId: String(user._id) });
  assert.deepEqual(row.metadata.changedFields, ['passwordHash']);
  assert.deepEqual(row.before, {});
  assert.deepEqual(row.after, {});
  assert.ok(!JSON.stringify(row).includes('new-hash-value-xyz'));
});

test('service-level payloads: dates, ObjectIds, nested secrets', async () => {
  const id = new mongoose.Types.ObjectId();
  const at = new Date('2026-10-20T10:00:00.000Z');
  const row = await auditLogService.emit({
    actor: { type: 'service', id: 'svc' },
    action: 'demo',
    module: 'demo',
    after: { at, ref: id, nested: { apiKey: 'k', clientSecret: 's', tokenHash: 'h', tokenId: 'keep-me' }, list: [at] },
  });
  assert.equal(row.after.at, '2026-10-20T10:00:00.000Z');
  assert.equal(row.after.ref, String(id));
  assert.deepEqual(row.after.list, ['2026-10-20T10:00:00.000Z']);
  assert.equal(row.after.nested.apiKey, '[REDACTED]');
  assert.equal(row.after.nested.clientSecret, '[REDACTED]');
  assert.equal(row.after.nested.tokenHash, '[REDACTED]');
  assert.equal(row.after.nested.tokenId, 'keep-me', 'identifiers are not secrets');

  assert.equal(toAuditValue(new Date('invalid')), null);
  assert.equal(toAuditValue(Number.NaN), null);
  assert.ok(isSensitiveKey('refreshTokenHash') && isSensitiveKey('Authorization') && !isSensitiveKey('apiKeyId'));
});

test('every audited model declares an audit policy', async () => {
  const emitters = new Set(auditRegistry.map((entry) => entry.emitter));
  const audited = Object.values(mongoose.models).filter((m) => emitters.has(m.events)).map((m) => m.modelName);
  assert.ok(audited.length >= 30, `expected the audited models to be loaded, got ${audited.length}`);
  const missing = audited.filter((name) => !AUDIT_POLICY[name]);
  assert.deepEqual(missing, [], 'add these models to models/plugins/auditPolicy.js');
  assert.ok(auditRegistry.length >= audited.length);
});

/* ------------------------- auth status cache events ------------------------ */

test('User/Admin changes still reach the auth status cache (create, update, delete, bulk)', async () => {
  const seen = [];
  const listener = (name) => (payload) => seen.push(`${name}:${payload.modelName}`);
  const listeners = ['update', 'delete', 'bulkUpdate'].map((name) => [name, listener(name)]);
  for (const [name, fn] of listeners) User.events.on(name, fn);
  try {
    const user = await seedUser();
    await userRepository.incrementFailedAttempts(String(user._id));
    await User.updateMany({ tenantId: TENANT }, { $set: { status: 'suspended' } });
    await User.findByIdAndDelete(user._id);
    assert.ok(seen.includes('update:User'), 'bookkeeping updates are still emitted (only the trail skips them)');
    assert.ok(seen.includes('bulkUpdate:User'));
    assert.ok(seen.includes('delete:User'));
  } finally {
    for (const [name, fn] of listeners) User.events.off(name, fn);
  }
  // The admin model keeps emitting too.
  const admin = await Admin.create({ email: `a-${shortToken(8).toLowerCase()}@example.com`, passwordHash: 'x', adminType: 'platform', status: 'active' });
  const updates = [];
  const onUpdate = (payload) => updates.push(String(payload.doc?._id));
  Admin.events.on('update', onUpdate);
  try {
    await Admin.findByIdAndUpdate(admin._id, { $set: { status: 'suspended' } }, { lean: true });
    assert.deepEqual(updates, [String(admin._id)]);
  } finally {
    Admin.events.off('update', onUpdate);
  }
});
