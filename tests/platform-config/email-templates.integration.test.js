/**
 * Email templates over HTTP (roadmap 2.4, ADM:config-501): permissions,
 * variable validation, preview rendering without sending, history and
 * rollback, and the email service using the stored override with a
 * fallback to the built-in template.
 */

import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import emailService from '../../src/services/email.service.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { onboardTenant, adminWith } from './helpers.js';

const VIEW = 'email_templates.view';
const UPDATE = 'email_templates.update';
const RESET_KEY = 'auth.password_reset';

let sent = [];
before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => {
  await resetMongo();
  await rbacCache.clearAll();
  await cacheService.flushAll();
  sent = [];
  emailService.captureInto(sent);
});
afterEach(() => emailService.stopCapture());
after(async () => { await stopHttp(); await stopMongo(); });

const save = (key, headers, body) => api(`/api/v1/email-templates/${key}`, { method: 'PUT', headers, body });
const good = {
  subject: 'Choose a new password',
  text: 'Hello! Reset here: {{ resetUrl }} (valid {{expiresIn}}).',
  html: '<p>Reset here: <a href="{{resetUrl}}">{{resetUrl}}</a></p>',
};

test('each endpoint enforces its permission; scoped admins and workspace tokens are refused', async () => {
  const { tenantId, headers: ownerHeaders } = await onboardTenant();
  const nobody = await adminWith([]);
  const viewer = await adminWith([VIEW]);
  const scoped = await adminWith([VIEW, UPDATE], { tenantScope: tenantId });

  assert.equal((await api('/api/v1/email-templates', { headers: nobody.headers })).status, 403);
  assert.equal((await api(`/api/v1/email-templates/${RESET_KEY}`, { headers: nobody.headers })).status, 403);
  assert.equal((await api(`/api/v1/email-templates/${RESET_KEY}/preview`, { method: 'POST', headers: nobody.headers, body: {} })).status, 403);
  assert.equal((await api(`/api/v1/email-templates/${RESET_KEY}/history`, { headers: nobody.headers })).status, 403);
  assert.equal((await api('/api/v1/email-templates', { headers: viewer.headers })).status, 200);
  assert.equal((await save(RESET_KEY, viewer.headers, good)).status, 403);
  assert.equal((await api(`/api/v1/email-templates/${RESET_KEY}/reset`, { method: 'POST', headers: viewer.headers, body: {} })).status, 403);
  assert.equal((await api(`/api/v1/email-templates/${RESET_KEY}/rollback`, { method: 'POST', headers: viewer.headers, body: { toVersion: 0 } })).status, 403);
  const scopedRes = await api('/api/v1/email-templates', { headers: scoped.headers });
  assert.equal(scopedRes.status, 403);
  assert.equal(scopedRes.json.code, 'ADMIN_SCOPE_DENIED');
  assert.equal((await api('/api/v1/email-templates', { headers: ownerHeaders })).status, 401);
  assert.equal((await api('/api/v1/email-templates')).status, 401);
});

test('list and detail expose the built-ins with their variable contract', async () => {
  const { headers } = await adminWith([VIEW]);
  const list = await api('/api/v1/email-templates', { headers });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.data.map((t) => t.key).sort(), [
    'admin.invitation',
    'admin.password_reset_by_admin',
    'alert.triggered',
    'auth.email_verification',
    'auth.password_reset',
    'billing.payment_overdue',
    'billing.renewal_reminder',
    'billing.trial_ending',
    'report.delivered',
    'security.alert_raised',
    'tenant.data_export_ready',
    'tenant.invitation',
  ]);
  assert.ok(list.json.data.every((t) => t.customized === false && t.version === 0));
  const detail = await api(`/api/v1/email-templates/${RESET_KEY}`, { headers });
  assert.equal(detail.json.data.builtIn.subject, 'Reset your password');
  assert.ok(detail.json.data.variables.find((v) => v.key === 'resetUrl').required);
  assert.equal(detail.json.data.override, null);
  assert.equal((await api('/api/v1/email-templates/auth.unknown', { headers })).status, 404);
  assert.equal((await api(`/api/v1/email-templates/${RESET_KEY}?locale=xx`, { headers })).status, 422);
});

