/**
 * Denied-request audit (roadmap 2.5; finding gov.06).
 *
 * Every 401/403 from authentication/authorization middleware that refuses
 * an identity is a `request.denied` security event with actor, tenant,
 * route pattern, reason and ip - once per (actor or ip, tenant, route,
 * reason) per window, and capped per process, so it cannot flood the trail.
 * Routine traffic (no credential, expired token) is not recorded.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import { bearerFor } from '../helpers/auth.js';
import { shortToken } from '../../src/utils/id.js';
import { hash } from '../../src/utils/password.js';
import env from '../../src/config/env.js';
import * as tenantService from '../../src/services/tenant.service.js';
import adminService from '../../src/services/admin.service.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import userRepository from '../../src/repositories/user.repository.js';
import { createHash } from 'node:crypto';
import {
  securityEvent, takeDeniedBudget, resetSecurityEventLimits, localDedupeSize,
} from '../../src/services/securityEvent.service.js';
import { SECURITY_EVENTS } from '../../src/constants/securityEvents.js';
import { routeOf } from '../../src/middleware/audit.middleware.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { User } from '../../src/models/User.js';

const PASSWORD = 'Password123!';

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => {
  await resetMongo();
  await rbacCache.clearAll();
  await cacheService.flushAll();
  resetSecurityEventLimits();
});
after(async () => { await stopHttp(); await stopMongo(); });

const DENIED = { category: 'security', action: 'request.denied' };

async function waitForDenied(filter, { timeoutMs = 4000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await AuditLog.findOne({ ...DENIED, ...filter }).lean();
    if (row) return row;
    assert.ok(Date.now() < deadline, `no denied row matched ${JSON.stringify(filter)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function settledDenied(filter = {}) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  return AuditLog.countDocuments({ ...DENIED, ...filter });
}

async function workspace() {
  const owner = { email: `owner-${shortToken(10).toLowerCase()}@example.com`, name: 'Owner', password: PASSWORD };
  const { tenant } = await tenantService.create({ tenant: { name: `Den ${shortToken(8)}` }, owner, initialize: true, by: 'root' });
  const tenantId = String(tenant._id);
  const user = await User.findOne({ tenantId, email: owner.email }).lean();
  const login = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email: owner.email, password: PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return { tenantId, userId: String(user._id), token: login.json.data.accessToken };
}

async function memberWithoutRoles(tenantId) {
  const email = `nobody-${shortToken(10).toLowerCase()}@example.com`;
  const user = await userRepository.create({ tenantId, email, status: 'active', passwordHash: await hash(PASSWORD), profile: { name: 'Nobody' } });
  const login = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email, password: PASSWORD } });
  assert.equal(login.status, 200);
  return { userId: String(user._id), auth: { authorization: `Bearer ${login.json.data.accessToken}`, 'X-Tenant-Id': tenantId } };
}

/* ------------------------------ cross-tenant ------------------------------ */

test('a cross-tenant request (X-Tenant-Id of another workspace) is recorded once per window', async () => {
  const a = await workspace();
  const b = await workspace();
  for (let i = 0; i < 3; i += 1) {
    const res = await api('/api/v1/workspace/settings', {
      headers: { authorization: `Bearer ${a.token}`, 'X-Tenant-Id': b.tenantId },
    });
    assert.equal(res.status, 403);
  }
  const row = await waitForDenied({ actorId: a.userId, reason: 'cross_tenant' });
  assert.equal(row.actorType, 'user');
  assert.equal(row.tenantId, b.tenantId, 'the row belongs to the tenant that was targeted');
  assert.equal(row.metadata.actorTenantId, a.tenantId);
  assert.equal(row.metadata.route, 'GET /api/v1/workspace/settings');
  assert.equal(row.metadata.statusCode, 403);
  assert.equal(row.result, 'failure');
  assert.equal(row.severity, 'warning');
  assert.match(row.ip, /127\.0\.0\.1/);
  assert.ok(row.requestId);
  assert.equal(await settledDenied({ actorId: a.userId, reason: 'cross_tenant' }), 1, 'repeats inside the window are not written');
});

