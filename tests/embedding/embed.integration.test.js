/**
 * Embedding package (roadmap 3.2): signed, origin-bound embed sessions,
 * locked filters, revocation/expiry, tenant suspension, preflight CORS,
 * public share links and the legacy URL-path refusal, over real HTTP.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import * as emailService from '../../src/services/email.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import tenantService from '../../src/services/tenant.service.js';
import tenantLifecycle from '../../src/services/tenantLifecycle.service.js';
import invitationService from '../../src/services/tenantInvitation.service.js';
import * as dashboardService from '../../src/services/dashboard.service.js';
import * as accessLogService from '../../src/services/accessLog.service.js';
import connectorRepository from '../../src/repositories/connector.repository.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import { EmbedToken } from '../../src/models/EmbedToken.js';
import { AccessLog } from '../../src/models/AccessLog.js';
import env from '../../src/config/env.js';

const PASSWORD = 'EmbedPassword123!';
const HOST = 'https://host.example.com';
const OTHER = 'https://evil.example.net';

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => { await resetMongo(); await cacheService.flushAll(); });
after(async () => { await emailService.close(); await stopHttp(); await stopMongo(); });

async function captureInviteToken(fn) {
  const sink = [];
  emailService.captureInto(sink);
  try { await fn(); } finally { emailService.stopCapture(); }
  const link = sink.map((m) => m.text).join('\n').match(/https?:\/\/[^\s]+/u)?.[0];
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
    result = await tenantService.create({ tenant: { name: `Embed ${randomBytes(3).toString('hex')}` }, owner: { email, name: 'Owner' }, initialize: true, by: 'platform-admin' });
  });
  await invitationService.accept({ token, name: 'Owner', password: PASSWORD });
  return { tenant: result.tenant, tenantId: String(result.tenant._id), slug: result.tenant.slug, email, auth: await login(result.tenant.slug, email) };
}

async function member(ws, roleName) {
  const email = `${roleName.toLowerCase()}-${randomBytes(4).toString('hex')}@example.com`;
  const token = await captureInviteToken(() => invitationService.create({ tenantId: ws.tenantId, email, name: roleName, roleName, invitedBy: 'platform-admin' }));
  await invitationService.accept({ token, name: roleName, password: PASSWORD });
  return { auth: await login(ws.slug, email) };
}

/** Published dashboard with one KPI widget counting rows by region. */
async function publishedDashboard(ws) {
  const dashboard = await dashboardService.createDashboard({ tenantId: ws.tenantId, name: 'Sales' });
  const connector = await connectorRepository.create({ tenantId: ws.tenantId, type: 'csv', name: 'Orders', status: 'active', createdBy: 'u1' });
  const now = new Date();
  await ConnectorRow.insertMany([
    { tenantId: ws.tenantId, connectorId: connector._id, sourceRowId: 'r1', data: { region: 'EU', amount: 1 }, ingestedAt: now },
    { tenantId: ws.tenantId, connectorId: connector._id, sourceRowId: 'r2', data: { region: 'US', amount: 2 }, ingestedAt: now },
    { tenantId: ws.tenantId, connectorId: connector._id, sourceRowId: 'r3', data: { region: 'US', amount: 3 }, ingestedAt: now },
  ]);
  const widget = await dashboardService.createWidget({
    tenantId: ws.tenantId,
    dashboardId: String(dashboard._id),
    data: { name: 'Orders', type: 'kpi', datasetId: String(connector._id), query: { metrics: [{ alias: 'total', op: 'count', field: 'amount' }] } },
  });
  await dashboardService.publishDashboard({ tenantId: ws.tenantId, dashboardId: String(dashboard._id) });
  return { dashboardId: String(dashboard._id), widgetId: String(widget._id) };
}

async function mint(ws, body) {
  return api('/api/v1/embed/tokens', { method: 'POST', headers: ws.auth, body });
}

async function session(token, origin = HOST, extra = {}) {
  return api('/api/v1/embed/public/session', { method: 'POST', headers: { origin }, body: { token, ...extra } });
}

