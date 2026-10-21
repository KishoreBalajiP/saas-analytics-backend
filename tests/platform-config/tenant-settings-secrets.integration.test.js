/**
 * Tenant secret settings (roadmap 2.4, ADM:secrets / adm.14):
 * `GET /tenants/:id/settings?includeSecrets=true` needs the dedicated
 * `settings.secrets.view` permission and is audited; writing a secret
 * override needs `settings.secrets.update`; secrets are encrypted at rest,
 * never echoed back after a write, and validated per key like any value.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import * as settingService from '../../src/services/setting.service.js';
import { Setting } from '../../src/models/Setting.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { adminWith, onboardTenant, stepUp } from './helpers.js';

const SECRET = 'tenant-relay-pass-9f2e';

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => { await resetMongo(); await rbacCache.clearAll(); await cacheService.flushAll(); });
after(async () => { await stopHttp(); await stopMongo(); });

const patchSettings = (tenantId, headers, values) => api(`/api/v1/tenants/${tenantId}/settings`, {
  method: 'PATCH', headers, body: { group: 'email', values },
});

test('iam.tenants.view alone reads masked secrets and cannot ask for plaintext', async () => {
  const { tenantId } = await onboardTenant();
  const configurer = await adminWith(['iam.tenants.configure', 'settings.secrets.update']);
  assert.equal((await patchSettings(tenantId, configurer.headers, { 'email.smtp_password': SECRET })).status, 200);

  const viewer = await adminWith(['iam.tenants.view']);
  const masked = await api(`/api/v1/tenants/${tenantId}/settings?group=email`, { headers: viewer.headers });
  assert.equal(masked.status, 200);
  const secret = masked.json.data.find((s) => s.key === 'email.smtp_password');
  assert.equal(secret.value, null);
  assert.equal(secret.redacted, true);
  assert.equal(secret.hasValue, true);
  assert.ok(!JSON.stringify(masked.json).includes(SECRET));

  const plaintext = await api(`/api/v1/tenants/${tenantId}/settings?group=email&includeSecrets=true`, { headers: viewer.headers });
  assert.equal(plaintext.status, 403);
  // The old gate (iam.tenants.configure) is no longer enough either.
  const configureOnly = await adminWith(['iam.tenants.view', 'iam.tenants.configure']);
  assert.equal((await api(`/api/v1/tenants/${tenantId}/settings?includeSecrets=1`, { headers: configureOnly.headers })).status, 403);
});

test('settings.secrets.view reveals the plaintext and the read is audited without the value', async () => {
  const { tenantId } = await onboardTenant();
  const configurer = await adminWith(['iam.tenants.configure', 'settings.secrets.update']);
  await patchSettings(tenantId, configurer.headers, { 'email.smtp_password': SECRET });

  const reader = await adminWith(['iam.tenants.view', 'settings.secrets.view']);
  await stepUp(reader.headers);
  const res = await api(`/api/v1/tenants/${tenantId}/settings?group=email&includeSecrets=true`, { headers: reader.headers });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.find((s) => s.key === 'email.smtp_password').value, SECRET);

  const audit = await AuditLog.findOne({ action: 'tenant_settings.secrets_revealed' }).lean();
  assert.ok(audit, 'secret read audited');
  assert.equal(audit.tenantId, tenantId);
  assert.equal(audit.actorId, String(reader.admin._id));
  assert.deepEqual(audit.after, { group: 'email', keys: ['email.smtp_password'] });
  const all = await AuditLog.find({}).lean();
  assert.ok(!JSON.stringify(all).includes(SECRET), 'no audit row holds the plaintext');
});

test('writing a secret override needs settings.secrets.update; plain keys do not', async () => {
  const { tenantId } = await onboardTenant();
  const configurer = await adminWith(['iam.tenants.configure']);
  const refused = await patchSettings(tenantId, configurer.headers, { 'email.smtp_password': SECRET, 'email.from_name': 'X' });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.code, 'SECRET_PERMISSION_REQUIRED');
  assert.ok(refused.json.errors.some((e) => e.field === 'values.email.smtp_password'));
  assert.equal(await Setting.countDocuments({ scope: 'tenant', tenantId }), 0, 'nothing written');

  const plain = await patchSettings(tenantId, configurer.headers, { 'email.from_name': 'Acme Mail' });
  assert.equal(plain.status, 200);

  const secretWriter = await adminWith(['iam.tenants.configure', 'settings.secrets.update']);
  const saved = await patchSettings(tenantId, secretWriter.headers, { 'email.smtp_password': SECRET });
  assert.equal(saved.status, 200);
  const echoed = saved.json.data.find((s) => s.key === 'email.smtp_password');
  assert.equal(echoed.value, null, 'a write never echoes the secret back');
  const row = await Setting.findOne({ scope: 'tenant', tenantId, key: 'email.smtp_password' }).lean();
  assert.equal(row.value, '');
  assert.ok(row.secret && !row.secret.includes(SECRET), 'encrypted at rest');
  assert.equal(await settingService.resolveEffective('email.smtp_password', { tenantId }), SECRET);
});

test('tenant overrides are validated per key', async () => {
  const { tenantId } = await onboardTenant();
  const configurer = await adminWith(['iam.tenants.configure']);
  const badPort = await patchSettings(tenantId, configurer.headers, { 'email.smtp_port': 'abc' });
  assert.equal(badPort.status, 400);
  assert.ok(badPort.json.errors.some((e) => e.field === 'email.smtp_port'));
  const badAddress = await patchSettings(tenantId, configurer.headers, { 'email.from_address': 'nope' });
  assert.equal(badAddress.status, 400);
  const badColor = await api(`/api/v1/tenants/${tenantId}/settings`, {
    method: 'PATCH', headers: configurer.headers, body: { group: 'branding', values: { 'branding.primary_color': 'red' } },
  });
  assert.equal(badColor.status, 400);
  assert.ok(badColor.json.errors.some((e) => e.field === 'branding.primary_color'));
});
