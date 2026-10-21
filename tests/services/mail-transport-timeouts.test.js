/**
 * SMTP timeouts (roadmap 2.7, finding ops2.12): the SMTP transport is built
 * with bounded connection / greeting / socket timeouts, and the transport
 * check behind the mail health probe cannot hang.
 *
 * No SMTP connection is opened: options are asserted on the builder and the
 * verify path runs against a stubbed transport.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import env from '../../src/config/env.js';
import { buildSmtpOptions } from '../../src/services/mail.transport.js';
import * as emailService from '../../src/services/email.service.js';
import { listBuiltInTemplates, getBuiltInTemplate } from '../../src/templates/emails/index.js';

test('SMTP transport options carry bounded timeouts from the environment', () => {
  const options = buildSmtpOptions(env.mail);
  assert.equal(options.connectionTimeout, env.mail.connectionTimeoutMs);
  assert.equal(options.greetingTimeout, env.mail.greetingTimeoutMs);
  assert.equal(options.socketTimeout, env.mail.socketTimeoutMs);
  // Defaults: seconds, not nodemailer's multi-minute defaults.
  assert.equal(env.mail.connectionTimeoutMs, 10000);
  assert.equal(env.mail.greetingTimeoutMs, 10000);
  assert.equal(env.mail.socketTimeoutMs, 20000);
  for (const value of [options.connectionTimeout, options.greetingTimeout, options.socketTimeout]) {
    assert.ok(Number.isInteger(value) && value > 0 && value <= 60000);
  }
});

test('custom timeouts and credentials pass through; no auth block without credentials', () => {
  const options = buildSmtpOptions({
    host: 'smtp.example.com', port: 465, secure: true, user: 'u', password: 'p',
    connectionTimeoutMs: 1500, greetingTimeoutMs: 2500, socketTimeoutMs: 3500,
  });
  assert.equal(options.connectionTimeout, 1500);
  assert.equal(options.greetingTimeout, 2500);
  assert.equal(options.socketTimeout, 3500);
  assert.deepEqual(options.auth, { user: 'u', pass: 'p' });
  assert.equal(buildSmtpOptions({ host: 'h', port: 25 }).auth, undefined);
  assert.equal(buildSmtpOptions({ host: 'h', port: 25 }).connectionTimeout, 10000, 'falls back to a bounded default');
});

test('verify() gives up after its timeout instead of hanging', async () => {
  const transport = emailService.getTransport();
  const original = transport.verify;
  transport.verify = () => new Promise(() => {});
  try {
    const started = Date.now();
    await assert.rejects(() => emailService.verify({ timeoutMs: 50 }), (err) => err.code === 'VERIFY_TIMEOUT');
    assert.ok(Date.now() - started < 2000);
  } finally {
    transport.verify = original;
  }
});

test('every outbox email is a registered built-in template whose required variables appear in it', () => {
  // The outbox renders through the platform template service (admin override
  // or built-in); rendering itself is covered by the outbox integration tests.
  const keys = new Set(listBuiltInTemplates().map((t) => t.key));
  for (const key of ['auth.password_reset', 'auth.email_verification', 'tenant.invitation', 'alert.triggered', 'admin.invitation', 'admin.password_reset_by_admin']) {
    assert.ok(keys.has(key), `${key} is registered`);
    const template = getBuiltInTemplate(key);
    for (const variable of template.variables.filter((v) => v.required)) {
      const placeholder = `{{${variable.key}}}`;
      assert.ok(template.subject.includes(placeholder) || template.text.includes(placeholder), `${key} uses ${variable.key}`);
    }
  }
});
