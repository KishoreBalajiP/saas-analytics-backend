/**
 * Fixtures for the backups (tenant export / import / restore drill) tests.
 *
 * `seedTenantData` writes at least one realistic document into EVERY
 * exported collection for a tenant (with cross references between them, so
 * id remapping is exercised), plus records in excluded credential
 * collections carrying recognisable secret markers that must never appear
 * in an archive.
 */

import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { api } from '../helpers/http.js';
import { shortToken } from '../../src/utils/id.js';
import { hash } from '../../src/utils/password.js';
import * as tenantService from '../../src/services/tenant.service.js';
import adminService from '../../src/services/admin.service.js';
import roleService from '../../src/services/role.service.js';
import permissionService from '../../src/services/permission.service.js';
import userRepository from '../../src/repositories/user.repository.js';
import roleRepository from '../../src/repositories/role.repository.js';
import { UserRole } from '../../src/models/UserRole.js';
import '../../src/models/ApiKey.js';
import '../../src/models/EmbedToken.js';
import '../../src/models/TenantInvitation.js';

export const PASSWORD = 'Password123!';

/** Secret markers seeded into the tenant; none may appear in an archive. */
export const SECRET_MARKERS = Object.freeze([
  'xoxb-SECRET-SETTING-VALUE',
  'enc:v1:SECRET-CONNECTOR-CIPHERTEXT',
  'whk_SECRETWEBHOOKTOKEN',
  'SECRET-APIKEY-HASH',
  'SECRET-EMBED-HASH',
  'SECRET-INVITE-HASH',
]);

const { ObjectId } = mongoose.Types;

function col(model) {
  return mongoose.model(model).collection;
}

/** Create + initialise a tenant and log its owner in. */
export async function onboard(label = 'Acme') {
  const owner = { email: `owner-${shortToken(10).toLowerCase()}@example.com`, name: 'Owner', password: PASSWORD };
  const { tenant, owner: ownerUser } = await tenantService.create({
    tenant: { name: `${label} ${shortToken(8)}` },
    owner,
    initialize: true,
    by: 'root',
  });
  const tenantId = tenant._id.toString();
  const auth = await loginUser(tenantId, owner.email);
  return { tenantId, tenant, ownerId: String(ownerUser._id), ownerEmail: owner.email, auth };
}

/** Log a tenant user in and return bearer + tenant headers. */
export async function loginUser(tenantId, email) {
  const login = await api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenantId },
    body: { email, password: PASSWORD },
  });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return { authorization: `Bearer ${login.json.data.accessToken}`, 'X-Tenant-Id': tenantId };
}

/** An active member, optionally holding one default role (e.g. 'Admin'). */
export async function member(tenantId, roleName = null) {
  const email = `member-${shortToken(10).toLowerCase()}@example.com`;
  const user = await userRepository.create({ tenantId, email, status: 'active', passwordHash: await hash(PASSWORD), profile: { name: 'Member' } });
  if (roleName) {
    const role = await roleRepository.findByName({ tenantId, name: roleName });
    await new UserRole({ tenantId, userId: String(user._id), roleId: String(role._id), grantedAt: new Date() }).save();
  }
  return loginUser(tenantId, email);
}

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

