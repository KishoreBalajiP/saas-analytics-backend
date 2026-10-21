/**
 * Security alert admin API (roadmap 2.6): /api/v1/admin/security-alerts.
 *
 * Covers authentication, the security.alerts.view / .update permissions,
 * filters and pagination, evidence, the acknowledge / false positive /
 * resolve workflow with notes and audit events, state conflicts, input
 * validation and tenant-scoped administrator isolation.
 */

import test, { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import { bearerFor } from '../helpers/auth.js';
import { shortToken } from '../../src/utils/id.js';
import adminService from '../../src/services/admin.service.js';
import roleService from '../../src/services/role.service.js';
import permissionService from '../../src/services/permission.service.js';
import settingService from '../../src/services/setting.service.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import { raiseDetection, runDetection } from '../../src/services/securityDetection/engine.js';
import { getRule } from '../../src/services/securityDetection/rules/index.js';
import { SecurityAlert } from '../../src/models/SecurityAlert.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { at, nowFor, loginAttempts } from './helpers.js';

const PASSWORD = 'Password123!';
const BASE = '/api/v1/admin/security-alerts';

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

/** Platform admin holding `keys`, optionally scoped to one tenant. Returns headers + admin. */
async function adminWith(keys, { tenantScope = null } = {}) {
  const admin = await adminService.create({
    email: `sec-${shortToken(8).toLowerCase()}@platform.test`,
    password: PASSWORD,
    adminType: tenantScope ? 'support' : 'platform',
    tenantScope,
    name: 'Security Tester',
  });
  const role = await roleService.create({ tenantId: null, name: `role_${shortToken(8)}` });
  for (const key of keys) {
    await ensurePermission(key);
    await roleService.addPermission({ roleId: role._id, permissionKey: key, by: null /* fixture seeding */ });
  }
  // A scoped admin's grants live in its tenant scope.
  await adminService.assignRole({ adminId: admin._id, roleId: role._id, tenantId: tenantScope, by: null /* fixture seeding */ });
  const login = await api('/api/v1/admin-auth/login', { method: 'POST', body: { email: admin.email, password: PASSWORD } });
  assert.equal(login.status, 200);
  return { admin, headers: { authorization: `Bearer ${login.json.data.accessToken}` } };
}

const rule = (id, severity) => ({ id, version: 2, title: id, severity, defaults: { enabled: true }, params: {} });

/** Seed: high/open (tenant-a), medium (platform, no tenant), low (tenant-b). */
async function seedAlerts() {
  const notify = false;
  const high = await raiseDetection(rule('auth.credential_stuffing', 'high'), {
    subject: { type: 'ip', id: '203.0.113.9', display: '203.0.113.9' },
    tenantId: 'tenant-a',
    title: 'Credential stuffing from 203.0.113.9',
    summary: '25 failed sign-ins',
    windowStart: at(-30),
    windowEnd: at(-3),
    counts: { failures: 25, accounts: 12 },
    details: { ipRange: '203.0.113.0/24' },
    refs: [{ source: 'login_attempt', id: 'la1', at: at(-3), label: 'user a@x: invalid_credentials' }],
  }, { now: nowFor(0), notify });
  const medium = await raiseDetection(rule('auth.admin_new_ip', 'medium'), {
    subject: { type: 'admin', id: 'adm1', display: 'root@platform.test' },
    title: 'Admin signed in from a new IP',
    windowStart: at(-20),
    windowEnd: at(-2),
    counts: { logins: 1 },
    refs: [],
  }, { now: nowFor(0), notify });
  const low = await raiseDetection(rule('connector.auth_failures', 'low'), {
    subject: { type: 'connector', id: 'c1', display: 'c1' },
    tenantId: 'tenant-b',
    title: 'Connector failures',
    windowStart: at(-10),
    windowEnd: at(-1),
    counts: { failures: 5 },
    refs: [],
  }, { now: nowFor(0), notify });
  return { high: String(high.alert._id), medium: String(medium.alert._id), low: String(low.alert._id) };
}

before(async () => { await startMongo(); await startHttp(); });
after(async () => { await stopHttp(); await stopMongo(); });
beforeEach(async () => {
  await resetMongo();
  await rbacCache.clearAll();
  await cacheService.flushAll?.();
});

describe('authentication and permissions', () => {
  test('every endpoint requires an admin session', async () => {
    const id = '64b000000000000000000009';
    for (const [method, path] of [
      ['GET', BASE], ['GET', `${BASE}/rules`], ['GET', `${BASE}/${id}`],
      ['POST', `${BASE}/${id}/acknowledge`], ['POST', `${BASE}/${id}/false-positive`], ['POST', `${BASE}/${id}/resolve`],
    ]) {
      const res = await api(path, { method, body: method === 'POST' ? { note: 'xyz' } : undefined });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
    // A tenant-portal token is not an admin token.
    const userToken = await bearerFor({ id: '64b000000000000000000010', tenantId: 't1' });
    assert.equal((await api(BASE, { headers: { authorization: userToken } })).status, 401);
  });

  test('admins without security.alerts.view are refused; view-only admins cannot triage', async () => {
    const ids = await seedAlerts();
    const other = await adminWith(['monitoring.view']);
    assert.equal((await api(BASE, { headers: other.headers })).status, 403);
    assert.equal((await api(`${BASE}/${ids.high}`, { headers: other.headers })).status, 403);

    const viewer = await adminWith(['security.alerts.view']);
    assert.equal((await api(BASE, { headers: viewer.headers })).status, 200);
    for (const action of ['acknowledge', 'false-positive', 'resolve']) {
      const res = await api(`${BASE}/${ids.high}/${action}`, { method: 'POST', headers: viewer.headers, body: { note: 'not mine to close' } });
      assert.equal(res.status, 403, action);
    }
    assert.equal((await SecurityAlert.findById(ids.high).lean()).status, 'open');
  });
});

describe('listing and evidence', () => {
  test('lists newest activity first with pagination, status counts and filters', async () => {
    const ids = await seedAlerts();
    const { headers } = await adminWith(['security.alerts.view']);

    const all = await api(`${BASE}?limit=2`, { headers });
    assert.equal(all.status, 200);
    assert.deepEqual(all.json.data.map((a) => a.id), [ids.low, ids.medium]);
    assert.equal(all.json.meta.total, 3);
    assert.equal(all.json.meta.pages, 2);
    assert.deepEqual(all.json.meta.statusCounts, { open: 3, acknowledged: 0, false_positive: 0, resolved: 0 });
    const first = all.json.data[0];
    assert.equal(first.evidence, undefined, 'the list omits evidence');
    assert.equal(first.subject.type, 'connector');

    const severities = await api(`${BASE}?severity=high,medium`, { headers });
    assert.deepEqual(severities.json.data.map((a) => a.id).sort(), [ids.high, ids.medium].sort());
    const byRule = await api(`${BASE}?ruleId=auth.credential_stuffing`, { headers });
    assert.deepEqual(byRule.json.data.map((a) => a.id), [ids.high]);
    const byTenant = await api(`${BASE}?tenantId=tenant-b`, { headers });
    assert.deepEqual(byTenant.json.data.map((a) => a.id), [ids.low]);
    const search = await api(`${BASE}?search=${encodeURIComponent('root@platform')}`, { headers });
    assert.deepEqual(search.json.data.map((a) => a.id), [ids.medium]);
    const regexSafe = await api(`${BASE}?search=${encodeURIComponent('.*')}`, { headers });
    assert.equal(regexSafe.json.data.length, 0, 'search is literal, not a regex');
    const closed = await api(`${BASE}?status=resolved`, { headers });
    assert.equal(closed.json.data.length, 0);
  });

  test('invalid filters are 422', async () => {
    const { headers } = await adminWith(['security.alerts.view']);
    for (const query of ['status=closed', 'severity=urgent', 'ruleId=DROP%20TABLE', 'from=yesterday', 'limit=500', 'tenantId=%7B%22%24ne%22%3A1%7D']) {
      const res = await api(`${BASE}?${query}`, { headers });
      assert.equal(res.status, 422, query);
    }
  });

  test('one alert carries its evidence, history and notifications', async () => {
    const ids = await seedAlerts();
    const { headers } = await adminWith(['security.alerts.view']);
    const res = await api(`${BASE}/${ids.high}`, { headers });
    assert.equal(res.status, 200);
    const alert = res.json.data;
    assert.equal(alert.ruleId, 'auth.credential_stuffing');
    assert.equal(alert.ruleVersion, 2);
    assert.equal(alert.severity, 'high');
    assert.equal(alert.tenantId, 'tenant-a');
    assert.deepEqual(alert.evidence.counts, { failures: 25, accounts: 12 });
    assert.equal(alert.evidence.details.ipRange, '203.0.113.0/24');
    assert.deepEqual(alert.evidence.refs, [{ source: 'login_attempt', id: 'la1', at: at(-3).toISOString(), label: 'user a@x: invalid_credentials' }]);
    assert.equal(alert.history[0].action, 'raised');
    assert.deepEqual(alert.notifications, []);
    assert.equal(alert.dedupeKey, undefined);
    assert.equal(alert.activeKey, undefined);

    assert.equal((await api(`${BASE}/64b000000000000000000099`, { headers })).status, 404);
    assert.equal((await api(`${BASE}/not-an-id`, { headers })).status, 422);
  });
});

describe('triage workflow', () => {
  test('acknowledge takes ownership; a second acknowledge is a 409 conflict', async () => {
    const ids = await seedAlerts();
    const { admin, headers } = await adminWith(['security.alerts.view', 'security.alerts.update']);
    const res = await api(`${BASE}/${ids.high}/acknowledge`, { method: 'POST', headers, body: { note: 'looking into it' } });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.status, 'acknowledged');
    assert.equal(res.json.data.owner.id, String(admin._id));
    assert.equal(res.json.data.acknowledgedBy.display, admin.email);
    assert.ok(res.json.data.acknowledgedAt);
    assert.equal(res.json.data.history.at(-1).action, 'acknowledged');
    assert.equal(res.json.data.history.at(-1).note, 'looking into it');

    const event = await AuditLog.findOne({ action: 'security.alert.acknowledged' }).lean();
    assert.equal(event.actorType, 'admin');
    assert.equal(event.actorId, String(admin._id));
    assert.equal(event.resourceId, ids.high);

    const again = await api(`${BASE}/${ids.high}/acknowledge`, { method: 'POST', headers, body: {} });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, 'SECURITY_ALERT_STATE_CONFLICT');

    // Acknowledged alerts still absorb new detections (one active alert per key).
    const stillActive = await SecurityAlert.findById(ids.high).lean();
    assert.equal(stillActive.activeKey, stillActive.dedupeKey);
  });

  test('false positive and resolve need a note, close the alert and release the dedupe key', async () => {
    const ids = await seedAlerts();
    const { admin, headers } = await adminWith(['security.alerts.view', 'security.alerts.update']);

    const missing = await api(`${BASE}/${ids.high}/false-positive`, { method: 'POST', headers, body: {} });
    assert.equal(missing.status, 422);
    const blank = await api(`${BASE}/${ids.high}/resolve`, { method: 'POST', headers, body: { note: '   ' } });
    assert.equal(blank.status, 422);
    const tooLong = await api(`${BASE}/${ids.high}/resolve`, { method: 'POST', headers, body: { note: 'x'.repeat(2001) } });
    assert.equal(tooLong.status, 422);

    const fp = await api(`${BASE}/${ids.high}/false-positive`, { method: 'POST', headers, body: { note: 'pen test window' } });
    assert.equal(fp.status, 200);
    assert.equal(fp.json.data.status, 'false_positive');
    assert.equal(fp.json.data.resolutionNote, 'pen test window');
    assert.equal(fp.json.data.closedBy.id, String(admin._id));
    assert.equal(fp.json.data.owner.id, String(admin._id));
    const stored = await SecurityAlert.findById(ids.high).lean();
    assert.equal(stored.activeKey, undefined);
    assert.ok(stored.closedAt);
    assert.ok(await AuditLog.findOne({ action: 'security.alert.false_positive', resourceId: ids.high }).lean());

    const reopen = await api(`${BASE}/${ids.high}/resolve`, { method: 'POST', headers, body: { note: 'actually real' } });
    assert.equal(reopen.status, 409);

    const resolved = await api(`${BASE}/${ids.medium}/resolve`, { method: 'POST', headers, body: { note: 'confirmed with the admin' } });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.json.data.status, 'resolved');
    assert.ok(await AuditLog.findOne({ action: 'security.alert.resolved', resourceId: ids.medium }).lean());

    const counts = await api(BASE, { headers });
    assert.deepEqual(counts.json.meta.statusCounts, { open: 1, acknowledged: 0, false_positive: 1, resolved: 1 });
    assert.equal((await api(`${BASE}/64b000000000000000000099/resolve`, { method: 'POST', headers, body: { note: 'abc' } })).status, 404);
  });
});

