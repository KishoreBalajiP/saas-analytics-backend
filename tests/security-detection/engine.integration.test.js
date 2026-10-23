/**
 * Security detection engine (roadmap 2.6): alert lifecycle on the detector
 * side, watermarks, on-call notification, configuration and the scheduled
 * job. Real engine, repositories and in-memory MongoDB; notifications go to
 * capture sinks or the email capture sink (no network).
 */

import test, { describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import * as emailService from '../../src/services/email.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import settingService from '../../src/services/setting.service.js';
import clock from '../../src/utils/clock.js';
import { runDetection, raiseDetection } from '../../src/services/securityDetection/engine.js';
import {
  setNotificationSinks, setTargetResolver, resetNotifier,
} from '../../src/services/securityDetection/notifier.js';
import { resolveRuleConfigs, resolveNotificationTargets, validWebhookUrl } from '../../src/services/securityDetection/config.js';
import { RULES, getRule } from '../../src/services/securityDetection/rules/index.js';
import securityAlertService from '../../src/services/securityAlert.service.js';
import securityDetectionJob, { handler as jobHandler } from '../../src/jobs/securityDetection.job.js';
import { runJob, resetSchedulerForTests, getRegisteredJobs } from '../../src/jobs/scheduler.js';
import { SecurityAlert } from '../../src/models/SecurityAlert.js';
import { SecurityDetectionCursor } from '../../src/models/SecurityDetectionCursor.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { JobRun } from '../../src/models/JobRun.js';
import { T0, at, nowFor, loginAttempts } from './helpers.js';

const ADMIN = { id: '64b000000000000000000001', email: 'sec@platform.test', tenantId: null };

/** A rule that reports whatever the test queues, once per evaluation. */
function fakeRule(id, { severity = 'high', detections = [], fail = false } = {}) {
  const rule = {
    id,
    version: 3,
    title: `Fake ${id}`,
    description: 'test rule',
    source: 'test',
    severity,
    defaults: { enabled: true },
    params: {},
    calls: [],
    queue: [...detections],
    async evaluate(ctx) {
      rule.calls.push({ from: ctx.from, to: ctx.to, finalSlice: ctx.finalSlice });
      if (fail) throw new Error('boom: source unavailable');
      const out = rule.queue;
      rule.queue = [];
      return out;
    },
  };
  return rule;
}

const detection = (overrides = {}) => ({
  subject: { type: 'ip', id: '192.0.2.1', display: '192.0.2.1' },
  title: 'Something suspicious',
  summary: 'Something suspicious happened.',
  windowStart: at(-5),
  windowEnd: at(-1),
  counts: { events: 3 },
  details: { note: 'x' },
  refs: [{ source: 'login_attempt', id: 'abc', at: at(-1), label: 'evidence' }],
  ...overrides,
});

const run = (rules, now, options = {}) => runDetection({ rules, now, settingOverrides: {}, ...options });

before(async () => { await startMongo(); });
after(async () => { await emailService.close(); await stopMongo(); });
beforeEach(async () => {
  await resetMongo();
  await cacheService.flushAll?.();
  resetNotifier();
  resetSchedulerForTests();
});
afterEach(() => {
  emailService.stopCapture();
  resetNotifier();
  clock.reset();
});

describe('watermarks', () => {
  test('first run looks back the initial window; later runs continue exactly at the watermark', async () => {
    const rule = fakeRule('test.watermark');
    await run([rule], nowFor(0));
    assert.equal(rule.calls.length, 1);
    assert.deepEqual(rule.calls[0].from, at(-60));
    assert.deepEqual(rule.calls[0].to, at(0));
    assert.equal(rule.calls[0].finalSlice, true);

    await run([rule], nowFor(5));
    assert.deepEqual(rule.calls[1].from, at(0));
    assert.deepEqual(rule.calls[1].to, at(5));
    const cursor = await SecurityDetectionCursor.findById('test.watermark').lean();
    assert.deepEqual(cursor.watermark, at(5));
    assert.equal(cursor.ruleVersion, 3);

    // A run before any new events settle evaluates nothing.
    await run([rule], nowFor(5));
    assert.equal(rule.calls.length, 2);
  });

  test('long gaps are evaluated in bounded slices and capped to the catch-up limit', async () => {
    const rule = fakeRule('test.catchup');
    await SecurityDetectionCursor.create({ _id: 'test.catchup', watermark: at(-3 * 24 * 60) });
    await run([rule], nowFor(0));
    // 24 h cap, 1 h slices.
    assert.equal(rule.calls.length, 24);
    assert.deepEqual(rule.calls[0].from, at(-24 * 60));
    assert.deepEqual(rule.calls.at(-1).to, at(0));
    assert.equal(rule.calls.filter((c) => c.finalSlice).length, 1);
  });

  test('a failing rule keeps its watermark and records the error; other rules still run', async () => {
    const broken = fakeRule('test.broken', { fail: true });
    const healthy = fakeRule('test.healthy', { detections: [detection()] });
    const summary = await run([broken, healthy], nowFor(0), { notify: false });
    assert.equal(summary.failed, 1);
    assert.equal(summary.raised, 1);
    const cursor = await SecurityDetectionCursor.findById('test.broken').lean();
    assert.equal(cursor.watermark, undefined);
    assert.match(cursor.lastError, /boom/);
    const again = fakeRule('test.broken');
    await run([again], nowFor(5));
    assert.deepEqual(again.calls[0].from, at(-55), 'the failed span is evaluated again');
  });
});

describe('raising alerts', () => {
  test('creates one alert per dedupe key with rule id and version, and records a security event', async () => {
    const rule = fakeRule('test.raise', { detections: [detection()] });
    const summary = await run([rule], nowFor(0), { notify: false });
    assert.equal(summary.raised, 1);
    const [alert] = await SecurityAlert.find({}).lean();
    assert.equal(alert.ruleId, 'test.raise');
    assert.equal(alert.ruleVersion, 3);
    assert.equal(alert.status, 'open');
    assert.equal(alert.activeKey, alert.dedupeKey);
    assert.deepEqual(alert.firstSeenAt, at(-5));
    assert.deepEqual(alert.lastSeenAt, at(-1));
    const event = await AuditLog.findOne({ action: 'security.alert.raised' }).lean();
    assert.ok(event, 'SECURITY_ALERT_RAISED written');
    assert.equal(event.resourceId, String(alert._id));
  });

  test('concurrent raises of the same detection never create two active alerts', async () => {
    const rule = fakeRule('test.race');
    const now = nowFor(0);
    const results = await Promise.all(Array.from({ length: 5 }, () => raiseDetection(rule, detection(), { now, notify: false })));
    assert.equal(results.filter((r) => r.outcome === 'raised').length, 1);
    const alerts = await SecurityAlert.find({}).lean();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].occurrences, 5);
  });

  test('merging keeps the newest evidence without duplicates and never lowers severity', async () => {
    const rule = fakeRule('test.merge', { severity: 'medium' });
    await raiseDetection(rule, detection({ severity: 'high' }), { now: nowFor(0), notify: false });
    await raiseDetection(rule, detection({
      severity: 'low',
      windowStart: at(-20),
      windowEnd: at(4),
      counts: { events: 9 },
      refs: [{ source: 'login_attempt', id: 'abc', at: at(-1), label: 'evidence' }, { source: 'login_attempt', id: 'def', at: at(4), label: 'new' }],
    }), { now: nowFor(5), notify: false });
    const [alert] = await SecurityAlert.find({}).lean();
    assert.equal(alert.severity, 'high');
    assert.equal(alert.occurrences, 2);
    assert.deepEqual(alert.windowStart, at(-20));
    assert.deepEqual(alert.lastSeenAt, at(4));
    assert.equal(alert.evidence.counts.events, 9);
    assert.deepEqual(alert.evidence.refs.map((r) => r.id), ['abc', 'def']);
  });

  test('a detection closed as a false positive is suppressed for the suppression window', async () => {
    const rule = fakeRule('test.fp');
    const first = await raiseDetection(rule, detection(), { now: nowFor(0), notify: false });
    clock.set(nowFor(1));
    await securityAlertService.transition({ action: 'false_positive', id: String(first.alert._id), admin: ADMIN, note: 'load test from our office' });

    const suppressed = await raiseDetection(rule, detection(), { now: nowFor(10), notify: false });
    assert.equal(suppressed.outcome, 'suppressed');
    assert.equal(await SecurityAlert.countDocuments({}), 1);

    // After 24 h the same detection opens a new alert.
    const reopened = await raiseDetection(rule, detection(), { now: at(25 * 60), notify: false });
    assert.equal(reopened.outcome, 'raised');
    assert.equal(await SecurityAlert.countDocuments({}), 2);
  });

  test('after a resolve, the next detection opens a new alert', async () => {
    const rule = fakeRule('test.resolve');
    const first = await raiseDetection(rule, detection(), { now: nowFor(0), notify: false });
    await securityAlertService.transition({ action: 'resolve', id: String(first.alert._id), admin: ADMIN, note: 'blocked the range at the edge' });
    const second = await raiseDetection(rule, detection(), { now: nowFor(5), notify: false });
    assert.equal(second.outcome, 'raised');
    const alerts = await SecurityAlert.find({}).sort({ createdAt: 1 }).lean();
    assert.deepEqual(alerts.map((a) => a.status), ['resolved', 'open']);
    assert.equal(alerts[0].activeKey, undefined);
  });
});