async function view(sessionToken, origin = HOST, body = {}) {
  return api('/api/v1/embed/public/view', { method: 'POST', headers: { origin, authorization: `Bearer ${sessionToken}` }, body });
}

test('minting needs embed.create (or an API key with embed:create) and a bound origin; no allow-all', async () => {
  const ws = await workspace();
  const { dashboardId } = await publishedDashboard(ws);

  const viewer = await member(ws, 'Viewer');
  assert.equal((await mint(viewer, { dashboardId, allowedOrigins: [HOST] })).status, 403);

  const noOrigin = await mint(ws, { dashboardId });
  assert.equal(noOrigin.status, 400, 'no origin on token or tenant config is refused');
  assert.equal((await mint(ws, { dashboardId, allowedOrigins: ['*'] })).status, 400);
  assert.equal((await mint(ws, { dashboardId, allowedOrigins: ['http://insecure.example.com'] })).status, 400);

  const ok = await mint(ws, { dashboardId, allowedOrigins: [HOST], ttlSec: 600 });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.data.secret.split('.').length, 3, 'signed JWT');
  assert.deepEqual(ok.json.data.token.allowedOrigins, [HOST]);

  // API key mint: needs the embed:create scope.
  const readKey = await api('/api/v1/api-keys', { method: 'POST', headers: ws.auth, body: { name: 'r', scopes: ['datasets:read'] } });
  const embedKey = await api('/api/v1/api-keys', { method: 'POST', headers: ws.auth, body: { name: 'e', scopes: ['embed:create'] } });
  assert.equal(embedKey.status, 201, JSON.stringify(embedKey.json));
  const viaRead = await api('/api/v1/embed/api/tokens', { method: 'POST', headers: { 'X-Api-Key': readKey.json.data.secret }, body: { dashboardId, allowedOrigins: [HOST] } });
  assert.equal(viaRead.status, 401);
  const viaKey = await api('/api/v1/embed/api/tokens', { method: 'POST', headers: { 'X-Api-Key': embedKey.json.data.secret }, body: { dashboardId, allowedOrigins: [HOST] } });
  assert.equal(viaKey.status, 201, JSON.stringify(viaKey.json));

  // Tenant isolation: another tenant cannot mint for this dashboard or see its tokens.
  const other = await workspace();
  assert.equal((await mint(other, { dashboardId, allowedOrigins: [HOST] })).status, 404);
  assert.equal((await api('/api/v1/embed/tokens', { headers: other.auth })).json.data.length, 0);
  assert.equal((await api(`/api/v1/embed/tokens/${ok.json.data.token.id}`, { headers: other.auth })).status, 404);
});

test('workspace embed config: origins become the default binding and the ceiling for token origins', async () => {
  const ws = await workspace();
  const { dashboardId } = await publishedDashboard(ws);
  const viewer = await member(ws, 'Viewer');
  assert.equal((await api('/api/v1/embed/config', { method: 'PUT', headers: viewer.auth, body: { allowedOrigins: [HOST] } })).status, 403);
  assert.equal((await api('/api/v1/embed/config', { method: 'PUT', headers: ws.auth, body: { allowedOrigins: ['nope'] } })).status, 400);
  const put = await api('/api/v1/embed/config', { method: 'PUT', headers: ws.auth, body: { allowedOrigins: [HOST], defaultTheme: 'dark' } });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.deepEqual(put.json.data, { allowedOrigins: [HOST], defaultTheme: 'dark' });

  const inherited = await mint(ws, { dashboardId });
  assert.equal(inherited.status, 201);
  assert.deepEqual(inherited.json.data.token.allowedOrigins, [HOST]);
  assert.equal(inherited.json.data.token.theme, 'dark');
  assert.equal((await mint(ws, { dashboardId, allowedOrigins: [OTHER] })).status, 400, 'outside the workspace allow-list');
});

