/**
 * Email outbox (roadmap 2.7; email outbox contract, findings ops.12 /
 * doc.10): durable OutboundEmail records drained by the email job.
 *
 * Exit criteria covered here: the outbox retries with exponential backoff,
 * dead-letters after the maximum attempts, and never double-sends with the
 * same idempotency key (nor across concurrent drains).
 *
 * Transport doubles are injected (`sender`) or the email service capture
 * sink is used; nothing leaves the process.
 */

import test, { describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import env from '../../src/config/env.js';
import outboxService, { computeBackoffMs, maskEmail } from '../../src/services/outbox.service.js';
import * as emailService from '../../src/services/email.service.js';
import outboxRepository from '../../src/repositories/outboundEmail.repository.js';
import emailJob from '../../src/jobs/email.job.js';
import { OutboundEmail } from '../../src/models/OutboundEmail.js';

const NOW = new Date('2030-02-01T10:00:00.000Z');
const at = (ms) => new Date(NOW.getTime() + ms);
const RESET_URL = 'https://app.example.com/reset-password?token=very-secret-token';

/** Transport double: fails the first `fail` calls, then accepts. */
function fakeSender({ fail = 0, error, reject = false } = {}) {
  const sent = [];
  let calls = 0;
  const fn = async (envelope) => {
    calls += 1;
    if (calls <= fail) {
      throw error ?? Object.assign(
        new Error('connect ETIMEDOUT smtp://mailer:hunter2@mail.example.com:587 password=hunter2'),
        { code: 'SEND_FAILED' },
      );
    }
    if (reject) return { messageId: envelope.messageId, accepted: [], rejected: envelope.to };
    sent.push(envelope);
    return { messageId: envelope.messageId, accepted: envelope.to, rejected: [] };
  };
  fn.sent = sent;
  fn.calls = () => calls;
  return fn;
}

const enqueueReset = (overrides = {}) => outboxService.enqueueEmail({
  tenantId: 't1',
  to: 'Person@Example.com',
  template: 'auth.password_reset',
  variables: { resetUrl: RESET_URL, expiresIn: '15 minutes' },
  idempotencyKey: `reset:${Math.random()}`,
  ...overrides,
});

before(async () => {
  await startMongo();
});

after(async () => {
  outboxService.resetOutboxStateForTests();
  emailService.stopCapture();
  await stopMongo();
});

beforeEach(async () => {
  await resetMongo();
  outboxService.resetOutboxStateForTests();
  outboxService.setDispatchOnEnqueue(false);
});

afterEach(() => {
  emailService.stopCapture();
  outboxService.setDispatchOnEnqueue(false);
});

describe('enqueue', () => {
  test('rejects unknown templates, bad recipients and bad variables without storing anything', async () => {
    const cases = [
      { template: 'no-such-template' },
      { to: 'not-an-email' },
      { to: [] },
      { to: Array.from({ length: 51 }, (_, i) => `u${i}@example.com`) },
      { variables: { expiresIn: '15 minutes' } }, // resetUrl missing
      { variables: { resetUrl: { nested: true } } },
      { idempotencyKey: 'x'.repeat(201) },
      { attachments: [{ filename: '../etc/passwd', storageKey: 'a' }] },
    ];
    for (const overrides of cases) {
      await assert.rejects(() => enqueueReset(overrides), (err) => err.statusCode === 400, JSON.stringify(overrides).slice(0, 80));
    }
    assert.equal(await OutboundEmail.countDocuments({}), 0);
  });

  test('returns { id, status } and keeps the variables encrypted until the message is sent', async () => {
    const result = await enqueueReset({ idempotencyKey: 'reset:1' });
    assert.deepEqual(Object.keys(result).sort(), ['id', 'status']);
    assert.equal(result.status, 'pending');

    const row = await OutboundEmail.findById(result.id).lean();
    assert.deepEqual(row.to, ['person@example.com']);
    assert.ok(row.variablesEnc.startsWith('enc:'));
    assert.ok(!row.variablesEnc.includes('very-secret-token'), 'no plaintext variables at rest');
    assert.equal(row.attempts, 0);

    const sender = fakeSender();
    const counts = await outboxService.drainOutbox({ now: NOW, sender, owner: 'w1' });
    assert.deepEqual(counts, { claimed: 1, sent: 1, retried: 0, deadLettered: 0 });
    assert.equal(sender.sent.length, 1);
    assert.match(sender.sent[0].text, /very-secret-token/);
    assert.equal(sender.sent[0].subject, 'Reset your password');
    assert.match(sender.sent[0].messageId, new RegExp(`^<outbox\\.${result.id}@`));

    const sent = await OutboundEmail.findById(result.id).lean();
    assert.equal(sent.status, 'sent');
    assert.equal(sent.variablesEnc, null, 'variables dropped once sent');
    assert.equal(sent.attempts, 1);
    assert.ok(sent.sentAt);
  });
});

describe('retries and dead letters', () => {
  test('a failing send is retried with exponential backoff and dead-lettered after the maximum attempts', async () => {
    const { id } = await enqueueReset();
    const sender = fakeSender({ fail: 1000 });
    const max = env.outbox.maxAttempts;
    let now = NOW;
    for (let attempt = 1; attempt <= max; attempt += 1) {
      const counts = await outboxService.drainOutbox({ now, sender, owner: 'w1' });
      assert.equal(counts.claimed, 1, `attempt ${attempt} is claimed when due`);
      const row = await OutboundEmail.findById(id).lean();
      assert.equal(row.attempts, attempt);
      assert.equal(row.lastError.code, 'SEND_FAILED');
      assert.ok(!row.lastError.message.includes('hunter2'), 'credentials are redacted from the stored error');
      if (attempt < max) {
        assert.equal(row.status, 'retrying');
        const backoff = row.nextAttemptAt.getTime() - now.getTime();
        assert.equal(backoff, computeBackoffMs(attempt));
        assert.equal(backoff, Math.min(env.outbox.backoffMaxMs, env.outbox.backoffBaseMs * 2 ** (attempt - 1)));
        // Not due yet: a drain just before the backoff ends claims nothing.
        const early = await outboxService.drainOutbox({ now: new Date(row.nextAttemptAt.getTime() - 1), sender, owner: 'w1' });
        assert.equal(early.claimed, 0);
        now = row.nextAttemptAt;
      } else {
        assert.equal(row.status, 'dead');
        assert.ok(row.deadAt);
        assert.equal(counts.deadLettered, 1);
      }
    }
    assert.equal(sender.calls(), max);
    const after = await outboxService.drainOutbox({ now: at(30 * 24 * 60 * 60 * 1000), sender, owner: 'w1' });
    assert.equal(after.claimed, 0, 'a dead letter is never picked up again');
  });

  test('a transient failure is retried and the message is sent exactly once', async () => {
    const { id } = await enqueueReset();
    const sender = fakeSender({ fail: 1 });
    assert.equal((await outboxService.drainOutbox({ now: NOW, sender, owner: 'w1' })).retried, 1);
    assert.equal((await outboxService.drainOutbox({ now: at(env.outbox.backoffBaseMs), sender, owner: 'w1' })).sent, 1);
    assert.equal(sender.sent.length, 1);
    const row = await OutboundEmail.findById(id).lean();
    assert.equal(row.status, 'sent');
    assert.equal(row.attempts, 2);
    assert.equal(row.lastError, null);
  });

  test('a permanent failure (every recipient rejected) is dead-lettered at once', async () => {
    const { id } = await enqueueReset();
    const counts = await outboxService.drainOutbox({ now: NOW, sender: fakeSender({ reject: true }), owner: 'w1' });
    assert.equal(counts.deadLettered, 1);
    const row = await OutboundEmail.findById(id).lean();
    assert.equal(row.status, 'dead');
    assert.equal(row.attempts, 1);
    assert.equal(row.lastError.code, 'RECIPIENT_REJECTED');
  });

  test('backoff is capped', () => {
    assert.equal(computeBackoffMs(1, { baseMs: 1000, maxMs: 5000 }), 1000);
    assert.equal(computeBackoffMs(3, { baseMs: 1000, maxMs: 5000 }), 4000);
    assert.equal(computeBackoffMs(10, { baseMs: 1000, maxMs: 5000 }), 5000);
  });
});

describe('idempotency and concurrency', () => {
  test('the same idempotency key never creates or sends a second message', async () => {
    const first = await enqueueReset({ idempotencyKey: 'alert:evt1:a@example.com' });
    const second = await enqueueReset({ idempotencyKey: 'alert:evt1:a@example.com' });
    assert.equal(second.id, first.id);
    assert.equal(second.duplicate, true);
    assert.equal(await OutboundEmail.countDocuments({}), 1);

    const sender = fakeSender();
    await outboxService.drainOutbox({ now: NOW, sender, owner: 'w1' });
    const third = await enqueueReset({ idempotencyKey: 'alert:evt1:a@example.com' });
    assert.equal(third.id, first.id);
    assert.equal(third.status, 'sent');
    await outboxService.drainOutbox({ now: at(60 * 60 * 1000), sender, owner: 'w1' });
    assert.equal(sender.sent.length, 1, 'sent once');

    // The key is scoped per tenant: another tenant's message is separate.
    const other = await enqueueReset({ tenantId: 't2', idempotencyKey: 'alert:evt1:a@example.com' });
    assert.notEqual(other.id, first.id);
  });

  test('concurrent enqueues with one key create one message', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => enqueueReset({ idempotencyKey: 'race:1' })));
    assert.equal(new Set(results.map((r) => r.id)).size, 1);
    assert.equal(await OutboundEmail.countDocuments({}), 1);
  });

  test('concurrent drains never send a message twice', async () => {
    for (let i = 0; i < 12; i += 1) await enqueueReset({ to: `user${i}@example.com` });
    const sender = fakeSender();
    const results = await Promise.all(['a', 'b', 'c'].map((owner) => outboxService.drainOutbox({ now: NOW, sender, owner })));
    assert.equal(results.reduce((n, r) => n + r.claimed, 0), 12);
    assert.equal(sender.sent.length, 12);
    assert.equal(new Set(sender.sent.map((m) => m.messageId)).size, 12, 'each message sent once');
    assert.equal(await OutboundEmail.countDocuments({ status: 'sent' }), 12);
  });

  test('an expired lease is reclaimed and the stale claim can no longer record its outcome', async () => {
    const { id } = await enqueueReset();
    const stale = await outboxRepository.claimNext({ now: NOW, owner: 'crashed', leaseMs: 1000, id });
    assert.ok(stale);
    assert.equal((await outboxService.drainOutbox({ now: at(500), sender: fakeSender(), owner: 'w2' })).claimed, 0, 'lease still held');

    const sender = fakeSender();
    const counts = await outboxService.drainOutbox({ now: at(2000), sender, owner: 'w2' });
    assert.equal(counts.sent, 1);
    const late = await outboxRepository.markRetry(id, { nextAttemptAt: at(60000), error: { code: 'X', message: 'late' }, lockToken: stale.lockedBy });
    assert.equal(late, null, 'the stale claimer cannot overwrite the outcome');
    const row = await OutboundEmail.findById(id).lean();
    assert.equal(row.status, 'sent');
    assert.equal(row.attempts, 2);
  });
});