describe('on-call notification', () => {
  const targets = { emails: ['oncall@example.com', 'secops@example.com'], webhookUrl: 'https://hooks.example.com/services/T000/B000/secret-path' };

  test('a high-severity alert emails on-call once through the delivery pipeline; webhook failure is recorded', async () => {
    const sink = [];
    setTargetResolver(async () => targets);
    setNotificationSinks({
      email: async ({ message, targets: resolvedTargets }) => {
        sink.push({ to: resolvedTargets.emails, subject: message.subject, text: message.text });
        return { id: 'out-1', status: 'sent' };
      },
      webhook: async () => {
        const error = new Error('webhook delivery unavailable');
        error.code = 'DELIVERY_NOT_AVAILABLE';
        throw error;
      },
    });
    const rule = fakeRule('test.notify', { detections: [detection()] });
    const summary = await run([rule], nowFor(0));
    assert.equal(summary.raised, 1);
    assert.equal(summary.notified, 1);

    assert.equal(sink.length, 1);
    assert.deepEqual(sink[0].to, targets.emails);
    assert.match(sink[0].subject, /^\[Security alert\] HIGH: Something suspicious/);
    assert.match(sink[0].text, /Rule: test\.notify \(v3\)/);
    assert.match(sink[0].text, /\/admin\/security-alerts\?alert=/);
    assert.doesNotMatch(sink[0].text, /secret-path/);
    // Rendered from the registered `security.alert_raised` template.
    assert.match(sink[0].text, /^Severity: HIGH$/m);
    // This detector run uses the platform-admin context (tenantId is null),
    // so the renderer correctly omits a tenant line for a global alert.
    assert.doesNotMatch(sink[0].text, /^Tenant: /m);

    const [alert] = await SecurityAlert.find({}).lean();
    assert.ok(alert.notifiedAt);
    const byChannel = Object.fromEntries(alert.notifications.map((n) => [n.channel, n]));
    assert.equal(byChannel.email.status, 'sent');
    assert.equal(byChannel.webhook.status, 'failed');
    assert.equal(byChannel.webhook.code, 'DELIVERY_NOT_AVAILABLE');
    assert.equal(byChannel.webhook.target, 'https://hooks.example.com', 'only the webhook origin is stored');
    assert.ok(await AuditLog.findOne({ action: 'security.alert.notification_failed', resourceId: String(alert._id) }).lean());

    // Repeated detections merge silently.
    rule.queue = [detection({ windowEnd: at(3) })];
    const again = await run([rule], nowFor(5));
    assert.equal(again.merged, 1);
    assert.equal(again.notified, 0);
    assert.equal(sink.length, 1);
  });

  test('capture sinks receive the message and the webhook payload; medium alerts do not notify', async () => {
    const calls = [];
    setTargetResolver(async () => targets);
    setNotificationSinks({
      email: async (ctx) => { calls.push({ channel: 'email', ctx }); return { id: 'out-1', status: 'queued' }; },
      webhook: async (ctx) => { calls.push({ channel: 'webhook', ctx }); return { id: 'del-1', status: 'sent' }; },
    });
    const medium = fakeRule('test.medium', { severity: 'medium', detections: [detection()] });
    const high = fakeRule('test.high', { detections: [detection({ subject: { type: 'admin', id: 'a1', display: 'root@platform.test' } })] });
    const summary = await run([medium, high], nowFor(0));
    assert.equal(summary.raised, 2);
    assert.equal(summary.notified, 1);
    assert.deepEqual(calls.map((c) => c.channel), ['email', 'webhook']);
    const payload = calls[1].ctx.payload;
    assert.equal(payload.type, 'security_alert');
    assert.equal(payload.alert.ruleId, 'test.high');
    assert.equal(payload.alert.severity, 'high');
    assert.equal(payload.alert.subject.display, 'root@platform.test');
    assert.equal(payload.alert.evidence, undefined, 'evidence rows are not sent');
    const alert = await SecurityAlert.findOne({ ruleId: 'test.high' }).lean();
    assert.deepEqual(alert.notifications.map((n) => [n.channel, n.status, n.deliveryId]), [['email', 'queued', 'out-1'], ['webhook', 'sent', 'del-1']]);
    assert.equal((await SecurityAlert.findOne({ ruleId: 'test.medium' }).lean()).notifiedAt, null);
  });

  test('an alert escalating to high severity notifies once', async () => {
    const calls = [];
    setTargetResolver(async () => ({ emails: ['oncall@example.com'], webhookUrl: null }));
    setNotificationSinks({ email: async () => { calls.push(1); return { id: null, status: 'sent' }; } });
    const rule = fakeRule('test.escalate', { severity: 'medium' });
    await raiseDetection(rule, detection(), { now: nowFor(0) });
    assert.equal(calls.length, 0);
    const escalated = await raiseDetection(rule, detection({ severity: 'critical' }), { now: nowFor(5) });
    assert.equal(escalated.notified, true);
    await raiseDetection(rule, detection({ severity: 'critical' }), { now: nowFor(6) });
    assert.equal(calls.length, 1);
    const [alert] = await SecurityAlert.find({}).lean();
    assert.equal(alert.severity, 'critical');
    assert.ok(alert.history.some((h) => h.action === 'escalated'));
    assert.ok(alert.history.some((h) => h.action === 'notified'));
  });

  test('without on-call targets the alert records a skipped notification', async () => {
    setTargetResolver(async () => ({ emails: [], webhookUrl: null }));
    await run([fakeRule('test.none', { detections: [detection()] })], nowFor(0));
    const [alert] = await SecurityAlert.find({}).lean();
    assert.equal(alert.notifications[0].status, 'skipped');
    assert.equal(alert.notifications[0].code, 'NO_TARGETS');
  });

  test('targets come from platform settings; invalid entries are dropped', async () => {
    await settingService.create({ key: 'security.alerts.emails', scope: 'platform', type: 'json', value: ['SecOps@Example.com', 'not-an-email'] });
    await settingService.create({ key: 'security.alerts.webhookUrl', scope: 'platform', type: 'string', value: 'https://hooks.example.com/abc', isSecret: true });
    const resolved = await resolveNotificationTargets();
    assert.deepEqual(resolved.emails, ['secops@example.com']);
    assert.equal(resolved.webhookUrl, 'https://hooks.example.com/abc');
    assert.equal(validWebhookUrl('ftp://hooks.example.com/x'), null);
    assert.equal(validWebhookUrl('https://user:pass@hooks.example.com/x'), null);
    assert.equal(validWebhookUrl('not a url'), null);
  });
});