test('origin binding: the handshake and view are refused from another origin', async () => {
  const ws = await workspace();
  const { dashboardId } = await publishedDashboard(ws);
  const { secret } = (await mint(ws, { dashboardId, allowedOrigins: [HOST] })).json.data;

  const bad = await session(secret, OTHER);
  assert.equal(bad.status, 403);
  assert.equal(bad.json.code, 'EMBED_ORIGIN_NOT_ALLOWED');
  assert.equal((await api('/api/v1/embed/public/session', { method: 'POST', body: { token: secret } })).status, 403, 'no Origin');

  const ok = await session(secret);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const { sessionToken } = ok.json.data;
  assert.equal((await view(sessionToken, OTHER)).status, 403);
  const rendered = await view(sessionToken);
  assert.equal(rendered.status, 200, JSON.stringify(rendered.json));
  assert.equal(rendered.json.data.dashboard.name, 'Sales');
  assert.equal(rendered.json.data.widgets[0].result.rows[0].total, 3);

  // Through the Analivo embed page: Origin is the platform frontend and the
  // bound origin is the browser-verified parent origin.
  const platform = env.cors.origins[0];
  assert.equal((await session(secret, platform, { parentOrigin: OTHER })).status, 403);
  const framed = await session(secret, platform, { parentOrigin: HOST });
  assert.equal(framed.status, 200);
  assert.equal((await view(framed.json.data.sessionToken, platform, { parentOrigin: HOST })).status, 200);

  // A tampered token is refused.
  assert.equal((await session(`${secret}x`)).status, 401);
});

test('locked filters and params are applied server-side and cannot be overridden by the viewer', async () => {
  const ws = await workspace();
  const { dashboardId } = await publishedDashboard(ws);
  const lockedFilters = { filters: [{ field: 'region', op: 'eq', value: 'US' }], filtersOp: 'and' };
  const { secret } = (await mint(ws, { dashboardId, allowedOrigins: [HOST], lockedFilters })).json.data;
  const { sessionToken } = (await session(secret)).json.data;

  assert.equal((await view(sessionToken)).json.data.widgets[0].result.rows[0].total, 2, 'locked to US');
  const widen = await view(sessionToken, HOST, { filters: { filters: [{ field: 'region', op: 'eq', value: 'EU' }], filtersOp: 'or' } });
  assert.equal(widen.status, 200, JSON.stringify(widen.json));
  const rows = widen.json.data.widgets[0].result.rows;
  assert.ok(rows.length === 0 || rows[0].total === 0, 'viewer filter only narrows (US AND EU = nothing)');
  const bad = await view(sessionToken, HOST, { filters: { filters: [{ field: 'region', op: '$where', value: 1 }] } });
  assert.equal(bad.status, 400, 'malformed viewer filter is a typed 400');

  const p = (await mint(ws, { dashboardId, allowedOrigins: [HOST], params: { region: 'EU' } })).json.data;
  const s2 = (await session(p.secret)).json.data.sessionToken;
  assert.equal((await view(s2)).json.data.widgets[0].result.rows[0].total, 1, 'row-level param');
});

test('revoked and expired tokens are refused; suspension revokes tokens', async () => {
  const ws = await workspace();
  const { dashboardId } = await publishedDashboard(ws);
  const a = (await mint(ws, { dashboardId, allowedOrigins: [HOST] })).json.data;
  const { sessionToken } = (await session(a.secret)).json.data;

  assert.equal((await api(`/api/v1/embed/tokens/${a.token.id}/revoke`, { method: 'POST', headers: ws.auth, body: {} })).status, 200);
  assert.equal((await session(a.secret)).status, 401);
  assert.equal((await view(sessionToken)).status, 401, 'existing sessions die with the token');

  const b = (await mint(ws, { dashboardId, allowedOrigins: [HOST] })).json.data;
  await EmbedToken.updateOne({ _id: b.token.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await session(b.secret)).status, 401);

  const c = (await mint(ws, { dashboardId, allowedOrigins: [HOST] })).json.data;
  await tenantLifecycle.suspend({ tenantId: ws.tenantId, reason: 'test', by: 'platform-admin' });
  assert.equal((await session(c.secret)).status, 401);
  await tenantLifecycle.restore({ tenantId: ws.tenantId, reason: 'test', by: 'platform-admin' });
  assert.equal((await session(c.secret)).status, 401, 'stays revoked after restore');
  assert.equal((await EmbedToken.findById(c.token.id).lean()).status, 'revoked');
});