describe('send paths', () => {
  test('sendNow delivers within the call; a repeat with the same key does not resend', async () => {
    const sink = [];
    emailService.captureInto(sink);
    const first = await outboxService.sendNow({
      to: 'owner@example.com',
      template: 'auth.email_verification',
      variables: { name: 'Ada', verificationUrl: 'https://app.example.com/register?token=abc', expiresIn: '15 minutes' },
      idempotencyKey: 'email-verification:rec1',
    });
    assert.equal(first.status, 'sent');
    assert.equal(first.delivered, true);
    assert.equal(sink.length, 1);
    assert.match(sink[0].text, /Hi Ada/);

    const again = await outboxService.sendNow({
      to: 'owner@example.com',
      template: 'auth.email_verification',
      variables: { name: 'Ada', verificationUrl: 'https://app.example.com/register?token=abc' },
      idempotencyKey: 'email-verification:rec1',
    });
    assert.equal(again.duplicate, true);
    assert.equal(again.delivered, true);
    assert.equal(sink.length, 1, 'no second send');
  });

  test('dispatch-on-enqueue sends without waiting for the job', async () => {
    const sink = [];
    emailService.captureInto(sink);
    outboxService.setDispatchOnEnqueue(true);
    const { id } = await outboxService.enqueueEmail({
      tenantId: 't1',
      to: 'ops@example.com',
      template: 'alert.triggered',
      variables: { alertName: 'Revenue drop', message: 'Revenue fell 20%' },
      idempotencyKey: 'alert:evt9:ops@example.com',
    });
    const deadline = Date.now() + 3000;
    let row;
    do {
      await new Promise((r) => setTimeout(r, 20));
      row = await OutboundEmail.findById(id).lean();
    } while (row.status !== 'sent' && Date.now() < deadline);
    assert.equal(row.status, 'sent');
    assert.equal(row.transport, 'capture');
    assert.equal(sink.length, 1);
    assert.equal(sink[0].subject, 'Alert triggered: Revenue drop');
  });

  test('the email job drains the outbox and returns counts', async () => {
    assert.equal(emailJob.enabled, true, 'the outbox drain runs by default');
    assert.equal(emailJob.cronExpression, '* * * * *');
    const sink = [];
    emailService.captureInto(sink);
    await enqueueReset();
    await enqueueReset({ to: 'second@example.com' });
    const counts = await emailJob.handler({ instanceId: 'w-test' });
    assert.deepEqual(counts, { claimed: 2, sent: 2, retried: 0, deadLettered: 0 });
    assert.equal(sink.length, 2);
  });
});

