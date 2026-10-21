/**
 * Logs never contain bearer, embed, reset or invitation tokens (roadmap 2.8;
 * findings ops.13, ops2.04, api.08).
 *
 * Every assertion is made on the CAPTURED log output (the serialised lines
 * after the logger's redaction pass, via `addLogTap`) produced by real HTTP
 * round-trips through `app.js` (morgan access line, error middleware, 404
 * handler) and by direct logger calls with secrets nested in objects and
 * text. AccessLog rows (persisted request paths) are checked too.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import { factories } from '../helpers/factories.js';
import logger from '../../src/utils/logger.js';
import { addLogTap } from '../../src/config/logger.js';
import * as accessLogService from '../../src/services/accessLog.service.js';

const BEARER = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJsZWFrLXRlc3QifQ.c2lnbmF0dXJlLXRoYXQtbXVzdC1ub3QtbGVhaw';
const OPAQUE_BEARER = 'opaque_bearer_7a6b5c4d3e2f1a0b9c8d7e6f';
const EMBED_TOKEN = 'embedtok_1f2e3d4c5b6a79880716253443526170';
const INVITE_TOKEN = 'invitetok_a1b2c3d4e5f60718293a4b5c6d7e8f90';
const RESET_TOKEN = 'resettok_0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const WEBHOOK_TOKEN = 'whtok_5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d';
const COMPLIANCE_TOKEN = 'polltok_99887766554433221100aabbccddeeff';
const SESSION_COOKIE = 'sessval_abcdef0123456789abcdef0123456789';
const SECRETS = [BEARER, OPAQUE_BEARER, EMBED_TOKEN, INVITE_TOKEN, RESET_TOKEN, WEBHOOK_TOKEN, COMPLIANCE_TOKEN, SESSION_COOKIE];

let lines = [];
let untap = null;

/** Wait for asynchronous log writes (morgan writes on response finish). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

function assertNoSecrets(label, secrets = SECRETS) {
  const output = lines.join('');
  assert.ok(output.length > 0, `${label}: expected captured log output`);
  for (const secret of secrets) {
    assert.ok(!output.includes(secret), `${label}: log output leaked ${secret}\n${output}`);
  }
}

before(async () => {
  await startMongo();
  await startHttp();
  untap = addLogTap((line) => lines.push(line));
});
beforeEach(async () => {
  await resetMongo();
  lines = [];
});
after(async () => {
  untap?.();
  await stopHttp();
  await stopMongo();
});

test('bearer tokens: rejected Authorization headers never reach the logs', async () => {
  const res = await api('/api/v1/auth/me', { headers: { authorization: `Bearer ${BEARER}` } });
  assert.equal(res.status, 401);
  const res2 = await api('/api/v1/auth/me', { headers: { authorization: `Bearer ${OPAQUE_BEARER}` } });
  assert.equal(res2.status, 401);
  // Code that logs a request object or a header line by mistake.
  logger.warn({ req: { headers: { authorization: `Bearer ${BEARER}`, cookie: `saas_session=${SESSION_COOKIE}` } } }, 'debug dump');
  logger.error(`upstream said: Authorization: Bearer ${OPAQUE_BEARER}`);
  logger.info({ context: { deeply: { nested: { accessToken: OPAQUE_BEARER, headers: { Authorization: BEARER } } } } }, 'nested');
  await settle();
  assertNoSecrets('bearer');
  assert.ok(lines.some((l) => l.includes('"http":"access"') && l.includes('/api/v1/auth/me')), 'access line written');
});

test('embed tokens: the public embed path is masked in the access line and error logs', async () => {
  const res = await api(`/api/v1/embed/${EMBED_TOKEN}`);
  assert.ok([401, 403, 404, 410].includes(res.status), `status ${res.status}`);
  // Unknown sub-path under the embed token (404 handler logs the URL too).
  await api(`/api/v1/embed/${EMBED_TOKEN}/does-not-exist`);
  await settle();
  assertNoSecrets('embed');
  const access = lines.find((l) => l.includes('"http":"access"') && l.includes('/api/v1/embed/'));
  assert.ok(access, 'embed access line written');
  assert.match(access, /\/api\/v1\/embed\/\[REDACTED\]/);
});

test('invitation tokens: ?token= in the query string is masked', async () => {
  const res = await api(`/api/v1/invitations/preview?token=${INVITE_TOKEN}`);
  assert.ok(res.status >= 400, `status ${res.status}`);
  await settle();
  assertNoSecrets('invite');
  const access = lines.find((l) => l.includes('"http":"access"') && l.includes('/invitations/preview'));
  assert.ok(access, 'invitation access line written');
  assert.match(access, /token=\[REDACTED\]/);
});

test('reset tokens: bodies, links and messages never leak them', async () => {
  const res = await api('/api/v1/auth/password/reset', {
    method: 'POST',
    body: { token: RESET_TOKEN, newPassword: 'NotARealPassword1!' },
  });
  assert.ok(res.status >= 400, `status ${res.status}`);
  logger.info({ body: { token: RESET_TOKEN, resetToken: RESET_TOKEN } }, 'reset requested');
  logger.info(`sending link https://app.example.com/reset-password?token=${RESET_TOKEN}`);
  logger.warn({ link: `https://app.example.com/login/reset?resetToken=${RESET_TOKEN}` }, 'link');
  await settle();
  assertNoSecrets('reset');
});

test('webhook path tokens and compliance poll tokens are masked', async () => {
  await api(`/api/v1/webhooks/${WEBHOOK_TOKEN}`, { method: 'POST', body: { records: [] } });
  await api(`/api/v1/compliance/public/requests/6650f1e2a3b4c5d6e7f80912?token=${COMPLIANCE_TOKEN}`);
  await settle();
  assertNoSecrets('webhook+compliance');
  assert.ok(lines.some((l) => l.includes('/api/v1/webhooks/[REDACTED]')), 'webhook access line masked');
});

test('errors logged with secrets in message, stack and properties are masked', async () => {
  const err = new Error(`connect failed mongodb://svc:${SESSION_COOKIE}@db.internal/app with Bearer ${OPAQUE_BEARER}`);
  err.config = { headers: { Authorization: `Bearer ${BEARER}` }, url: `/api/v1/embed/${EMBED_TOKEN}` };
  logger.error({ err }, 'request failed');
  logger.error(err);
  await settle();
  assertNoSecrets('errors');
});

test('AccessLog rows store the path with query tokens masked', async () => {
  const tenant = await factories.tenant.create();
  const user = await factories.user.create({ tenantId: tenant._id.toString() });
  const login = await api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenant._id.toString() },
    body: { email: user.email, password: 'Password123!' },
  });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  const token = login.json.data.accessToken;
  const me = await api(`/api/v1/auth/me?token=${INVITE_TOKEN}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.status, 200);
  await settle();
  await accessLogService.flush();
  const rows = await mongoose.model('AccessLog').find({}).lean();
  const row = rows.find((r) => String(r.path).startsWith('/api/v1/auth/me'));
  assert.ok(row, `access log row written: ${JSON.stringify(rows.map((r) => r.path))}`);
  assert.equal(row.path, '/api/v1/auth/me?token=[REDACTED]');
  // The signed-in access token itself is never logged either.
  assertNoSecrets('accesslog', [...SECRETS, token]);
});
