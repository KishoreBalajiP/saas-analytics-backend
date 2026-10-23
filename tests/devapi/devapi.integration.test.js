/**
 * devapi package (roadmap 3.3): key lifecycle (rotation overlap, expiry
 * cap, IP allow-list), per-key rate limit, usage metering, audit noise,
 * typed errors / no 500s, list envelope and the OpenAPI reference.
 *
 * Env is set BEFORE the app loads (dynamic imports) so the per-key limit
 * and rotation overlap are small enough to observe.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { entitleTenant } from '../helpers/billing.js';

process.env.API_KEY_RATE_LIMIT_MAX = '20';
process.env.API_KEY_ROTATION_OVERLAP_MINUTES = '0.03'; // ~1.8 s
process.env.API_KEY_MAX_TTL_DAYS = '30';

const PASSWORD = 'DevApiPassword123!';
let m; // lazily imported modules

before(async () => {
  m = {
    mongo: await import('../helpers/mongo.js'),
    http: await import('../helpers/http.js'),
    email: await import('../../src/services/email.service.js'),
    tenantService: (await import('../../src/services/tenant.service.js')).default,
    tenantLifecycle: (await import('../../src/services/tenantLifecycle.service.js')).default,
    invitations: (await import('../../src/services/tenantInvitation.service.js')).default,
    connectors: (await import('../../src/repositories/connector.repository.js')).default,
    ConnectorRow: (await import('../../src/models/ConnectorRow.js')).ConnectorRow,
    AuditLog: (await import('../../src/models/AuditLog.js')).AuditLog,
    externalRoutes: (await import('../../src/routes/externalApi.routes.js')).default,
    spec: (await import('../../src/openapi/externalApi.spec.js')).buildExternalApiSpec,
  };
  await m.mongo.startMongo();
  await m.http.startHttp();
});
beforeEach(async () => { await m.mongo.resetMongo(); });
after(async () => { await m.email.close(); await m.http.stopHttp(); await m.mongo.stopMongo(); });

const api = (...args) => m.http.api(...args);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function captureInviteToken(fn) {
  const sink = [];
  m.email.captureInto(sink);
  try { await fn(); } finally { m.email.stopCapture(); }
  const link = sink.map((x) => x.text).join('\n').match(/https?:\/\/[^\s]+/u)?.[0];
  return link ? new URL(link).searchParams.get('token') : null;
}

async function login(slug, email) {
  const res = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': slug }, body: { email, password: PASSWORD } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return { authorization: `Bearer ${res.json.data.accessToken}` };
}

async function workspace() {
  const email = `owner-${randomBytes(4).toString('hex')}@example.com`;
  let result;
  const token = await captureInviteToken(async () => {
    result = await m.tenantService.create({ tenant: { name: `DevApi ${randomBytes(3).toString('hex')}` }, owner: { email, name: 'Owner' }, initialize: true, by: 'platform-admin' });
  });
  await m.invitations.accept({ token, name: 'Owner', password: PASSWORD });
  await entitleTenant(result.tenant._id);
  return { tenantId: String(result.tenant._id), slug: result.tenant.slug, auth: await login(result.tenant.slug, email) };
}

async function member(ws, roleName) {
  const email = `${roleName.toLowerCase()}-${randomBytes(4).toString('hex')}@example.com`;
  const token = await captureInviteToken(() => m.invitations.create({ tenantId: ws.tenantId, email, name: roleName, roleName, invitedBy: 'platform-admin' }));
  await m.invitations.accept({ token, name: roleName, password: PASSWORD });
  return { auth: await login(ws.slug, email) };
}

async function key(ws, body = {}) {
  const res = await api('/api/v1/api-keys', { method: 'POST', headers: ws.auth, body: { name: 'k', scopes: ['datasets:read', 'analytics:query', 'dashboards:read'], ...body } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.data;
}

const ext = (secret, path = '/datasets', opts = {}) => api(`/api/v1/external/v1${path}`, { ...opts, headers: { 'X-Api-Key': secret, ...(opts.headers ?? {}) } });

test('rotation: the old key works during the overlap window and fails after it', async () => {
  const ws = await workspace();
  const old = await key(ws);
  const rotated = await api(`/api/v1/api-keys/${old.key.id}/rotate`, { method: 'POST', headers: ws.auth, body: {} });
  assert.equal(rotated.status, 201, JSON.stringify(rotated.json));
  assert.equal(rotated.json.data.oldKeyRevoked, false);
  const fresh = rotated.json.data.secret;
  assert.equal((await ext(old.secret)).status, 200, 'old key valid during overlap');
  assert.equal((await ext(fresh)).status, 200);
  assert.equal((await api(`/api/v1/api-keys/${old.key.id}/rotate`, { method: 'POST', headers: ws.auth, body: {} })).status, 409, 'cannot rotate twice');
  await sleep(2200);
  const after = await ext(old.secret);
  assert.equal(after.status, 401);
  assert.equal(after.json.code, 'INVALID_API_KEY');
  assert.equal((await ext(fresh)).status, 200);

  const viewer = await member(ws, 'Viewer');
  assert.equal((await api(`/api/v1/api-keys/${rotated.json.data.newKey.id}/rotate`, { method: 'POST', headers: viewer.auth, body: {} })).status, 403);
  const other = await workspace();
  assert.equal((await api(`/api/v1/api-keys/${rotated.json.data.newKey.id}/rotate`, { method: 'POST', headers: other.auth, body: {} })).status, 404);
});

test('expiry cap is enforced on create and update; default expiry is within the cap', async () => {
  const ws = await workspace();
  const far = new Date(Date.now() + 60 * 86400000).toISOString();
  const tooLong = await api('/api/v1/api-keys', { method: 'POST', headers: ws.auth, body: { name: 'x', scopes: ['datasets:read'], expiresAt: far } });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.json.errors[0].field, 'expiresAt');
  const k = await key(ws);
  assert.ok(new Date(k.key.expiresAt).getTime() <= Date.now() + 30 * 86400000 + 1000, 'default TTL capped');
  assert.equal((await api(`/api/v1/api-keys/${k.key.id}`, { method: 'PATCH', headers: ws.auth, body: { expiresAt: far } })).status, 400);
  assert.equal(k.secret.startsWith(`${k.key.prefix}.`), true, 'secret is prefix.secret');
});

test('IP allow-list is enforced', async () => {
  const ws = await workspace();
  const blocked = await key(ws, { ipAllowList: ['203.0.113.0/24'] });
  const r = await ext(blocked.secret);
  assert.equal(r.status, 401);
  assert.equal(r.json.code, 'INVALID_API_KEY');
  const allowed = await key(ws, { ipAllowList: ['127.0.0.1', '::1'] });
  assert.equal((await ext(allowed.secret)).status, 200);
  assert.equal((await api('/api/v1/api-keys', { method: 'POST', headers: ws.auth, body: { name: 'x', scopes: ['datasets:read'], ipAllowList: ['not-an-ip'] } })).status, 400);
  const got = await api(`/api/v1/api-keys/${allowed.key.id}`, { headers: ws.auth });
  assert.equal(got.json.data.lastUsedIp !== undefined, true);
});

test('per-key rate limit isolates keys', async () => {
  const ws = await workspace();
  const a = await key(ws);
  const b = await key(ws);
  for (let i = 0; i < 20; i += 1) assert.equal((await ext(a.secret)).status, 200);
  const limited = await ext(a.secret);
  assert.equal(limited.status, 429);
  assert.equal(limited.json.code, 'RATE_LIMITED');
  assert.equal((await ext(b.secret)).status, 200, 'another key has its own bucket');
});

test('usage metering counts by endpoint and status', async () => {
  const ws = await workspace();
  const k = await key(ws, { scopes: ['datasets:read'] });
  await ext(k.secret);
  await ext(k.secret);
  await ext(k.secret, '/datasets/000000000000000000000000');
  await ext(k.secret, '/dashboards/000000000000000000000000'); // 403 scope
  await sleep(200);
  const usage = await api(`/api/v1/api-keys/${k.key.id}/usage?days=7`, { headers: ws.auth });
  assert.equal(usage.status, 200, JSON.stringify(usage.json));
  const by = (endpoint, status) => usage.json.data.byEndpoint.find((e) => e.endpoint === endpoint && e.status === status)?.count;
  assert.equal(by('GET /datasets', 200), 2);
  assert.equal(by('GET /datasets/:datasetId', 404), 1);
  assert.equal(by('GET /dashboards/:dashboardId', 403), 1);
  assert.equal(usage.json.data.total, 4);
  assert.equal(usage.json.data.days.length, 7);
  assert.equal(usage.json.data.days.at(-1).total, 4);
  const other = await workspace();
  assert.equal((await api(`/api/v1/api-keys/${k.key.id}/usage`, { headers: other.auth })).status, 404);
  assert.equal((await api(`/api/v1/api-keys/${k.key.id}/usage?days=500`, { headers: ws.auth })).status, 400);
});

test('reads via API key are not audited; the self-revoke mutation is', async () => {
  const ws = await workspace();
  const k = await key(ws);
  await sleep(300);
  const t0 = new Date();
  for (let i = 0; i < 3; i += 1) assert.equal((await ext(k.secret)).status, 200);
  await sleep(300);
  assert.equal(await m.AuditLog.countDocuments({ tenantId: ws.tenantId, occurredAt: { $gte: t0 } }), 0, 'GETs write no audit entries');

  const revoked = await ext(k.secret, '/keys/self', { method: 'DELETE' });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.json));
  await sleep(300);
  const rows = await m.AuditLog.find({ tenantId: ws.tenantId, occurredAt: { $gte: t0 } }).lean();
  assert.ok(rows.some((r) => r.action === 'api_key.revoked'), `mutation audited: ${rows.map((r) => r.action)}`);
  assert.equal((await ext(k.secret)).status, 401);
});

test('external list endpoints use the list envelope; tenant isolation holds', async () => {
  const a = await workspace();
  const b = await workspace();
  const connector = await m.connectors.create({ tenantId: a.tenantId, type: 'csv', name: 'Orders', status: 'active', createdBy: 'u' });
  await m.ConnectorRow.insertMany([{ tenantId: a.tenantId, connectorId: connector._id, sourceRowId: 'r1', data: { amount: 1 }, ingestedAt: new Date() }]);
  const ka = await key(a);
  const kb = await key(b);
  const list = await ext(ka.secret);
  assert.ok(Array.isArray(list.json.data));
  assert.equal(list.json.meta.total, 1);
  const rows = await ext(ka.secret, `/datasets/${connector._id}/rows`);
  assert.ok(Array.isArray(rows.json.data));
  assert.equal(rows.json.meta.total, 1);
  assert.equal((await ext(kb.secret, `/datasets/${connector._id}`)).status, 404, 'other tenant cannot read');
  assert.equal((await ext(kb.secret)).json.data.length, 0);
  // Legacy unversioned alias still works.
  assert.equal((await api('/api/v1/external/datasets', { headers: { 'X-Api-Key': ka.secret } })).status, 200);
});

test('no 500 on malformed input across the external API', async () => {
  const ws = await workspace();
  const connector = await m.connectors.create({ tenantId: ws.tenantId, type: 'csv', name: 'Orders', status: 'active', createdBy: 'u' });
  const id = String(connector._id);
  const k = await key(ws);
  const limitedScope = await key(ws, { scopes: ['datasets:read'] });
  const cases = [
    ['no key', '/datasets', {}, 401, null],
    ['garbage key', '/datasets', { 'X-Api-Key': 'nope' }, 401, 'INVALID_API_KEY'],
    ['prefix only', '/datasets', { 'X-Api-Key': 'sak_abc.' }, 401, 'INVALID_API_KEY'],
    ['bad page', '/datasets?page=-1', null, 400, null],
    ['bad limit', '/datasets?limit=abc', null, 400, null],
    ['bad dataset id', '/datasets/not-an-id', null, 404, 'NOT_FOUND'],
    ['bad rows id', '/datasets/%24where/rows', null, 404, 'NOT_FOUND'],
    ['bad rows limit', `/datasets/${id}/rows?limit=99999`, null, 400, null],
    ['bad dashboard id', '/dashboards/%7B%7D', null, 404, 'NOT_FOUND'],
    ['query bad json', `/datasets/${id}/query?metrics=%7Bnope`, null, 400, null],
    ['query unknown param', `/datasets/${id}/query?evil=1`, null, 400, null],
    ['query bad op', `/datasets/${id}/query?filters=${encodeURIComponent(JSON.stringify([{ field: 'a', op: '$where', value: 1 }]))}`, null, 400, null],
    ['query bad id', '/datasets/zzz/query', null, 404, null],
    ['scope missing', `/datasets/${id}/query`, { 'X-Api-Key': limitedScope.secret }, 403, 'INSUFFICIENT_SCOPE'],
  ];
  for (const [name, path, headers, status, code] of cases) {
    const res = await api(`/api/v1/external/v1${path}`, { headers: headers ?? { 'X-Api-Key': k.secret } });
    assert.equal(res.status, status, `${name}: ${JSON.stringify(res.json)}`);
    if (code) assert.equal(res.json.code, code, name);
    assert.ok(res.json?.code, `${name}: typed code present`);
  }
});

test('every external route is documented in the OpenAPI spec, served publicly', async () => {
  const served = await api('/api/v1/external/openapi.json');
  assert.equal(served.status, 200);
  assert.equal(served.json.openapi, '3.1.0');
  const spec = m.spec();
  for (const layer of m.externalRoutes.stack) {
    if (!layer.route) continue;
    const path = layer.route.path;
    if (path === '/openapi.json') continue;
    const oaPath = path.replace(/:([A-Za-z]+)/gu, '{$1}');
    for (const method of Object.keys(layer.route.methods)) {
      const op = spec.paths[oaPath]?.[method];
      assert.ok(op, `${method.toUpperCase()} ${path} is documented`);
      assert.ok(op.responses['200'], `${path} has a success example`);
      assert.ok(op.responses['401'], `${path} documents auth errors`);
      assert.ok(op['x-codeSamples']?.length, `${path} has an example`);
    }
  }
  const scopes = await api('/api/v1/api-keys/scopes', { headers: (await workspace()).auth });
  assert.equal(scopes.status, 200);
  assert.ok(scopes.json.data.some((s) => s.scope === 'datasets:read'));
});