/** A platform admin holding exactly `keys`, logged in. */
export async function platformAdmin(keys, { tenantScope = null } = {}) {
  const email = `admin-${shortToken(8).toLowerCase()}@example.com`;
  const admin = await adminService.create({ email, password: PASSWORD, adminType: tenantScope ? 'support' : 'platform', name: 'Admin', tenantScope });
  const role = await roleService.create({ tenantId: null, name: `ops_${shortToken(8)}` });
  for (const key of keys) {
    await ensurePermission(key);
    await roleService.addPermission({ roleId: role._id, permissionKey: key, by: null });
  }
  await adminService.assignRole({ adminId: admin._id, roleId: role._id, tenantId: admin.tenantScope ?? null, by: null });
  const login = await api('/api/v1/admin-auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return { admin, email, auth: { authorization: `Bearer ${login.json.data.accessToken}` } };
}

/**
 * Seed every exported collection for `tenantId` (and credential records in
 * excluded collections). Returns the ids it created.
 */
export async function seedTenantData(tenantId, { ownerId, tag = shortToken(6) } = {}) {
  const now = new Date('2026-09-01T10:00:00.000Z');
  const ids = {};

  // Users: an SSO-linked member (globally unique SSO subject).
  ids.ssoUser = new ObjectId();
  await col('User').insertOne({
    _id: ids.ssoUser, tenantId, email: `sso-${tag.toLowerCase()}@example.com`, passwordHash: 'scrypt$SECRET-PASSWORD-HASH',
    ssoProvider: 'google', ssoSubject: `google-sub-${tag}`, status: 'active', profile: { name: 'SSO user' }, createdAt: now, updatedAt: now,
  });

  await col('Setting').insertMany([
    { tenantId, scope: 'tenant', key: `integrations.slack_token_${tag}`, group: 'integrations', type: 'string', value: 'xoxb-SECRET-SETTING-VALUE', isSecret: true, createdAt: now, updatedAt: now },
    { tenantId, scope: 'tenant', key: `branding.title_${tag}`, group: 'branding', type: 'string', value: 'Hello', isSecret: false, createdAt: now, updatedAt: now },
  ]);

  await col('Subscription').insertOne({ tenantId, planId: 'free', state: 'active', currentPeriodStart: now, currentPeriodEnd: new Date('2026-10-01T00:00:00Z'), createdAt: now, updatedAt: now });
  await col('SubscriptionHistory').insertOne({ tenantId, type: 'created', toPlanId: 'free', occurredAt: now });
  await col('PaymentTransaction').insertOne({
    tenantId, planId: 'pro', amountMinor: 49900, currency: 'INR', provider: 'razorpay', providerOrderId: `order_${tag}_${shortToken(8)}`,
    receipt: `rcpt_${tag}`, status: 'captured', createdAt: now, updatedAt: now,
  });
  await col('EntitlementOverride').insertOne({ tenantId, metric: 'connectors', limit: 25, reason: 'support uplift', grantedBy: 'adm_1', revokedAt: null, createdAt: now });
  await col('UsageReservation').insertOne({ tenantId, metric: 'storedRows', key: `webhook:${tag}`, amount: 5, status: 'open', createdAt: now });

  // Connectors: a CSV dataset and a webhook (secret config + capability token).
  ids.connectorA = new ObjectId();
  ids.connectorB = new ObjectId();
  ids.syncRun = new ObjectId();
  await col('Connector').insertMany([
    {
      _id: ids.connectorA, tenantId, type: 'csv', name: `Sales ${tag}`, status: 'active', config: 'enc:v1:SECRET-CONNECTOR-CIPHERTEXT',
      fieldMapping: {}, syncStatus: 'idle', currentSyncRunId: String(ids.syncRun), dataVersion: 3, createdBy: ownerId, createdAt: now, updatedAt: now,
    },
    {
      _id: ids.connectorB, tenantId, type: 'webhook', name: `Events ${tag}`, status: 'active', config: 'enc:v1:SECRET-CONNECTOR-CIPHERTEXT',
      webhookToken: `whk_SECRETWEBHOOKTOKEN${tag}`, webhookSignatureVersion: 2, syncStatus: 'idle', dataVersion: 1, createdAt: now, updatedAt: now,
    },
  ]);
  await col('SyncRun').insertOne({ _id: ids.syncRun, tenantId, connectorId: ids.connectorA, status: 'succeeded', trigger: 'manual', rowsIngested: 3, createdAt: now });
  await col('ConnectorRow').insertMany([
    { tenantId, connectorId: ids.connectorA, sourceRowId: 'r1', data: { region: 'EU', revenue: 10.5, note: '=SUM(A1:A9)', closedAt: now }, ingestedAt: now },
    { tenantId, connectorId: ids.connectorA, sourceRowId: 'r2', data: { region: 'US', revenue: 7, note: 'plain, with "quotes"' }, ingestedAt: now },
    { tenantId, connectorId: ids.connectorA, sourceRowId: 'r3', data: { region: 'APAC', revenue: -2.25, extra: { nested: true } }, ingestedAt: now },
    { tenantId, connectorId: ids.connectorB, sourceRowId: 'e1', data: { event: 'signup', userRef: String(ids.ssoUser) }, ingestedAt: now },
    { tenantId, connectorId: ids.connectorB, sourceRowId: 'e2', data: { event: 'churn' }, ingestedAt: now },
    // A row whose connector no longer exists.
    { tenantId, connectorId: new ObjectId(), sourceRowId: 'orphan', data: { left: 'behind' }, ingestedAt: now },
  ]);

  ids.dashboard = new ObjectId();
  ids.widget = new ObjectId();
  await col('Dashboard').insertOne({
    _id: ids.dashboard, tenantId, name: `Overview ${tag}`, status: 'active', layout: [{ widgetId: String(ids.widget), x: 0, y: 0 }],
    filters: { connectorId: String(ids.connectorA) }, createdBy: ownerId, createdAt: now, updatedAt: now,
  });
  await col('Widget').insertOne({
    _id: ids.widget, tenantId, dashboardId: ids.dashboard, datasetId: ids.connectorA, name: 'Revenue', type: 'kpi',
    query: { connectorIds: [String(ids.connectorA)], metrics: [{ field: 'revenue', op: 'sum' }] }, position: { x: 0, y: 0, w: 4, h: 4 }, createdAt: now,
  });
  ids.report = new ObjectId();
  await col('Report').insertOne({
    _id: ids.report, tenantId, ownerId, name: `Weekly ${tag}`, status: 'active', source: 'widget', dashboardId: String(ids.dashboard), widgetId: String(ids.widget),
    query: { datasetId: String(ids.connectorA) }, runs: [{ _id: new ObjectId(), status: 'succeeded', resultKey: `reports/${tenantId}/${String(ids.report)}.csv`, rowCount: 3 }],
    schedule: { enabled: true, cron: '0 8 * * 1', recipients: [{ type: 'user', value: ownerId }] }, createdAt: now,
  });
  ids.alert = new ObjectId();
  ids.alertEvent = new ObjectId();
  await col('AlertRule').insertOne({ _id: ids.alert, tenantId, name: `Spike ${tag}`, source: 'query', query: { datasetId: String(ids.connectorA) }, condition: 'gt', threshold: 100, enabled: true, createdAt: now });
  await col('AlertEvent').insertOne({ _id: ids.alertEvent, tenantId, alertId: String(ids.alert), triggeredAt: now, value: 142 });
  await col('AnalyticsQuery').insertOne({ tenantId, query: { connectorIds: [String(ids.connectorA)] }, status: 'completed', createdAt: now });
  await col('Notification').insertOne({ tenantId, recipientId: ownerId, type: 'alert', title: 'Spike', payload: { alertEventId: String(ids.alertEvent) }, read: false, createdAt: now });
  await col('AuditLog').insertOne({
    tenantId, actorType: 'user', actorId: ownerId, module: 'dashboards', action: 'create', resourceType: 'dashboard', resourceId: String(ids.dashboard),
    after: { name: `Overview ${tag}` }, result: 'success', occurredAt: now,
  });
  await col('AccessLog').insertOne({ tenantId, actorType: 'user', actorId: ownerId, method: 'GET', path: `/api/v1/dashboards/${String(ids.dashboard)}`, statusCode: 200, occurredAt: now });

  // Excluded credential collections (must never reach an archive).
  await col('ApiKey').insertOne({ tenantId, name: 'CI', prefix: `sak_${shortToken(12)}`, secretHash: 'SECRET-APIKEY-HASH', scopes: ['analytics:read'], status: 'active', createdAt: now });
  await col('EmbedToken').insertOne({ tenantId, dashboardId: ids.dashboard, tokenHash: `SECRET-EMBED-HASH-${shortToken(8)}`, status: 'active', expiresAt: new Date('2030-01-01T00:00:00Z'), createdAt: now });
  await col('TenantInvitation').insertOne({ tenantId, invitedEmail: `invitee-${tag.toLowerCase()}@example.com`, roleId: 'r', roleName: 'Viewer', invitedBy: ownerId, tokenHash: `SECRET-INVITE-HASH-${shortToken(8)}`, status: 'pending', expiresAt: new Date('2030-01-01T00:00:00Z') });

  return ids;
}

/** Poll a workspace export until it finishes. */
export async function waitForExport(path, auth, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await api(path, { headers: auth });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    if (['completed', 'failed', 'expired'].includes(res.json.data.status)) return res.json.data;
    assert.ok(Date.now() < deadline, `export did not finish within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export default { PASSWORD, SECRET_MARKERS, onboard, loginUser, member, platformAdmin, seedTenantData, waitForExport };