describe('tenant-scoped administrators', () => {
  test('see and triage only their tenant\'s alerts', async () => {
    const ids = await seedAlerts();
    const { headers } = await adminWith(['security.alerts.view', 'security.alerts.update'], { tenantScope: 'tenant-a' });

    const list = await api(`${BASE}?tenantId=tenant-b`, { headers });
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.data.map((a) => a.id), [ids.high]);
    assert.equal(list.json.meta.total, 1);

    assert.equal((await api(`${BASE}/${ids.low}`, { headers })).status, 404);
    assert.equal((await api(`${BASE}/${ids.medium}`, { headers })).status, 404, 'platform-level alerts are hidden');
    assert.equal((await api(`${BASE}/${ids.low}/acknowledge`, { method: 'POST', headers, body: {} })).status, 404);
    assert.equal((await SecurityAlert.findById(ids.low).lean()).status, 'open');
    assert.equal((await api(`${BASE}/${ids.high}/acknowledge`, { method: 'POST', headers, body: {} })).status, 200);
  });
});

describe('rule catalogue', () => {
  test('lists every rule with effective thresholds, ignored overrides and watermarks', async () => {
    await settingService.create({
      key: 'security.detection.rules', scope: 'platform', type: 'json',
      value: { 'auth.credential_stuffing': { minFailures: 30, bogus: true } },
    });
    await loginAttempts([{ ip: '203.0.113.5', email: 'v@x.test', occurredAt: at(-5) }]);
    await runDetection({ rules: [getRule('auth.credential_stuffing')], now: nowFor(0), notify: false });

    const { headers } = await adminWith(['security.alerts.view']);
    const res = await api(`${BASE}/rules`, { headers });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.length, 15);
    const stuffing = res.json.data.find((r) => r.id === 'auth.credential_stuffing');
    assert.equal(stuffing.version, 1);
    assert.equal(stuffing.severity, 'high');
    assert.equal(stuffing.enabled, true);
    assert.equal(stuffing.config.minFailures, 30);
    assert.equal(stuffing.defaults.minFailures, 20);
    assert.deepEqual(stuffing.ignoredOverrides, [{ origin: 'setting', param: 'bogus', reason: 'unknown parameter' }]);
    assert.equal(stuffing.watermark, at(0).toISOString());
    const untouched = res.json.data.find((r) => r.id === 'auth.admin_new_ip');
    assert.equal(untouched.watermark, null);
  });
});
