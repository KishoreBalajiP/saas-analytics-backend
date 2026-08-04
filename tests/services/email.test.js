/**
 * Tests for `services/email.service.js`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as emailService from '../../src/services/email.service.js';

test('send routes through the noop transport when mail is disabled', async () => {
  const sink = [];
  emailService.captureInto(sink);
  const result = await emailService.send({
    to: 'user@example.com',
    subject: 'Hello',
    text: 'Welcome',
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(typeof result.messageId, 'string');
  assert.equal(sink.length, 1);
  assert.equal(sink[0].subject, 'Hello');
  emailService.stopCapture();
});

test('send rejects missing fields', async () => {
  await assert.rejects(
    () => emailService.send({ to: 'a@b.c' }),
    /requires `subject`/,
  );
  await assert.rejects(
    () => emailService.send({ subject: 'x' }),
    /requires `to`/,
  );
  await assert.rejects(
    () => emailService.send({ to: 'a@b.c', subject: 'x' }),
    /requires `text` or `html`/,
  );
});

test('sendMany returns sent + failed buckets', async () => {
  emailService.captureInto([]);
  const out = await emailService.sendMany([
    { to: 'a@b.c', subject: 'ok', text: 'x' },
    { to: null, subject: 'fail' }, // invalid
    { to: 'c@d.e', subject: 'ok2', html: '<p>y</p>' },
  ]);
  assert.equal(out.sent.length, 2);
  assert.equal(out.failed.length, 1);
  emailService.stopCapture();
});