describe('configuration', () => {
  test('platform setting overrides beat code defaults; invalid overrides are ignored and reported', async () => {
    await settingService.create({
      key: 'security.detection.rules',
      scope: 'platform',
      type: 'json',
      value: {
        'auth.credential_stuffing': { minFailures: 7, minAccounts: 'many' },
        'support.impersonation': { enabled: false },
      },
    });
    const configs = await resolveRuleConfigs(RULES);
    const stuffing = configs.get('auth.credential_stuffing');
    assert.equal(stuffing.config.minFailures, 7);
    assert.equal(stuffing.config.minAccounts, 10);
    assert.deepEqual(stuffing.ignored.map((i) => i.param), ['minAccounts']);
    assert.equal(configs.get('support.impersonation').config.enabled, false);

    // The engine applies them.
    await loginAttempts(Array.from({ length: 7 }, (_, i) => ({ ip: '203.0.113.5', email: `v${i}@x.test`, occurredAt: at(-5, i) })));
    const summary = await runDetection({ rules: [getRule('auth.credential_stuffing')], now: nowFor(0), notify: false });
    assert.equal(summary.raised, 0, '7 failures but only 7 accounts < 10');
  });
});

describe('scheduled job', () => {
  test('registers with the scheduler and runs every rule under the job lock, recording a JobRun', async () => {
    const registered = getRegisteredJobs().find((job) => job.name === 'security-detection');
    assert.deepEqual(registered, { name: 'security-detection', cronExpression: '*/5 * * * *', enabled: true });

    clock.set(nowFor(0));
    setTargetResolver(async () => ({ emails: [], webhookUrl: null }));
    await loginAttempts(Array.from({ length: 20 }, (_, i) => ({ ip: '203.0.113.5', email: `v${i % 10}@x.test`, occurredAt: at(-5, i) })));
    const result = await runJob(securityDetectionJob, { trigger: 'manual' });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.counts.rules, RULES.length);
    assert.equal(result.counts.failed, 0);
    assert.equal(result.counts.raised, 1);
    const jobRun = await JobRun.findOne({ job: 'security-detection' }).lean();
    assert.equal(jobRun.status, 'succeeded');
    assert.equal(jobRun.counts.raised, 1);
    assert.equal(await SecurityDetectionCursor.countDocuments({}), RULES.length);

    // The next tick only reads new events.
    clock.set(nowFor(5));
    const next = await jobHandler();
    assert.equal(next.detections, 0);
    assert.equal(await SecurityAlert.countDocuments({}), 1);
  });

  test('a tick is skipped while another instance holds the lock', async () => {
    const { getJobLock } = await import('../../src/jobs/lock.js');
    const lock = getJobLock();
    const held = await lock.acquire('job:security-detection', { owner: 'other-instance', leaseMs: 60000 });
    assert.ok(held);
    const result = await runJob(securityDetectionJob, { lock });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'locked');
    await lock.release('job:security-detection', held);
  });

  test('T0 sanity', () => {
    assert.equal(T0.getUTCHours(), 12);
  });
});