describe('operations', () => {
  test('a dead letter can be requeued with a fresh budget; other states cannot', async () => {
    const { id } = await enqueueReset({ tenantId: 't1' });
    await outboxService.drainOutbox({ now: NOW, sender: fakeSender({ reject: true }), owner: 'w1' });

    await assert.rejects(() => outboxService.requeueDeadMessage({ id, scopeTenantId: 't2' }), (err) => err.statusCode === 404, 'other tenant scope');
    await assert.rejects(() => outboxService.requeueDeadMessage({ id: 'not-an-id' }), (err) => err.statusCode === 404);

    const view = await outboxService.requeueDeadMessage({ id, actor: { type: 'admin', id: 'a1' } });
    assert.equal(view.status, 'pending');
    assert.equal(view.attempts, 0);
    await assert.rejects(() => outboxService.requeueDeadMessage({ id }), (err) => err.statusCode === 409);

    const sender = fakeSender();
    await outboxService.drainOutbox({ now: at(1000), sender, owner: 'w1' });
    assert.equal(sender.sent.length, 1);
  });

  test('listing masks recipients, never returns variables and honours the tenant scope', async () => {
    await enqueueReset({ tenantId: 't1', to: 'alice@example.com' });
    await enqueueReset({ tenantId: 't2', to: 'bob@example.com' });
    const all = await outboxService.listMessages({});
    assert.equal(all.total, 2);
    for (const doc of all.docs) {
      assert.equal(doc.variablesEnc, undefined);
      assert.ok(doc.to.every((addr) => addr.includes('***')));
    }
    assert.ok(all.docs.some((d) => d.to[0] === 'al***@example.com'));
    const scoped = await outboxService.listMessages({ tenantId: 't2', scopeTenantId: 't1' });
    assert.equal(scoped.total, 1);
    assert.equal(scoped.docs[0].tenantId, 't1');
    await assert.rejects(() => outboxService.listMessages({ status: 'bogus' }), (err) => err.statusCode === 400);
    assert.equal(maskEmail('x@example.com'), 'x***@example.com');
  });

  test('health reports the transport, backlog and dead letters', async () => {
    await enqueueReset();
    const { id } = await enqueueReset();
    await OutboundEmail.updateOne({ _id: id }, { $set: { status: 'dead' } });
    const health = await outboxService.getOutboxHealth({ now: at(20 * 60 * 1000) });
    assert.equal(health.transport, 'noop');
    assert.equal(health.status, 'disabled', 'no transport configured: mail is not delivered');
    assert.equal(health.outbox.pending, 1);
    assert.equal(health.outbox.dead, 1);
    assert.equal(health.outbox.backlog, 1);
    assert.ok(health.outbox.backlogAgeMs >= 20 * 60 * 1000 - 5000);
    assert.equal(health.settings.maxAttempts, env.outbox.maxAttempts);
  });
});