test('legacy URL-path tokens are refused and embed tokens never reach the access log', async () => {
  const ws = await workspace();
  const { dashboardId } = await publishedDashboard(ws);
  const { secret } = (await mint(ws, { dashboardId, allowedOrigins: [HOST] })).json.data;
  const legacy = await api(`/api/v1/embed/${'a'.repeat(43)}`);
  assert.equal(legacy.status, 410);
  assert.equal(legacy.json.code, 'EMBED_TOKEN_MIGRATED');

  const { sessionToken } = (await session(secret)).json.data;
  await view(sessionToken);
  await accessLogService.flush();
  const rows = await AccessLog.find({}).lean();
  assert.ok(rows.length > 0, 'authenticated traffic was logged');
  const dump = JSON.stringify(rows);
  assert.equal(dump.includes(secret), false, 'embed token absent');
  assert.equal(dump.includes(sessionToken), false, 'session token absent');
});

test('preflight returns CORS headers only for allowed origins', async () => {
  const ws = await workspace();
  const { dashboardId } = await publishedDashboard(ws);
  await mint(ws, { dashboardId, allowedOrigins: [HOST] });
  const pre = (origin) => api('/api/v1/embed/public/session', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' } });

  const good = await pre(HOST);
  assert.equal(good.status, 204);
  assert.equal(good.headers.get('access-control-allow-origin'), HOST);
  assert.match(good.headers.get('access-control-allow-methods'), /POST/u);
  assert.equal(good.headers.get('access-control-allow-credentials'), null, 'no credentials on embeds');

  const badPre = await pre(OTHER);
  assert.equal(badPre.status, 204);
  assert.equal(badPre.headers.get('access-control-allow-origin'), null);
});

test('public share link: allow-listed payload, revocable, expiring', async () => {
  const ws = await workspace();
  const { dashboardId, widgetId } = await publishedDashboard(ws);
  const viewer = await member(ws, 'Viewer');
  assert.equal((await api('/api/v1/embed/shares', { method: 'POST', headers: viewer.auth, body: { dashboardId } })).status, 403);

  const created = await api('/api/v1/embed/shares', { method: 'POST', headers: ws.auth, body: { dashboardId, ttlSec: 3600 } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const { secret, token } = created.json.data;

  const shown = await api('/api/v1/embed/public/share', { method: 'POST', body: { secret } });
  assert.equal(shown.status, 200, JSON.stringify(shown.json));
  const data = shown.json.data;
  assert.deepEqual(Object.keys(data).sort(), ['dashboard', 'widgets']);
  assert.deepEqual(Object.keys(data.dashboard).sort(), ['description', 'name']);
  assert.deepEqual(Object.keys(data.widgets[0]).sort(), ['key', 'name', 'result', 'status', 'type']);
  assert.deepEqual(Object.keys(data.widgets[0].result).sort(), ['columns', 'rows', 'total']);
  const dump = JSON.stringify(data);
  for (const id of [dashboardId, widgetId, ws.tenantId]) assert.equal(dump.includes(id), false, 'no internal ids');

  // A share secret is not an embed token and vice versa.
  assert.equal((await session(secret)).status, 401);

  await api(`/api/v1/embed/tokens/${token.id}/revoke`, { method: 'POST', headers: ws.auth, body: {} });
  assert.equal((await api('/api/v1/embed/public/share', { method: 'POST', body: { secret } })).status, 404);

  const s2 = (await api('/api/v1/embed/shares', { method: 'POST', headers: ws.auth, body: { dashboardId } })).json.data;
  await EmbedToken.updateOne({ _id: s2.token.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await api('/api/v1/embed/public/share', { method: 'POST', body: { secret: s2.secret } })).status, 404);
});
