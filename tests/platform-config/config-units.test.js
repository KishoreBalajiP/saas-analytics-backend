/**
 * Unit tests for the platform configuration building blocks (roadmap 2.4):
 * per-key setting rules, flag evaluation, template placeholder validation
 * and rendering, and secret presentation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSettingValue, SETTING_RULES } from '../../src/services/settingRules.js';
import { DEFAULT_SETTINGS } from '../../src/services/tenantSettings.service.js';
import { bucketOf, explainFlag, evaluateFlag } from '../../src/services/featureFlag.service.js';
import { extractPlaceholders, validateContent } from '../../src/services/emailTemplate.service.js';
import { getBuiltInTemplate, listBuiltInTemplates, registerBuiltInTemplate } from '../../src/templates/emails/index.js';
import { redactSetting } from '../../src/services/setting.service.js';

const def = (key) => DEFAULT_SETTINGS.find((setting) => setting.key === key);

test('every catalogue default passes its own rule (the seed is always valid)', () => {
  for (const definition of DEFAULT_SETTINGS) {
    assert.doesNotThrow(() => validateSettingValue(definition, definition.value), definition.key);
  }
  for (const key of Object.keys(SETTING_RULES)) {
    assert.ok(def(key), `rule ${key} belongs to a catalogue key`);
  }
});

test('setting rules normalise valid values and reject invalid ones with a field error', () => {
  const ok = [
    ['localization.timezone', 'europe/berlin', 'Europe/Berlin'],
    ['localization.locale', 'en-gb', 'en-GB'],
    ['localization.currency', 'inr', 'INR'],
    ['localization.date_format', 'DD/MM/YYYY', 'DD/MM/YYYY'],
    ['branding.primary_color', '#ABC', '#abc'],
    ['branding.logo_url', 'https://cdn.example.com/logo.png', 'https://cdn.example.com/logo.png'],
    ['email.smtp_host', 'SMTP.Example.com', 'smtp.example.com'],
    ['email.smtp_port', '465', 465],
    ['email.smtp_password', '  spaced secret  ', '  spaced secret  '],
    ['security.mfa_required', 'true', true],
    ['security.session_ttl', 3_600_000, 3_600_000],
    ['general.contact_email', ' Ops@Example.com ', 'ops@example.com'],
  ];
  for (const [key, input, expected] of ok) {
    assert.deepEqual(validateSettingValue(def(key), input), expected, key);
  }
  const bad = [
    ['localization.locale', 'not a locale'],
    ['localization.date_format', 'YYYY-YYYY-DD'],
    ['branding.logo_url', 'https://user:pass@example.com/logo.png'],
    ['branding.logo_url', 'javascript:alert(1)'],
    ['email.smtp_host', 'bad host!'],
    ['email.smtp_port', 0],
    ['email.smtp_port', 1.5],
    ['email.smtp_user', 'line\nbreak'],
    ['general.maintenance_notice', 'bell\u0007'],
    ['security.session_ttl', -1],
    ['security.mfa_required', 1],
    ['general.contact_email', null],
  ];
  for (const [key, input] of bad) {
    assert.throws(
      () => validateSettingValue(def(key), input),
      (err) => err.statusCode === 400 && err.errors.some((e) => e.field === key),
      `${key}=${JSON.stringify(input)}`,
    );
  }
  assert.throws(() => validateSettingValue({ key: 'x.json', type: 'json' }, '{bad'), (err) => err.statusCode === 400);
  assert.deepEqual(validateSettingValue({ key: 'x.json', type: 'json' }, '{"a":1}'), { a: 1 });
});

test('flag evaluation explains every outcome and is deterministic per (flag, tenant)', () => {
  const tenant = '0123456789abcdef01234567';
  assert.deepEqual(explainFlag({ key: 'a.b', enabled: false, rollout: { strategy: 'all' } }, tenant), { value: false, reason: 'disabled' });
  assert.deepEqual(explainFlag({ key: 'a.b', enabled: true, rollout: { strategy: 'all' } }, tenant), { value: true, reason: 'all' });
  assert.deepEqual(explainFlag({ key: 'a.b', enabled: true, rollout: { strategy: 'tenantId', tenantIds: [tenant] } }, tenant), { value: true, reason: 'allow_list' });
  assert.deepEqual(explainFlag({ key: 'a.b', enabled: true, rollout: { strategy: 'tenantId', tenantIds: [] } }, tenant), { value: false, reason: 'not_in_allow_list' });
  assert.deepEqual(explainFlag({ key: 'a.b', enabled: true, rollout: { strategy: 'attribute' } }, tenant), { value: false, reason: 'unsupported_strategy' });
  assert.deepEqual(explainFlag({ key: 'a.b', enabled: true, rollout: { strategy: 'percentage', percentage: 50 } }, null), { value: false, reason: 'no_tenant' });

  const bucket = bucketOf('a.b', tenant);
  assert.ok(bucket >= 0 && bucket < 100);
  assert.equal(bucketOf('a.b', tenant), bucket, 'stable');
  const at = (percentage) => evaluateFlag({ key: 'a.b', enabled: true, rollout: { strategy: 'percentage', percentage } }, tenant);
  assert.equal(at(bucket), false, 'bucket == percentage is out');
  assert.equal(at(bucket + 1), true, 'bucket < percentage is in');
  assert.equal(at(0), false);
  assert.equal(at(100), true);
  // Different flags bucket the same tenant independently.
  const distinct = new Set(Array.from({ length: 20 }, (_, i) => bucketOf(`flag.n${i}`, tenant)));
  assert.ok(distinct.size > 5);
});

test('placeholders: names, malformed tokens and stray braces', () => {
  const { names, errors } = extractPlaceholders('Hi {{ name }}, {{name}} {{ url}}');
  assert.deepEqual([...names].sort(), ['name', 'url']);
  assert.deepEqual(errors, []);
  assert.equal(extractPlaceholders('{{ a b }}').errors.length, 1);
  assert.equal(extractPlaceholders('{{ 1abc }}').errors.length, 1);
  assert.equal(extractPlaceholders('open {{ name').errors.length, 1);
  assert.equal(extractPlaceholders('close }}').errors.length, 1);
  assert.equal(extractPlaceholders('{{{name}}}').errors.length, 1);
});

test('template content validation follows the built-in variable contract', () => {
  const invitation = getBuiltInTemplate('tenant.invitation');
  assert.deepEqual(
    validateContent(invitation, { subject: ' Join {{tenantName}} ', text: 'Join {{tenantName}}: {{acceptUrl}}', html: '' }),
    { subject: 'Join {{tenantName}}', text: 'Join {{tenantName}}: {{acceptUrl}}', html: null },
  );
  assert.throws(
    () => validateContent(invitation, { subject: 'x', text: 'Join {{acceptUrl}}' }),
    (err) => err.statusCode === 400 && err.errors.some((e) => e.field === 'text' && /tenantName/.test(e.message)),
  );
  assert.throws(
    () => validateContent(invitation, { subject: 'x', text: '{{tenantName}} {{acceptUrl}}', html: 42 }),
    (err) => err.errors.some((e) => e.field === 'html'),
  );
  assert.throws(
    () => validateContent(invitation, { subject: 'x', text: '{{tenantName}} {{acceptUrl}}'.padEnd(20_001, 'x') }),
    (err) => err.errors.some((e) => e.field === 'text' && /at most/.test(e.message)),
  );
});

test('every built-in template is valid against its own contract; registrations are checked', () => {
  for (const template of listBuiltInTemplates()) {
    assert.doesNotThrow(() => validateContent(template, template), template.key);
  }
  assert.throws(() => registerBuiltInTemplate({ key: 'Bad Key', name: 'x', subject: 'x', text: 'x' }));
  assert.throws(() => registerBuiltInTemplate({ key: 'a.b', name: 'x', subject: 'x' }));
  assert.throws(() => registerBuiltInTemplate({ key: 'a.b', name: 'x', subject: 'x', text: 'x', variables: [{ key: '1bad' }] }));
});

test('secret presentation strips the envelope and masks the value', () => {
  const row = { key: 'email.smtp_password', isSecret: true, value: '', secret: 'v1.envelope' };
  const out = redactSetting(row, false);
  assert.equal(out.value, null);
  assert.equal(out.redacted, true);
  assert.equal(out.hasValue, true);
  assert.equal('secret' in out, false);
  assert.equal('secret' in redactSetting(row, true), false, 'the envelope never leaves, even for privileged callers');
  assert.equal(row.secret, 'v1.envelope', 'input not mutated');
});