test('edits are validated against the variable contract and the HTML safety rules', async () => {
  const { headers } = await adminWith([VIEW, UPDATE]);
  const cases = [
    [{ ...good, text: 'Reset: {{ resetUrl }} {{ secretToken }}' }, 'text', /unknown variable/],
    [{ ...good, text: 'Reset your password soon.' }, 'text', /required variable "\{\{resetUrl\}\}"/],
    [{ ...good, text: 'Reset: {{ reset Url }} {{resetUrl}}' }, 'text', /not a valid placeholder/],
    [{ ...good, text: 'Reset: {{resetUrl}} and {{ unclosed' }, 'text', /unclosed/],
    [{ ...good, html: '<p>{{resetUrl}}</p><script>alert(1)</script>' }, 'html', /script/],
    [{ ...good, html: '<a href="javascript:alert(1)">{{resetUrl}}</a>' }, 'html', /javascript/],
    [{ ...good, html: '<img src=x onerror="x()">{{resetUrl}}' }, 'html', /event handlers/],
    [{ ...good, html: '<p>No link here</p>' }, 'html', /required variable/],
    [{ ...good, subject: 'Line one\nLine two' }, 'subject', /single line/],
    [{ ...good, subject: 'Hi {{ name }}' }, 'subject', /unknown variable/],
    [{ ...good, subject: '   ' }, 'subject', /required/],
  ];
  for (const [body, field, message] of cases) {
    const res = await save(RESET_KEY, headers, body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} -> ${res.status} ${JSON.stringify(res.json)}`);
    assert.equal(res.json.code, 'EMAIL_TEMPLATE_INVALID');
    assert.ok(res.json.errors.some((e) => e.field === field && message.test(e.message)), `${field} ${message}: ${JSON.stringify(res.json.errors)}`);
  }
  assert.equal((await save(RESET_KEY, headers, { text: 'x {{resetUrl}}' })).status, 422, 'subject is required');
  assert.equal((await save('auth.unknown', headers, good)).status, 404);
  const detail = await api(`/api/v1/email-templates/${RESET_KEY}`, { headers });
  assert.equal(detail.json.data.customized, false, 'nothing was stored');
});

test('preview renders sample data, drafts and overrides without sending anything', async () => {
  const { headers } = await adminWith([VIEW, UPDATE]);
  const builtIn = await api(`/api/v1/email-templates/${RESET_KEY}/preview`, { method: 'POST', headers, body: {} });
  assert.equal(builtIn.status, 200);
  assert.equal(builtIn.json.data.source, 'built_in');
  assert.equal(builtIn.json.data.subject, 'Reset your password');
  assert.match(builtIn.json.data.text, /https:\/\/app\.example\.com\/login\/reset\?token=sample-token/);
  assert.match(builtIn.json.data.text, /expires in 1 hour/);

  const draft = await api(`/api/v1/email-templates/${RESET_KEY}/preview`, {
    method: 'POST',
    headers,
    body: { draft: good, variables: { resetUrl: 'https://x.test/r?a=1&b=<2>' } },
  });
  assert.equal(draft.status, 200, JSON.stringify(draft.json));
  assert.equal(draft.json.data.source, 'draft');
  assert.equal(draft.json.data.subject, 'Choose a new password');
  assert.match(draft.json.data.text, /Reset here: https:\/\/x\.test\/r\?a=1&b=<2> \(valid 1 hour\)/);
  assert.equal(draft.json.data.html, '<p>Reset here: <a href="https://x.test/r?a=1&amp;b=&lt;2&gt;">https://x.test/r?a=1&amp;b=&lt;2&gt;</a></p>', 'values are HTML-escaped');

  const badDraft = await api(`/api/v1/email-templates/${RESET_KEY}/preview`, { method: 'POST', headers, body: { draft: { ...good, text: 'no link' } } });
  assert.equal(badDraft.status, 400);
  const badVariable = await api(`/api/v1/email-templates/${RESET_KEY}/preview`, { method: 'POST', headers, body: { variables: { nope: 'x' } } });
  assert.equal(badVariable.status, 400);
  assert.ok(badVariable.json.errors.some((e) => e.field === 'variables.nope'));

  await save(RESET_KEY, headers, good);
  const saved = await api(`/api/v1/email-templates/${RESET_KEY}/preview`, { method: 'POST', headers, body: {} });
  assert.equal(saved.json.data.source, 'override');
  assert.equal(saved.json.data.subject, 'Choose a new password');
  assert.equal(sent.length, 0, 'previews never send email');
});

test('the email service sends the stored override and falls back to the built-in', async () => {
  const { headers } = await adminWith([VIEW, UPDATE]);
  const variables = { resetUrl: 'https://app.test/login/reset?token=abc' };

  await emailService.sendTemplate({ to: 'a@example.com', template: RESET_KEY, variables });
  assert.equal(sent.at(-1).subject, 'Reset your password', 'built-in before any override');
  assert.match(sent.at(-1).text, /token=abc/);

  const saved = await save(RESET_KEY, headers, { ...good, reason: 'friendlier copy' });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.data.customized, true);
  assert.equal(saved.json.data.version, 1);
  await emailService.sendTemplate({ to: 'a@example.com', template: RESET_KEY, variables });
  assert.equal(sent.at(-1).subject, 'Choose a new password', 'override used immediately (cache invalidated)');
  assert.equal(sent.at(-1).text, 'Hello! Reset here: https://app.test/login/reset?token=abc (valid 15 minutes).');
  assert.match(sent.at(-1).html, /href="https:\/\/app\.test\/login\/reset\?token=abc"/);

  // A locale without its own override uses the English override, then the built-in.
  await emailService.sendTemplate({ to: 'a@example.com', template: RESET_KEY, variables, locale: 'de' });
  assert.equal(sent.at(-1).subject, 'Choose a new password');

  // Real call site: the password reset flow renders through the override.
  const { tenantId, email } = await onboardTenant();
  const forgot = await api('/api/v1/auth/password/forgot', { method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email } });
  assert.equal(forgot.status, 200);
  const resetMail = sent.findLast((m) => [].concat(m.to).includes(email));
  assert.ok(resetMail, 'the reset email was sent');
  assert.equal(resetMail.subject, 'Choose a new password');
  assert.match(resetMail.text, /^Hello! Reset here: http\S+\/login\/reset\?token=\S+ \(valid [^)]+\)\.$/);

  const reset = await api(`/api/v1/email-templates/${RESET_KEY}/reset`, { method: 'POST', headers, body: { version: 1 } });
  assert.equal(reset.status, 200);
  assert.equal(reset.json.data.customized, false);
  await emailService.sendTemplate({ to: 'a@example.com', template: RESET_KEY, variables });
  assert.equal(sent.at(-1).subject, 'Reset your password', 'back on the built-in');

  // Missing required variables are refused before anything is sent.
  const before = sent.length;
  await assert.rejects(
    () => emailService.sendTemplate({ to: 'a@example.com', template: RESET_KEY, variables: {} }),
    (err) => err.code === 'TEMPLATE_INVALID' && /resetUrl/.test(err.message),
  );
  await assert.rejects(() => emailService.sendTemplate({ to: 'a@example.com', template: 'auth.nope' }), (err) => err.code === 'TEMPLATE_INVALID');
  assert.equal(sent.length, before);
});

test('history and rollback restore the exact prior template; stale versions conflict; audited without bodies', async () => {
  const { headers, admin } = await adminWith([VIEW, UPDATE]);
  const first = await save(RESET_KEY, headers, good);
  assert.equal(first.json.data.version, 1);
  const second = await save(RESET_KEY, headers, { subject: 'Second', text: 'Second {{resetUrl}}', version: 1 });
  assert.equal(second.json.data.version, 2);
  const stale = await save(RESET_KEY, headers, { subject: 'Third', text: 'Third {{resetUrl}}', version: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'VERSION_CONFLICT');

  const history = await api(`/api/v1/email-templates/${RESET_KEY}/history`, { headers });
  assert.deepEqual(history.json.data.map((r) => [r.version, r.action]), [[2, 'update'], [1, 'update'], [0, 'baseline']]);
  assert.deepEqual(history.json.data[1].state, { customized: true, ...good });
  assert.deepEqual(history.json.data[2].state, { customized: false, subject: null, text: null, html: null });

  const rolled = await api(`/api/v1/email-templates/${RESET_KEY}/rollback`, { method: 'POST', headers, body: { toVersion: 1, version: 2 } });
  assert.equal(rolled.status, 200, JSON.stringify(rolled.json));
  assert.deepEqual(rolled.json.data.override, good);
  assert.equal(rolled.json.data.version, 3);

  const toBuiltIn = await api(`/api/v1/email-templates/${RESET_KEY}/rollback`, { method: 'POST', headers, body: { toVersion: 0 } });
  assert.equal(toBuiltIn.json.data.customized, false);
  assert.equal(toBuiltIn.json.data.effective.subject, 'Reset your password');

  // Locales are versioned independently.
  const german = await save(RESET_KEY, headers, { ...good, locale: 'de', subject: 'Passwort zurücksetzen' });
  assert.equal(german.json.data.version, 1);
  assert.equal(german.json.data.locale, 'de');
  const english = await api(`/api/v1/email-templates/${RESET_KEY}`, { headers });
  assert.equal(english.json.data.customized, false);

  const audits = await AuditLog.find({ module: 'platform.email_templates' }).sort({ _id: 1 }).lean();
  assert.deepEqual(audits.map((a) => a.action), [
    'email_template.updated', 'email_template.updated', 'email_template.rolled_back', 'email_template.rolled_back', 'email_template.updated',
  ]);
  assert.equal(audits[0].actorId, String(admin._id));
  assert.equal(audits[0].after.subject, 'Choose a new password');
  assert.ok(!JSON.stringify(audits).includes('Hello! Reset here'), 'bodies are not copied into the audit trail');
});
