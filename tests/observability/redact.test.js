/**
 * Secret redaction helpers (roadmap 2.8; findings ops.13, ops2.04, api.08).
 *
 * Pure unit tests for `src/utils/redact.js`: URL masking (embed / webhook
 * path tokens, sensitive query values), text masking (bearer tokens, JWTs,
 * URI passwords, session cookies) and deep key masking.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { redactUrl, redactString, redactDeep, isSensitiveKey, REDACTED } from '../../src/utils/redact.js';

const EMBED_TOKEN = 'emb_9f8e7d6c5b4a39281706f5e4d3c2b1a0';
const INVITE_TOKEN = 'inv_0a1b2c3d4e5f60718293a4b5c6d7e8f9';
const RESET_TOKEN = 'rst_5c6d7e8f90a1b2c3d4e5f60718293a4b';
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

test('redactUrl masks the public embed token path segment but not the management surface', () => {
  assert.equal(redactUrl(`/api/v1/embed/${EMBED_TOKEN}`), `/api/v1/embed/${REDACTED}`);
  assert.equal(redactUrl(`/api/v1/embed/${EMBED_TOKEN}?x=1`), `/api/v1/embed/${REDACTED}?x=1`);
  assert.equal(redactUrl('/api/v1/embed/tokens'), '/api/v1/embed/tokens');
  assert.equal(redactUrl('/api/v1/embed/tokens/6650f1e2a3b4c5d6e7f80912/revoke'), '/api/v1/embed/tokens/6650f1e2a3b4c5d6e7f80912/revoke');
});

test('redactUrl masks webhook path tokens and sensitive query values only', () => {
  assert.equal(redactUrl('/api/v1/webhooks/whk_secret_123456'), `/api/v1/webhooks/${REDACTED}`);
  assert.equal(
    redactUrl(`/api/v1/invitations/preview?token=${INVITE_TOKEN}&lang=en`),
    `/api/v1/invitations/preview?token=${REDACTED}&lang=en`,
  );
  assert.equal(
    redactUrl(`/reset?resetToken=${RESET_TOKEN}&page=2&access_token=abc&X-Amz-Signature=deadbeef`),
    `/reset?resetToken=${REDACTED}&page=2&access_token=${REDACTED}&X-Amz-Signature=${REDACTED}`,
  );
  assert.equal(redactUrl('/api/v1/connectors?page=2&limit=20'), '/api/v1/connectors?page=2&limit=20');
});

test('redactUrl masks URI credentials, JWT path segments and fragments', () => {
  assert.equal(redactUrl('https://user:pa55@host.example/x'), `https://${REDACTED}@host.example/x`);
  assert.equal(redactUrl(`/verify/${JWT}`), `/verify/${REDACTED}`);
  assert.equal(redactUrl('https://app.example/cb#access_token=abc'), `https://app.example/cb#${REDACTED}`);
  assert.equal(redactUrl(''), '');
  assert.equal(redactUrl(undefined), undefined);
});

test('redactString masks credentials inside free text and serialised JSON', () => {
  const text = [
    `Authorization: Bearer ${'a'.repeat(40)}`,
    `jwt ${JWT}`,
    `GET /api/v1/embed/${EMBED_TOKEN} 200`,
    `GET /api/v1/invitations/preview?token=${INVITE_TOKEN} 200`,
    'mongodb://admin:hunter2@db.internal:27017/app',
    'cookie saas_session=0123456789abcdef0123',
  ].join('\n');
  const out = redactString(text);
  for (const secret of ['a'.repeat(40), JWT, EMBED_TOKEN, INVITE_TOKEN, 'hunter2', '0123456789abcdef0123']) {
    assert.ok(!out.includes(secret), `leaked ${secret}`);
  }
  // A serialised log line stays valid JSON after masking.
  const line = JSON.stringify({ msg: `GET /api/v1/embed/${EMBED_TOKEN}?token=${INVITE_TOKEN}`, code: 'NOT_FOUND' });
  const parsed = JSON.parse(redactString(line));
  assert.equal(parsed.code, 'NOT_FOUND');
  assert.ok(!parsed.msg.includes(EMBED_TOKEN) && !parsed.msg.includes(INVITE_TOKEN));
});

test('route templates (`:param`) are not mistaken for tokens', () => {
  assert.equal(redactUrl('/api/v1/embed/:token'), '/api/v1/embed/:token');
  assert.equal(redactString('route /api/v1/webhooks/:webhookToken failed'), 'route /api/v1/webhooks/:webhookToken failed');
});

test('redactString keeps prose and stack traces readable', () => {
  assert.equal(redactString('Basic authentication failed for user'), 'Basic authentication failed for user');
  const stack = 'at handler (/app/src/modules/embed/embed.service.js:10:5)';
  assert.equal(redactString(stack), stack);
});

test('isSensitiveKey matches credential keys regardless of case and separators', () => {
  for (const key of ['authorization', 'Cookie', 'set-cookie', 'password', 'newPassword', 'resetToken', 'x-api-key', 'api_key', 'webhookSecret', 'totpCode', 'recoveryCodes']) {
    assert.equal(isSensitiveKey(key), true, key);
  }
  // `hasPassword` IS a sensitive key; redactDeep keeps its boolean value.
  for (const key of ['tokenHash', 'apiKeyPrefix', 'code', 'status', 'idempotencyKeyScope']) {
    assert.equal(isSensitiveKey(key), false, key);
  }
});

test('redactDeep masks sensitive keys at any depth without mutating the input', () => {
  const input = {
    req: { headers: { authorization: `Bearer ${JWT}`, cookie: 'saas_session=abcdef0123456789', accept: 'json' } },
    body: { email: 'a@b.co', password: 'Secret123!', nested: [{ resetToken: RESET_TOKEN }] },
    flags: { hasPassword: true },
    message: `failed for /embed/${EMBED_TOKEN}`,
  };
  const out = redactDeep(input);
  assert.equal(out.req.headers.authorization, REDACTED);
  assert.equal(out.req.headers.cookie, REDACTED);
  assert.equal(out.req.headers.accept, 'json');
  assert.equal(out.body.password, REDACTED);
  assert.equal(out.body.nested[0].resetToken, REDACTED);
  assert.equal(out.flags.hasPassword, true);
  assert.ok(!out.message.includes(EMBED_TOKEN));
  assert.equal(input.body.password, 'Secret123!', 'input untouched');

  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  assert.equal(redactDeep(cyclic).self, '[Circular]');
  const err = Object.assign(new Error(`boom ${JWT}`), { token: 'x'.repeat(20) });
  const redactedErr = redactDeep({ err }).err;
  assert.equal(redactedErr.token, REDACTED);
  assert.ok(!redactedErr.message.includes(JWT));
});

test('redaction stays linear on large log lines (no catastrophic backtracking)', async () => {
  const { redactSecrets } = await import('../../src/utils/sanitizeError.js');
  const inputs = [
    'a'.repeat(200000),
    'a.b-c_d'.repeat(30000),
    JSON.stringify({ msg: 'x', data: 'Q'.repeat(200000) }),
    'http://a:b@'.repeat(10000),
    'sessionsid'.repeat(20000),
  ];
  const started = Date.now();
  for (const input of inputs) {
    redactString(input);
    redactUrl(input);
    redactSecrets(input);
  }
  // Each of these took seconds to minutes with unbounded quantifiers.
  assert.ok(Date.now() - started < 2000, `redaction took ${Date.now() - started} ms`);
  // Bounded patterns still mask realistic credentials.
  assert.equal(redactString('mongodb+srv://svc:p4ssw0rd@cluster0.example.net/app'), `mongodb+srv://svc:${REDACTED}@cluster0.example.net/app`);
  assert.equal(redactString('cookie: saas_admin_session=0123456789abcdef'), `cookie: saas_admin_session=${REDACTED}`);
});
