/**
 * Workspace time zone setting (roadmap 1.2) over real HTTP:
 * GET/PATCH /api/v1/workspace/settings, permission checks, validation,
 * tenant isolation, audit, and its effect on analytics.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import { shortToken } from '../../src/utils/id.js';
import { hash } from '../../src/utils/password.js';
import * as tenantService from '../../src/services/tenant.service.js';
import * as tenantSettings from '../../src/services/tenantSettings.service.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import userRepository from '../../src/repositories/user.repository.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import * as reportService from '../../src/services/report.service.js';
import * as alertService from '../../src/services/alert.service.js';
import clock from '../../src/utils/clock.js';
// billing: tenants exercising paid features need a plan that includes them.
import { entitleTenant } from '../helpers/billing.js';

const PASSWORD = 'Password123!';

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => { await resetMongo(); await rbacCache.clearAll(); await cacheService.flushAll(); });
after(async () => { await stopHttp(); await stopMongo(); });

async function onboard() {
  const owner = { email: `owner-${shortToken(10).toLowerCase()}@example.com`, name: 'Owner', password: PASSWORD };
  const { tenant } = await tenantService.create({ tenant: { name: `TZ ${shortToken(10)}` }, owner, initialize: true, by: 'root' });
  await entitleTenant(tenant._id);
  const tenantId = tenant._id.toString();
  const login = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email: owner.email, password: PASSWORD } });
  assert.equal(login.status, 200);
  return { tenantId, auth: { authorization: `Bearer ${login.json.data.accessToken}`, 'X-Tenant-Id': tenantId } };
}

async function memberWithoutRoles(tenantId) {
  const email = `nobody-${shortToken(10).toLowerCase()}@example.com`;
  await userRepository.create({ tenantId, email, status: 'active', passwordHash: await hash(PASSWORD), profile: { name: 'Nobody' } });
  const login = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email, password: PASSWORD } });
  return { authorization: `Bearer ${login.json.data.accessToken}`, 'X-Tenant-Id': tenantId };
}

test('the workspace time zone defaults to UTC and can be changed by a settings manager', async () => {
  const { tenantId, auth } = await onboard();
  const initial = await api('/api/v1/workspace/settings', { headers: auth });
  assert.equal(initial.status, 200, JSON.stringify(initial.json));
  assert.deepEqual(initial.json.data, { timezone: 'UTC' });

  const updated = await api('/api/v1/workspace/settings', { method: 'PATCH', headers: auth, body: { timezone: 'Asia/Kolkata' } });
  assert.equal(updated.status, 200, JSON.stringify(updated.json));
  assert.deepEqual(updated.json.data, { timezone: 'Asia/Kolkata' });
  assert.deepEqual((await api('/api/v1/workspace/settings', { headers: auth })).json.data, { timezone: 'Asia/Kolkata' });

  // Analytics now resolve presets in that zone and say so.
  const query = await api('/api/v1/analytics', { headers: auth });
  assert.equal(query.status, 200);
  assert.equal(query.json.meta.timezone, 'Asia/Kolkata');

  const audit = await AuditLog.findOne({ tenantId, action: 'settings.updated' }).lean();
  assert.ok(audit, 'the change is audited');
  assert.deepEqual(audit.after, { timezone: 'Asia/Kolkata' });
  assert.deepEqual(audit.before, { timezone: 'UTC' });
});

test('invalid time zones and unknown settings are rejected with field errors', async () => {
  const { auth } = await onboard();
  const bad = await api('/api/v1/workspace/settings', { method: 'PATCH', headers: auth, body: { timezone: 'Mars/Olympus_Mons' } });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.errors.some((e) => e.field === 'timezone'));
  const unknown = await api('/api/v1/workspace/settings', { method: 'PATCH', headers: auth, body: { timezone: 'UTC', currency: 'EUR' } });
  assert.equal(unknown.status, 400);
  assert.ok(unknown.json.errors.some((e) => e.field === 'currency'));
  const notAString = await api('/api/v1/workspace/settings', { method: 'PATCH', headers: auth, body: { timezone: ['UTC'] } });
  assert.ok([400, 422].includes(notAString.status));
  assert.deepEqual((await api('/api/v1/workspace/settings', { headers: auth })).json.data, { timezone: 'UTC' }, 'nothing was stored');
});

test('members without settings permissions cannot read or change the time zone', async () => {
  const { tenantId } = await onboard();
  const nobody = await memberWithoutRoles(tenantId);
  assert.equal((await api('/api/v1/workspace/settings', { headers: nobody })).status, 403);
  assert.equal((await api('/api/v1/workspace/settings', { method: 'PATCH', headers: nobody, body: { timezone: 'UTC' } })).status, 403);
  assert.equal((await api('/api/v1/workspace/settings')).status, 401);
});

test('each workspace has its own time zone', async () => {
  const a = await onboard();
  const b = await onboard();
  await api('/api/v1/workspace/settings', { method: 'PATCH', headers: a.auth, body: { timezone: 'America/New_York' } });
  assert.deepEqual((await api('/api/v1/workspace/settings', { headers: b.auth })).json.data, { timezone: 'UTC' });
  assert.equal(await tenantSettings.getTimezone(a.tenantId), 'America/New_York');
  assert.equal(await tenantSettings.getTimezone(b.tenantId), 'UTC');
});

test('the platform-admin settings path validates the time zone too', async () => {
  const { tenantId } = await onboard();
  await assert.rejects(
    () => tenantSettings.updateGroup({ tenantId, group: 'localization', values: { 'localization.timezone': 'Not/AZone' } }),
    (e) => e.statusCode === 400 && e.errors.some((x) => x.field === 'localization.timezone'),
  );
  await tenantSettings.updateGroup({ tenantId, group: 'localization', values: { 'localization.timezone': 'europe/berlin' } });
  assert.equal(await tenantSettings.getTimezone(tenantId), 'Europe/Berlin', 'stored in canonical spelling');
});

test('a time zone change on either surface re-projects schedules that follow the workspace', async () => {
  const { tenantId, auth } = await onboard();
  clock.set(new Date('2026-03-01T12:00:00Z'));
  try {
    const datasetId = '0123456789abcdef01234567';
    const report = await reportService.create({
      tenantId, name: 'Daily', source: 'query', query: { datasetId }, schedule: { enabled: true, cron: '0 8 * * *' },
    });
    const pinned = await reportService.create({
      tenantId, name: 'Pinned', source: 'query', query: { datasetId }, schedule: { enabled: true, cron: '0 8 * * *', timezone: 'UTC' },
    });
    const alert = await alertService.createRule({
      tenantId, name: 'Nine', source: 'query', query: { datasetId }, condition: 'gt', threshold: 1, schedule: { cron: '0 9 * * *' },
    });
    await alertService.updateRule({ tenantId, alertId: String(alert._id), patch: { schedule: { cron: '0 9 * * *' } } });
    assert.equal(new Date((await reportService.getById({ tenantId, reportId: String(report._id) })).nextRunAt).toISOString(), '2026-03-02T08:00:00.000Z');

    // Platform-admin surface (tenant settings group update).
    await tenantSettings.updateGroup({ tenantId, group: 'localization', values: { 'localization.timezone': 'Asia/Kolkata' } });
    const nextRun = async (id) => new Date((await reportService.getById({ tenantId, reportId: String(id) })).nextRunAt).toISOString();
    const nextEval = async () => new Date((await alertService.getById({ tenantId, alertId: String(alert._id) })).nextEvaluationAt).toISOString();
    assert.equal(await nextRun(report._id), '2026-03-02T02:30:00.000Z', '08:00 in Kolkata');
    assert.equal(await nextRun(pinned._id), '2026-03-02T08:00:00.000Z', 'a schedule with its own zone keeps it');
    assert.equal(await nextEval(), '2026-03-02T03:30:00.000Z', '09:00 in Kolkata');

    // Workspace self-service surface.
    const res = await api('/api/v1/workspace/settings', { method: 'PATCH', headers: auth, body: { timezone: 'America/New_York' } });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(await nextRun(report._id), '2026-03-01T13:00:00.000Z', '08:00 in New York (EST)');
    assert.equal(await nextEval(), '2026-03-01T14:00:00.000Z', '09:00 in New York (EST)');
  } finally {
    clock.reset();
  }
});
