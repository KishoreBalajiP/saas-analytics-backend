/**
 * Feature flags over HTTP (roadmap 2.4, ADM:config-501): admin CRUD with
 * validation, history, rollback and audit; per-tenant evaluation for
 * workspaces (allow-list and deterministic percentage by tenant id).
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import * as featureFlagService from '../../src/services/featureFlag.service.js';
import { bucketOf } from '../../src/services/featureFlag.service.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { adminWith, onboardTenant, memberOf } from './helpers.js';

const ALL = ['feature_flags.view', 'feature_flags.create', 'feature_flags.update', 'feature_flags.delete'];

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => { await resetMongo(); await rbacCache.clearAll(); await cacheService.flushAll(); });
after(async () => { await stopHttp(); await stopMongo(); });

const create = (headers, body) => api('/api/v1/feature-flags', { method: 'POST', headers, body });
const patch = (key, headers, body) => api(`/api/v1/feature-flags/${key}`, { method: 'PATCH', headers, body });
const evaluate = async (headers) => {
  const res = await api('/api/v1/feature-flags/evaluate', { headers });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json.data.flags;
};

test('each admin endpoint enforces its own permission; tenant tokens and scoped admins are refused', async () => {
  const { tenantId, headers: ownerHeaders } = await onboardTenant();
  const nobody = await adminWith([]);
  const viewer = await adminWith(['feature_flags.view']);
  const scoped = await adminWith(ALL, { tenantScope: tenantId });

  assert.equal((await api('/api/v1/feature-flags', { headers: nobody.headers })).status, 403);
  assert.equal((await api('/api/v1/feature-flags/analytics.realtime', { headers: nobody.headers })).status, 403);
  assert.equal((await api('/api/v1/feature-flags', { headers: viewer.headers })).status, 200);
  assert.equal((await create(viewer.headers, { key: 'beta.x', name: 'X' })).status, 403);
  assert.equal((await patch('analytics.realtime', viewer.headers, { enabled: false })).status, 403);
  assert.equal((await api('/api/v1/feature-flags/analytics.realtime', { method: 'DELETE', headers: viewer.headers })).status, 403);
  assert.equal((await api('/api/v1/feature-flags/analytics.realtime/rollback', { method: 'POST', headers: viewer.headers, body: { toVersion: 0 } })).status, 403);
  assert.equal((await api(`/api/v1/feature-flags/preview?tenantId=${tenantId}`, { headers: nobody.headers })).status, 403);

  const scopedRes = await api('/api/v1/feature-flags', { headers: scoped.headers });
  assert.equal(scopedRes.status, 403);
  assert.equal(scopedRes.json.code, 'ADMIN_SCOPE_DENIED');

  assert.equal((await api('/api/v1/feature-flags', { headers: ownerHeaders })).status, 401, 'workspace token on the admin surface');
  assert.equal((await api('/api/v1/feature-flags')).status, 401);
  assert.equal((await api('/api/v1/feature-flags/evaluate', { headers: viewer.headers })).status, 401, 'admin token on the tenant surface');
});

test('create validates the key, rollout strategy, percentage and allow-listed tenants', async () => {
  const { headers } = await adminWith(ALL);
  const { tenantId } = await onboardTenant();
  const bad = [
    [{ key: 'NoDot', name: 'x' }, 'key'],
    [{ key: 'beta.ok' }, 'name'],
    [{ key: 'beta.ok', name: 'x', rollout: { strategy: 'attribute' } }, 'rollout.strategy'],
    [{ key: 'beta.ok', name: 'x', rollout: { strategy: 'percentage', percentage: 150 } }, 'rollout.percentage'],
    [{ key: 'beta.ok', name: 'x', rollout: { strategy: 'percentage', percentage: 12.5 } }, 'rollout.percentage'],
    [{ key: 'beta.ok', name: 'x', rollout: { strategy: 'tenantId', tenantIds: ['nope'] } }, 'rollout.tenantIds[0]'],
    [{ key: 'beta.ok', name: 'x', rollout: { strategy: 'tenantId', tenantIds: [tenantId, '0123456789abcdef01234567'] } }, 'rollout.tenantIds[1]'],
    [{ key: 'beta.ok', name: 'x', enabled: 'yes' }, 'enabled'],
    [{ key: 'beta.ok', name: 'x', type: 'string' }, 'type'],
  ];
  for (const [body, field] of bad) {
    const res = await create(headers, body);
    assert.ok([400, 422].includes(res.status), `${JSON.stringify(body)} -> ${res.status}`);
    assert.ok(res.json.errors?.some((e) => e.field === field), `${JSON.stringify(body)} flags ${field}: ${JSON.stringify(res.json.errors)}`);
  }

  const created = await create(headers, { key: 'beta.reports', name: 'Beta reports', rollout: { strategy: 'tenantId', tenantIds: [tenantId] } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.data.enabled, false, 'new flags start disabled');
  assert.equal(created.json.data.version, 1);
  assert.deepEqual(created.json.data.rollout, { strategy: 'tenantId', tenantIds: [tenantId], percentage: 100 });
  const duplicate = await create(headers, { key: 'beta.reports', name: 'Again' });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.code, 'FEATURE_FLAG_EXISTS');

  const empty = await patch('beta.reports', headers, {});
  assert.equal(empty.status, 400);
  const missing = await patch('beta.missing', headers, { enabled: true });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, 'FEATURE_FLAG_NOT_FOUND');
});

test('evaluation per tenant: allow-list, deterministic percentage by tenant id, master switch', async () => {
  const { headers } = await adminWith(ALL);
  const tenants = [];
  for (let i = 0; i < 6; i += 1) tenants.push(await onboardTenant());
  const [a, b] = tenants;

  await create(headers, { key: 'beta.allow', name: 'Allow', enabled: true, rollout: { strategy: 'tenantId', tenantIds: [a.tenantId] } });
  await create(headers, { key: 'beta.half', name: 'Half', enabled: true, rollout: { strategy: 'percentage', percentage: 50 } });
  await create(headers, { key: 'beta.off', name: 'Off', enabled: false, rollout: { strategy: 'all' } });

  assert.equal((await evaluate(a.headers))['beta.allow'], true);
  assert.equal((await evaluate(b.headers))['beta.allow'], false);

  for (const tenant of tenants) {
    const flags = await evaluate(tenant.headers);
    const expected = bucketOf('beta.half', tenant.tenantId) < 50;
    assert.equal(flags['beta.half'], expected, `tenant ${tenant.tenantId} bucket ${bucketOf('beta.half', tenant.tenantId)}`);
    assert.deepEqual(await evaluate(tenant.headers), flags, 'stable across requests');
    assert.equal(flags['beta.off'], undefined, 'disabled flags are absent (off)');
  }
  // Deterministic and independent of the flag key.
  assert.equal(bucketOf('beta.half', a.tenantId), bucketOf('beta.half', a.tenantId));
  const buckets = Array.from({ length: 200 }, (_, i) => bucketOf('beta.half', `tenant-${i}`));
  const inRollout = buckets.filter((value) => value < 50).length;
  assert.ok(inRollout > 70 && inRollout < 130, `roughly half of 200 tenants are in a 50% rollout (${inRollout})`);

  // 0% and 100% are absolute; a change is visible immediately (cache invalidated).
  await patch('beta.half', headers, { rollout: { percentage: 0 } });
  for (const tenant of tenants) assert.equal((await evaluate(tenant.headers))['beta.half'], false);
  await patch('beta.half', headers, { rollout: { percentage: 100 } });
  for (const tenant of tenants) assert.equal((await evaluate(tenant.headers))['beta.half'], true);
  await patch('beta.half', headers, { enabled: false });
  assert.equal((await evaluate(a.headers))['beta.half'], undefined);

  assert.equal(await featureFlagService.isEnabled('beta.allow', { tenantId: a.tenantId }), true);
  assert.equal(await featureFlagService.isEnabled('beta.allow', { tenantId: b.tenantId }), false);
  assert.equal(await featureFlagService.isEnabled('beta.unknown', { tenantId: a.tenantId }), false);

  const preview = await api(`/api/v1/feature-flags/preview?tenantId=${b.tenantId}`, { headers });
  assert.equal(preview.status, 200);
  const allow = preview.json.data.find((f) => f.key === 'beta.allow');
  assert.deepEqual({ value: allow.value, reason: allow.reason }, { value: false, reason: 'not_in_allow_list' });
  assert.equal((await api('/api/v1/feature-flags/preview?tenantId=0123456789abcdef01234567', { headers })).status, 404);
});

test('workspace evaluation needs feature_flags.view and is scoped to the caller tenant', async () => {
  const a = await onboardTenant();
  const b = await onboardTenant();
  const viewer = await memberOf(a.tenantId, 'Viewer');
  const manager = await memberOf(a.tenantId, 'Manager');
  const noRole = await memberOf(a.tenantId, null);
  assert.equal((await api('/api/v1/feature-flags/evaluate', { headers: viewer.headers })).status, 200);
  assert.equal((await api('/api/v1/feature-flags/evaluate', { headers: manager.headers })).status, 200);
  assert.equal((await api('/api/v1/feature-flags/evaluate', { headers: noRole.headers })).status, 403);
  const crossTenant = await api('/api/v1/feature-flags/evaluate', {
    headers: { authorization: a.headers.authorization, 'X-Tenant-Id': b.tenantId },
  });
  assert.equal(crossTenant.status, 403, 'a workspace token cannot evaluate another tenant');
});

test('history and rollback restore the exact prior flag state; stale versions conflict; changes are audited', async () => {
  const { headers, admin } = await adminWith(ALL);
  const { tenantId } = await onboardTenant();
  await create(headers, { key: 'beta.history', name: 'History', description: 'first' });
  await patch('beta.history', headers, { enabled: true, rollout: { strategy: 'tenantId', tenantIds: [tenantId] }, version: 1, reason: 'pilot' });
  await patch('beta.history', headers, { rollout: { strategy: 'percentage', percentage: 25 }, description: '' });

  const stale = await patch('beta.history', headers, { enabled: false, version: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'VERSION_CONFLICT');

  const history = await api('/api/v1/feature-flags/beta.history/history', { headers });
  assert.equal(history.status, 200);
  assert.deepEqual(history.json.data.map((r) => [r.version, r.action]), [[3, 'update'], [2, 'update'], [1, 'create']]);
  const v2 = history.json.data[1].state;
  assert.equal(history.json.data[1].reason, 'pilot');

  const rolled = await api('/api/v1/feature-flags/beta.history/rollback', { method: 'POST', headers, body: { toVersion: 2, version: 3 } });
  assert.equal(rolled.status, 200, JSON.stringify(rolled.json));
  assert.equal(rolled.json.data.version, 4);
  assert.equal(rolled.json.data.enabled, v2.enabled);
  assert.equal(rolled.json.data.description, v2.description);
  assert.deepEqual(rolled.json.data.rollout, v2.rollout);
  assert.deepEqual(rolled.json.data.rollout, { strategy: 'tenantId', tenantIds: [tenantId], percentage: 100 });

  const toFirst = await api('/api/v1/feature-flags/beta.history/rollback', { method: 'POST', headers, body: { toVersion: 1 } });
  assert.equal(toFirst.json.data.enabled, false);
  assert.equal(toFirst.json.data.description, 'first');
  assert.deepEqual(toFirst.json.data.rollout, { strategy: 'all', tenantIds: [], percentage: 100 });

  const audits = await AuditLog.find({ module: 'platform.feature_flags', action: /^feature_flag\./ }).sort({ _id: 1 }).lean();
  assert.deepEqual(audits.map((a) => a.action), [
    'feature_flag.created', 'feature_flag.updated', 'feature_flag.updated', 'feature_flag.rolled_back', 'feature_flag.rolled_back',
  ]);
  assert.equal(audits[1].before.enabled, false);
  assert.equal(audits[1].after.enabled, true);
  assert.equal(audits[1].actorId, String(admin._id));
  assert.equal(audits[1].reason, 'pilot');
});

test('system flags cannot be deleted; deleting a custom flag turns it off and a rollback revives it', async () => {
  const { headers } = await adminWith(ALL);
  const owner = await onboardTenant();
  const system = await api('/api/v1/feature-flags/analytics.realtime', { method: 'DELETE', headers });
  assert.equal(system.status, 409);
  assert.equal(system.json.code, 'FEATURE_FLAG_SYSTEM');

  // System flags can be disabled (and that is what the old 501 prevented).
  const disabled = await patch('connectors.webhooks', headers, { rollout: { tenantIds: [owner.tenantId] } });
  assert.equal(disabled.status, 200);
  assert.equal((await evaluate(owner.headers))['connectors.webhooks'], true);

  await create(headers, { key: 'beta.gone', name: 'Gone', enabled: true });
  assert.equal((await evaluate(owner.headers))['beta.gone'], true);
  const deleted = await api('/api/v1/feature-flags/beta.gone?version=1', { method: 'DELETE', headers });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
  assert.deepEqual(deleted.json.data, { key: 'beta.gone', deleted: true, version: 2 });
  assert.equal((await evaluate(owner.headers))['beta.gone'], undefined);
  assert.equal((await api('/api/v1/feature-flags/beta.gone', { headers })).status, 404);

  const toDeleted = await api('/api/v1/feature-flags/beta.gone/rollback', { method: 'POST', headers, body: { toVersion: 2 } });
  assert.equal(toDeleted.status, 400);
  const revived = await api('/api/v1/feature-flags/beta.gone/rollback', { method: 'POST', headers, body: { toVersion: 1 } });
  assert.equal(revived.status, 200);
  assert.equal((await evaluate(owner.headers))['beta.gone'], true);
});

test('list supports search and enabled filters with pagination meta', async () => {
  const { headers } = await adminWith(ALL);
  await featureFlagService.ensureDefaults();
  await create(headers, { key: 'beta.search_me', name: 'Find me', enabled: true });
  const all = await api('/api/v1/feature-flags?limit=50', { headers });
  assert.equal(all.status, 200);
  // ai-ask: two more system flags (ai.assistant, ai.kill_switch).
  assert.equal(all.json.meta.total, 7);
  assert.ok(all.json.data.find((f) => f.key === 'analytics.realtime').isSystem);
  const found = await api('/api/v1/feature-flags?search=find', { headers });
  assert.deepEqual(found.json.data.map((f) => f.key), ['beta.search_me']);
  const enabledOnly = await api('/api/v1/feature-flags?enabled=false', { headers });
  // ai-ask: the kill switch ships disabled.
  assert.deepEqual(enabledOnly.json.data.map((f) => f.key), ['ai.kill_switch']);
});