test('tenantIsolation refusals name the requested tenant', async () => {
  const a = await workspace();
  const b = await workspace();
  for (let i = 0; i < 2; i += 1) {
    const res = await api(`/api/v1/tenants/${b.tenantId}/subscription`, { headers: { authorization: `Bearer ${a.token}` } });
    assert.equal(res.status, 403);
  }
  const row = await waitForDenied({ actorId: a.userId, reason: 'cross_tenant' });
  assert.equal(row.tenantId, b.tenantId);
  assert.equal(row.metadata.route, 'GET /api/v1/tenants/:id/subscription', 'identifier segments are generalised');
  assert.equal(await settledDenied({ actorId: a.userId }), 1);
});

/* --------------------------- permissions and roles -------------------------- */

test('a missing permission is recorded with the permission key; a different route is a different row', async () => {
  const ws = await workspace();
  const member = await memberWithoutRoles(ws.tenantId);
  assert.equal((await api('/api/v1/users', { headers: member.auth })).status, 403);
  assert.equal((await api('/api/v1/users', { headers: member.auth })).status, 403);
  const row = await waitForDenied({ actorId: member.userId, reason: 'permission_missing' });
  assert.equal(row.metadata.permission, 'users.view');
  assert.equal(row.tenantId, ws.tenantId);
  assert.equal(row.metadata.route, 'GET /api/v1/users');

  assert.equal((await api('/api/v1/api-keys', { headers: member.auth })).status, 403);
  await waitForDenied({ actorId: member.userId, 'metadata.route': /api-keys/ });
  assert.equal(await settledDenied({ actorId: member.userId }), 2);
});

test('an admin without the audit permission is recorded as an admin refusal', async () => {
  const admin = await adminService.create({ email: `adm-${shortToken(8).toLowerCase()}@example.com`, password: PASSWORD, adminType: 'platform' });
  const login = await api('/api/v1/admin-auth/login', { method: 'POST', body: { email: admin.email, password: PASSWORD } });
  const res = await api('/api/v1/audit-logs', { headers: { authorization: `Bearer ${login.json.data.accessToken}` } });
  assert.equal(res.status, 403);
  const row = await waitForDenied({ actorId: String(admin._id) });
  assert.equal(row.actorType, 'admin');
  assert.equal(row.metadata.permission, 'audit_logs.view');
  assert.equal(row.tenantId, null);
});

/* ------------------------------ authentication ----------------------------- */

test('a suspended account presenting its token is recorded with the verified subject', async () => {
  const ws = await workspace();
  await userRepository.update(ws.userId, { status: 'suspended' });
  const res = await api('/api/v1/users/me', { headers: { authorization: `Bearer ${ws.token}` } });
  assert.equal(res.status, 401);
  const row = await waitForDenied({ reason: 'account_suspended' });
  assert.equal(row.actorType, 'user');
  assert.equal(row.actorId, ws.userId, 'the authentic token subject is named');
  assert.equal(row.tenantId, ws.tenantId);
  assert.equal(row.errorCode, 'ACCOUNT_SUSPENDED');
});

test('an anonymous refusal cannot file its row under a tenant named in the body or query', async () => {
  const ws = await workspace();
  const [head, body] = ws.token.split('.');
  const forged = `${head}.${body}.${'B'.repeat(43)}`;
  const res = await api('/api/v1/users/me?tenantId=victim-tenant', { headers: { authorization: `Bearer ${forged}` } });
  assert.equal(res.status, 401);
  const row = await waitForDenied({ reason: 'token_invalid' });
  assert.equal(row.tenantId, null, 'query/body tenant ids are ignored for unidentified callers');
  assert.equal(row.metadata.route, 'GET /api/v1/users/me');
});

