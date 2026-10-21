/**
 * Platform settings over HTTP (roadmap 2.4, ADM:config-501):
 * GET/PUT /api/v1/settings, history, rollback, reset and the secret
 * settings permission. Exit criteria covered here: each endpoint enforces
 * its permission; validation rejects bad values per key; history and
 * rollback restore exact prior values; secret values are masked without
 * the secrets permission and never logged or audited in plaintext.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import * as settingService from '../../src/services/setting.service.js';
import * as tenantSettings from '../../src/services/tenantSettings.service.js';
import { Setting } from '../../src/models/Setting.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { ConfigRevision } from '../../src/models/ConfigRevision.js';
import { run as encryptSecretsScript } from '../../scripts/ci/encrypt-setting-secrets.js';
import { adminWith, onboardTenant, captureLogs } from './helpers.js';

const VIEW = 'settings.view';
const UPDATE = 'settings.update';
const SECRETS_VIEW = 'settings.secrets.view';
const SECRETS_UPDATE = 'settings.secrets.update';
const SECRET = 'Sm7p-Pa55word!unique-4c1d';

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => { await resetMongo(); await rbacCache.clearAll(); await cacheService.flushAll(); });
after(async () => { await stopHttp(); await stopMongo(); });

const put = (key, headers, body) => api(`/api/v1/settings/${key}`, { method: 'PUT', headers, body });

test('no platform setting endpoint answers 501 any more, and every one needs a platform admin', async () => {
  const { headers: tenantHeaders } = await onboardTenant();
  const routes = [
    ['GET', '/api/v1/settings'],
    ['GET', '/api/v1/settings/branding.primary_color'],
    ['PUT', '/api/v1/settings/branding.primary_color'],
    ['POST', '/api/v1/settings/branding.primary_color/reset'],
    ['GET', '/api/v1/settings/branding.primary_color/history'],
    ['POST', '/api/v1/settings/branding.primary_color/rollback'],
    ['GET', '/api/v1/settings/email.smtp_password/secret'],
  ];
  for (const [method, path] of routes) {
    const anonymous = await api(path, { method, body: method === 'GET' ? undefined : {} });
    assert.equal(anonymous.status, 401, `${method} ${path} without a token`);
    const tenantUser = await api(path, { method, headers: tenantHeaders, body: method === 'GET' ? undefined : {} });
    assert.equal(tenantUser.status, 401, `${method} ${path} with a workspace token`);
  }
});

test('each endpoint enforces its permission (view / update / secrets)', async () => {
  const nobody = await adminWith([]);
  const viewer = await adminWith([VIEW]);
  const editor = await adminWith([VIEW, UPDATE]);

  assert.equal((await api('/api/v1/settings', { headers: nobody.headers })).status, 403);
  assert.equal((await api('/api/v1/settings/branding.primary_color', { headers: nobody.headers })).status, 403);
  assert.equal((await api('/api/v1/settings/branding.primary_color/history', { headers: nobody.headers })).status, 403);

  assert.equal((await api('/api/v1/settings', { headers: viewer.headers })).status, 200);
  assert.equal((await put('branding.primary_color', viewer.headers, { value: '#111111' })).status, 403);
  assert.equal((await api('/api/v1/settings/branding.primary_color/reset', { method: 'POST', headers: viewer.headers, body: {} })).status, 403);
  assert.equal((await api('/api/v1/settings/branding.primary_color/rollback', { method: 'POST', headers: viewer.headers, body: { toVersion: 0 } })).status, 403);

  // settings.update alone cannot write or read a secret.
  const secretWrite = await put('email.smtp_password', editor.headers, { value: SECRET });
  assert.equal(secretWrite.status, 403);
  assert.equal(secretWrite.json.code, 'SECRET_PERMISSION_REQUIRED');
  assert.equal((await api('/api/v1/settings/email.smtp_password/secret', { headers: editor.headers })).status, 403);
  assert.equal((await put('branding.primary_color', editor.headers, { value: '#111111' })).status, 200);
});

test('a tenant-scoped admin cannot reach platform settings even with the permissions', async () => {
  const { tenantId } = await onboardTenant();
  const scoped = await adminWith([VIEW, UPDATE, SECRETS_VIEW], { tenantScope: tenantId });
  const list = await api('/api/v1/settings', { headers: scoped.headers });
  assert.equal(list.status, 403);
  assert.equal(list.json.code, 'ADMIN_SCOPE_DENIED');
  assert.equal((await put('branding.primary_color', scoped.headers, { value: '#111111' })).status, 403);
});

test('list and get return the catalogue with defaults, masked secrets and versions', async () => {
  const { headers } = await adminWith([VIEW]);
  const list = await api('/api/v1/settings', { headers });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.json.data));
  assert.equal(list.json.meta.total, list.json.data.length);
  assert.ok(list.json.meta.groups.includes('email'));
  const color = list.json.data.find((s) => s.key === 'branding.primary_color');
  assert.equal(color.value, '#2563eb');
  assert.equal(color.source, 'default');
  assert.equal(color.version, 0);
  const secret = list.json.data.find((s) => s.key === 'email.smtp_password');
  assert.equal(secret.isSecret, true);
  assert.equal(secret.value, null);
  assert.equal(secret.redacted, true);

  const grouped = await api('/api/v1/settings?group=branding', { headers });
  assert.ok(grouped.json.data.every((s) => s.group === 'branding'));
  assert.equal((await api('/api/v1/settings?group=nope', { headers })).status, 422);
  const missing = await api('/api/v1/settings/branding.nope', { headers });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, 'SETTING_NOT_FOUND');
  assert.equal((await api('/api/v1/settings/BAD KEY', { headers })).status, 422);
});

test('validation rejects bad values per key with a field error and stores nothing', async () => {
  const { headers } = await adminWith([VIEW, UPDATE]);
  const cases = [
    ['general.contact_email', 'not-an-email'],
    ['branding.primary_color', 'blue'],
    ['branding.logo_url', 'http://insecure.example.com/logo.png'],
    ['localization.timezone', 'Mars/Olympus'],
    ['localization.currency', 'XYZW'],
    ['localization.date_format', 'DD-DD-YYYY'],
    ['email.smtp_port', 70000],
    ['email.smtp_port', 'abc'],
    ['email.from_name', ''],
    ['email.from_address', 'nobody'],
    ['security.session_ttl', 10],
    ['security.mfa_required', 'maybe'],
    ['general.maintenance_notice', 'x'.repeat(501)],
  ];
  for (const [key, value] of cases) {
    const res = await put(key, headers, { value });
    assert.equal(res.status, 400, `${key}=${JSON.stringify(value)} -> ${res.status} ${JSON.stringify(res.json)}`);
    assert.ok(res.json.errors.some((e) => e.field === key), `${key} carries a field error`);
  }
  const noValue = await put('branding.primary_color', headers, {});
  assert.equal(noValue.status, 400);
  assert.ok(noValue.json.errors.some((e) => e.field === 'value'));

  const readOnly = await put('security.password_min_length', headers, { value: 12 });
  assert.equal(readOnly.status, 403);
  assert.equal(readOnly.json.code, 'SETTING_READ_ONLY');
  assert.equal(await Setting.countDocuments({ scope: 'platform', version: { $gt: 0 } }), 0, 'nothing was stored');

  // Valid values are normalised before they are stored.
  const ok = await put('localization.currency', headers, { value: 'eur' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.data.value, 'EUR');
  const port = await put('email.smtp_port', headers, { value: '2525' });
  assert.equal(port.json.data.value, 2525);
  const cleared = await put('general.contact_email', headers, { value: '' });
  assert.equal(cleared.status, 200, 'an optional setting can be cleared');
  assert.equal(cleared.json.data.value, '');
});

test('history and rollback restore exact prior values; stale versions conflict; all audited', async () => {
  const { headers, admin } = await adminWith([VIEW, UPDATE]);
  const v1 = await put('branding.primary_color', headers, { value: '#111111', reason: 'rebrand' });
  assert.equal(v1.status, 200);
  assert.equal(v1.json.data.version, 1);
  assert.equal(v1.json.data.source, 'platform');
  const v2 = await put('branding.primary_color', headers, { value: '#222222', version: 1 });
  assert.equal(v2.json.data.version, 2);

  const stale = await put('branding.primary_color', headers, { value: '#333333', version: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'VERSION_CONFLICT');

  const history = await api('/api/v1/settings/branding.primary_color/history', { headers });
  assert.equal(history.status, 200);
  assert.deepEqual(history.json.data.map((r) => r.version), [2, 1, 0]);
  assert.deepEqual(history.json.data.map((r) => r.state.value), ['#222222', '#111111', '#2563eb']);
  assert.equal(history.json.data[2].action, 'baseline');
  assert.equal(history.json.data[1].reason, 'rebrand');
  assert.equal(history.json.data[0].changedBy.id, String(admin._id));
  assert.equal(history.json.meta.total, 3);

  const back = await api('/api/v1/settings/branding.primary_color/rollback', { method: 'POST', headers, body: { toVersion: 0, version: 2 } });
  assert.equal(back.status, 200, JSON.stringify(back.json));
  assert.equal(back.json.data.value, '#2563eb');
  assert.equal(back.json.data.version, 3);
  const forward = await api('/api/v1/settings/branding.primary_color/rollback', { method: 'POST', headers, body: { toVersion: 1 } });
  assert.equal(forward.json.data.value, '#111111');
  const latest = (await api('/api/v1/settings/branding.primary_color/history?limit=1', { headers })).json.data[0];
  assert.equal(latest.action, 'rollback');
  assert.equal(latest.rolledBackFrom, 1);

  const unknownVersion = await api('/api/v1/settings/branding.primary_color/rollback', { method: 'POST', headers, body: { toVersion: 99 } });
  assert.equal(unknownVersion.status, 404);
  assert.equal(unknownVersion.json.code, 'REVISION_NOT_FOUND');

  const reset = await api('/api/v1/settings/branding.primary_color/reset', { method: 'POST', headers, body: {} });
  assert.equal(reset.json.data.value, '#2563eb');

  const audits = await AuditLog.find({ module: 'platform.settings', action: /^platform_setting\./ }).sort({ _id: 1 }).lean();
  assert.deepEqual(audits.map((a) => a.action), [
    'platform_setting.updated', 'platform_setting.updated', 'platform_setting.rolled_back',
    'platform_setting.rolled_back', 'platform_setting.reset',
  ]);
  assert.deepEqual(audits[0].before, { value: '#2563eb', version: 0 });
  assert.deepEqual(audits[0].after, { value: '#111111', version: 1 });
  assert.equal(audits[0].actorId, String(admin._id));
  assert.equal(audits[0].reason, 'rebrand');
});

test('tenants inherit a platform change unless they override it; onboarding never resets it', async () => {
  const { headers } = await adminWith([VIEW, UPDATE]);
  const a = await onboardTenant();
  const b = await onboardTenant();
  await tenantSettings.updateGroup({ tenantId: b.tenantId, group: 'branding', values: { 'branding.primary_color': '#abcdef' } });

  await put('branding.primary_color', headers, { value: '#123456' });
  assert.equal(await settingService.resolveEffective('branding.primary_color', { tenantId: a.tenantId }), '#123456');
  assert.equal(await settingService.resolveEffective('branding.primary_color', { tenantId: b.tenantId }), '#abcdef');

  // A later onboarding re-seeds missing rows only.
  await tenantSettings.initialize({ by: 'system' });
  await onboardTenant();
  const stored = await api('/api/v1/settings/branding.primary_color', { headers });
  assert.equal(stored.json.data.value, '#123456');
});

test('secret settings: encrypted at rest, masked, revealed only with settings.secrets.view, never logged or audited in plaintext', async () => {
  const writer = await adminWith([VIEW, UPDATE, SECRETS_UPDATE]);
  const reader = await adminWith([VIEW, SECRETS_VIEW]);
  const plain = await adminWith([VIEW]);

  const logs = await captureLogs(async () => {
    const saved = await put('email.smtp_password', writer.headers, { value: SECRET, reason: 'rotate relay' });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(saved.json.data.value, null);
    assert.equal(saved.json.data.redacted, true);
    assert.equal(saved.json.data.hasValue, true);
    assert.equal(saved.json.data.version, 1);

    // Writers without settings.secrets.view still cannot read it back.
    assert.equal((await api('/api/v1/settings/email.smtp_password/secret', { headers: writer.headers })).status, 403);

    const masked = await api('/api/v1/settings/email.smtp_password', { headers: plain.headers });
    assert.equal(masked.json.data.value, null);
    assert.equal(masked.json.data.redacted, true);
    const list = await api('/api/v1/settings?group=email', { headers: plain.headers });
    assert.ok(!JSON.stringify(list.json).includes(SECRET));

    const revealed = await api('/api/v1/settings/email.smtp_password/secret', { headers: reader.headers });
    assert.equal(revealed.status, 200);
    assert.equal(revealed.json.data.value, SECRET);
    assert.match(revealed.headers.get('cache-control') ?? '', /no-store/);

    const history = await api('/api/v1/settings/email.smtp_password/history', { headers: plain.headers });
    assert.ok(!JSON.stringify(history.json).includes(SECRET));
    assert.equal(history.json.data[0].state.value, null);
    assert.equal(history.json.data[0].hasSecretValue, true);

    const notSecret = await api('/api/v1/settings/branding.primary_color/secret', { headers: reader.headers });
    assert.equal(notSecret.status, 400);
    assert.equal(notSecret.json.code, 'SETTING_NOT_SECRET');
  });
  assert.ok(!logs.includes(SECRET), 'the secret never reaches the logs');

  const row = await Setting.findOne({ key: 'email.smtp_password', scope: 'platform' }).lean();
  assert.equal(row.value, '');
  assert.ok(row.secret && !row.secret.includes(SECRET), 'stored encrypted');
  const audits = await AuditLog.find({}).lean();
  assert.ok(!JSON.stringify(audits).includes(SECRET), 'no audit row holds the plaintext');
  assert.ok(audits.some((a) => a.action === 'platform_setting.updated' && a.after?.value === '[REDACTED]'));
  const reveal = audits.find((a) => a.action === 'platform_setting.secret_revealed');
  assert.ok(reveal, 'the reveal is audited');
  assert.equal(reveal.actorId, String(reader.admin._id));
  const revisions = await ConfigRevision.find({ resourceKey: 'platform:email.smtp_password' }).lean();
  assert.ok(!JSON.stringify(revisions).includes(SECRET), 'the history holds only the envelope');

  // The hot path decrypts for code that needs it.
  const { tenantId } = await onboardTenant();
  assert.equal(await settingService.resolveEffective('email.smtp_password', { tenantId }), SECRET);
});

test('rolling a secret back restores the exact prior secret; reset clears it', async () => {
  const admin = await adminWith([VIEW, UPDATE, SECRETS_UPDATE, SECRETS_VIEW]);
  await put('email.smtp_password', admin.headers, { value: 'first-secret' });
  await put('email.smtp_password', admin.headers, { value: 'second-secret' });
  const reveal = async () => (await api('/api/v1/settings/email.smtp_password/secret', { headers: admin.headers })).json.data;
  assert.equal((await reveal()).value, 'second-secret');

  const rolled = await api('/api/v1/settings/email.smtp_password/rollback', { method: 'POST', headers: admin.headers, body: { toVersion: 1 } });
  assert.equal(rolled.status, 200);
  assert.equal(rolled.json.data.value, null, 'the rollback response stays masked');
  assert.equal((await reveal()).value, 'first-secret');

  const toEmpty = await api('/api/v1/settings/email.smtp_password/rollback', { method: 'POST', headers: admin.headers, body: { toVersion: 0 } });
  assert.equal(toEmpty.json.data.hasValue, false);
  assert.equal((await reveal()).value, '');

  await put('email.smtp_password', admin.headers, { value: 'third-secret' });
  const reset = await api('/api/v1/settings/email.smtp_password/reset', { method: 'POST', headers: admin.headers, body: {} });
  assert.equal(reset.json.data.hasValue, false);

  // Without settings.secrets.update, a rollback of a secret is refused too.
  const noSecrets = await adminWith([VIEW, UPDATE]);
  const refused = await api('/api/v1/settings/email.smtp_password/rollback', { method: 'POST', headers: noSecrets.headers, body: { toVersion: 1 } });
  assert.equal(refused.status, 403);
});

test('legacy plaintext secrets are encrypted by the dry-run-by-default migration', async () => {
  // Written as the old code stored it (raw insert: no hooks, no new audit row).
  await Setting.collection.insertOne({
    key: 'email.smtp_password', scope: 'platform', tenantId: null, type: 'string', value: 'legacy-plain',
    isSecret: true, group: 'email', description: '', isReadonly: false, version: 0, deletedAt: null,
    createdAt: new Date(), updatedAt: new Date(),
  });
  // Still readable before the migration (fallback), never in plaintext over HTTP.
  const row = await Setting.findOne({ key: 'email.smtp_password' }).lean();
  assert.equal(await settingService.openSecretValue(row), 'legacy-plain');

  // A row-level audit entry written before encryption at rest (counted, never changed).
  await AuditLog.create({
    actorType: 'system', module: 'platform.settings', action: 'create', resourceType: 'setting',
    after: { key: 'email.smtp_password', isSecret: true, value: 'legacy-plain' },
  });
  const lines = [];
  const dry = await encryptSecretsScript({ apply: false, log: (l) => lines.push(l) });
  assert.deepEqual(dry, { candidates: 1, encrypted: 0, dryRun: true, auditRows: 1 });
  assert.ok(lines.some((l) => /1 audit row/.test(l)));
  assert.equal((await Setting.findOne({ key: 'email.smtp_password' }).lean()).value, 'legacy-plain', 'dry run writes nothing');
  assert.ok(!lines.join('\n').includes('legacy-plain'));

  const applied = await encryptSecretsScript({ apply: true, log: () => {} });
  assert.deepEqual(applied, { candidates: 1, encrypted: 1, dryRun: false, auditRows: 1 });
  assert.equal(await AuditLog.countDocuments({ 'after.value': 'legacy-plain' }), 1, 'the audit trail is not modified');
  const migrated = await Setting.findOne({ key: 'email.smtp_password' }).lean();
  assert.equal(migrated.value, '');
  assert.ok(migrated.secret);
  assert.equal(await settingService.openSecretValue(migrated), 'legacy-plain');
  assert.equal((await encryptSecretsScript({ apply: true, log: () => {} })).candidates, 0);
});

test('concurrent writers at the same version: exactly one wins, the other gets 409', async () => {
  const { headers } = await adminWith([VIEW, UPDATE]);
  await put('branding.accent_color', headers, { value: '#000001' });
  const results = await Promise.all([
    put('branding.accent_color', headers, { value: '#aaaaaa', version: 1 }),
    put('branding.accent_color', headers, { value: '#bbbbbb', version: 1 }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const history = await api('/api/v1/settings/branding.accent_color/history', { headers });
  assert.deepEqual(history.json.data.map((r) => r.version), [2, 1, 0], 'one revision per version');
  const winner = results.find((r) => r.status === 200).json.data.value;
  assert.equal(history.json.data[0].state.value, winner);
});