test('a forged token is recorded; expired tokens and requests without credentials are not', async () => {
  const ws = await workspace();
  const [head, body] = ws.token.split('.');
  const forged = `${head}.${body}.${'A'.repeat(43)}`;
  assert.equal((await api('/api/v1/users/me', { headers: { authorization: `Bearer ${forged}` } })).status, 401);
  const row = await waitForDenied({ reason: 'token_invalid' });
  assert.equal(row.actorType, 'system');
  assert.equal(row.actorId, null);
  assert.match(row.ip, /127\.0\.0\.1/);
  assert.ok(!JSON.stringify(row).includes(forged), 'the token itself is never stored');

  assert.equal((await api('/api/v1/users/me')).status, 401);
  const expired = await bearerFor({ id: ws.userId, tenantId: ws.tenantId }, { expiresIn: '1s' });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal((await api('/api/v1/users/me', { headers: { authorization: expired } })).status, 401);
  assert.equal(await settledDenied(), 1, 'only the forged token was recorded');
});

test('an invalid API key is recorded; a request without the header is not', async () => {
  const bogus = `sak_${'b'.repeat(32)}.${'s'.repeat(43)}`;
  assert.equal((await api('/api/v1/external/datasets', { headers: { 'X-Api-Key': bogus } })).status, 401);
  const row = await waitForDenied({ reason: 'api_key_invalid' });
  assert.equal(row.metadata.route, 'GET /api/v1/external/datasets');
  assert.ok(!JSON.stringify(row).includes('s'.repeat(43)), 'the presented key is never stored');
  assert.equal((await api('/api/v1/external/datasets')).status, 401);
  assert.equal(await settledDenied(), 1);
});

/* --------------------------------- flooding -------------------------------- */

test('the per-process budget caps denied rows per window', () => {
  resetSecurityEventLimits();
  const max = env.audit.deniedMaxPerWindow;
  const now = Date.now();
  for (let i = 0; i < max; i += 1) assert.equal(takeDeniedBudget(now), true);
  assert.equal(takeDeniedBudget(now), false, 'over the cap inside the window');
  assert.equal(takeDeniedBudget(now + env.audit.deniedWindowSec * 1000), true, 'a new window resets the budget');
});

test('de-duplication without Redis stays in a bounded in-process map, never in the in-memory cache', async () => {
  resetSecurityEventLimits();
  const def = SECURITY_EVENTS.REQUEST_DENIED;
  const first = await securityEvent('REQUEST_DENIED', { dedupeKey: 'probe-key', admit: () => false });
  assert.equal(first, null, 'admit() refused the write');
  const digest = createHash('sha256').update(`${def.action}|probe-key`).digest('hex').slice(0, 40);
  assert.equal(await cacheService.get(`audit:security:dedupe:${digest}`), null, 'nothing is left in the cache store');
  assert.equal(localDedupeSize(), 1);

  // Thousands of attacker-chosen keys cannot grow the map without bound.
  for (let i = 0; i < 10_050; i += 1) {
    await securityEvent('REQUEST_DENIED', { dedupeKey: `flood-${i}`, admit: () => false });
  }
  assert.ok(localDedupeSize() <= 10_000, `map size ${localDedupeSize()}`);
  assert.equal(await AuditLog.countDocuments({}), 0);

  // A repeat inside the window is still suppressed.
  resetSecurityEventLimits();
  const once = await securityEvent('REQUEST_DENIED', { dedupeKey: 'repeat', metadata: { n: 1 } });
  const twice = await securityEvent('REQUEST_DENIED', { dedupeKey: 'repeat', metadata: { n: 2 } });
  assert.ok(once);
  assert.equal(twice, null);
});

test('route patterns never include the query string', () => {
  assert.equal(
    routeOf({ method: 'GET', baseUrl: '/api/v1/users', route: { path: '/:userId' }, path: '/abc' }),
    'GET /api/v1/users/:userId',
  );
  assert.equal(routeOf({ method: 'POST', originalUrl: '/api/v1/x?token=secret', path: '', baseUrl: '' }), 'POST /api/v1/x');
  assert.equal(
    routeOf({ method: 'GET', baseUrl: '/api/v1/tenants/64b0000000000000000000aa', path: '/subscription' }),
    'GET /api/v1/tenants/:id/subscription',
  );
  // Inside a route: the mount path is the matched one (real id), the pattern names its params.
  assert.equal(
    routeOf({ method: 'PATCH', baseUrl: '/api/v1/tenants/64b0000000000000000000aa', route: { path: '/members/:userId' }, path: '/members/x' }),
    'PATCH /api/v1/tenants/:id/members/:userId',
  );
});
