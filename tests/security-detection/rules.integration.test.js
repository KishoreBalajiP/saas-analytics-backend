/**
 * Security detection rules (roadmap 2.6, document 11 section 4): every rule
 * replayed over a synthetic event stream through the real engine and an
 * in-memory MongoDB.
 *
 * For each rule: it fires at its threshold and not below; repeated
 * detections for the same subject merge into ONE active alert (dedupe);
 * and a second run does not re-evaluate events behind the watermark.
 */

import test, { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { getRule } from '../../src/services/securityDetection/rules/index.js';
import { defaultSources } from '../../src/services/securityDetection/engine.js';
import { User } from '../../src/models/User.js';
import { Admin } from '../../src/models/Admin.js';
import { ApiKey } from '../../src/models/ApiKey.js';
import {
  T0, at, nowFor, loginAttempts, auditEvents, accessRows, auditExports, failedSyncRuns, signals,
  runRule, alertsFor, cursorFor,
} from './helpers.js';

const oid = () => new mongoose.Types.ObjectId().toString();
const LAG = { lagMinutes: 2 };

before(async () => { await startMongo(); });
after(async () => { await stopMongo(); });
beforeEach(async () => { await resetMongo(); });

/** `count` failed sign-ins from `ip` for `accounts` distinct emails, `stepSec` apart from `startMinute`. */
function stuffing(ip, count, accounts, startMinute, stepSec = 20) {
  return Array.from({ length: count }, (_, i) => ({
    ip,
    email: `victim${i % accounts}@example.com`,
    tenantId: 'tenant-a',
    occurredAt: at(startMinute, i * stepSec),
  }));
}

describe('auth.credential_stuffing', () => {
  const rule = getRule('auth.credential_stuffing');

  test('fires at 20 failures across 10 accounts from one IP within 15 minutes, not below', async () => {
    await loginAttempts([
      ...stuffing('198.51.100.1', 19, 10, -10), // one failure short
      ...stuffing('198.51.100.2', 20, 9, -10), // one account short
      ...stuffing('198.51.100.3', 20, 10, -10), // at the threshold
      ...stuffing('198.51.100.4', 20, 10, -40, 90), // spread over 30 minutes
    ]);
    const summary = await runRule(rule, nowFor(0));
    assert.equal(summary.raised, 1);
    const [alert] = await alertsFor(rule.id);
    assert.equal(alert.subject.type, 'ip');
    assert.equal(alert.subject.id, '198.51.100.3');
    assert.equal(alert.severity, 'high');
    assert.equal(alert.status, 'open');
    assert.equal(alert.ruleVersion, 1);
    assert.equal(alert.evidence.counts.failures, 20);
    assert.equal(alert.evidence.counts.accounts, 10);
    assert.equal(alert.evidence.details.ipRange, '198.51.100.0/24');
    assert.ok(alert.evidence.refs.length > 0 && alert.evidence.refs.length <= 20);
    assert.ok(alert.evidence.refs.every((r) => r.source === 'login_attempt' && r.id));
    assert.equal(alert.dedupeKey, 'auth.credential_stuffing|ip:198.51.100.3');
  });

  test('a second run does not reprocess; a new failure merges into the same alert', async () => {
    await loginAttempts(stuffing('198.51.100.3', 20, 10, -4, 10));
    await runRule(rule, nowFor(0));
    assert.deepEqual((await cursorFor(rule.id)).watermark, at(0));

    const again = await runRule(rule, nowFor(5));
    assert.equal(again.detections, 0);
    let [alert] = await alertsFor(rule.id);
    assert.equal(alert.occurrences, 1);
    assert.deepEqual((await cursorFor(rule.id)).watermark, at(5));

    // Still inside the 15-minute window of the earlier burst: 21 failures.
    await loginAttempts(stuffing('198.51.100.3', 1, 1, 7));
    const merged = await runRule(rule, nowFor(10));
    assert.equal(merged.merged, 1);
    const alerts = await alertsFor(rule.id);
    assert.equal(alerts.length, 1, 'no duplicate active alert for the same IP');
    [alert] = alerts;
    assert.equal(alert.occurrences, 2);
    assert.equal(alert.evidence.counts.failures, 21);
    assert.deepEqual(alert.lastSeenAt, at(7));
    assert.ok(alert.history.some((h) => h.action === 'merged'));
  });

  test('thresholds are configurable per rule', async () => {
    await loginAttempts(stuffing('198.51.100.9', 6, 3, -5));
    assert.equal((await runRule(rule, nowFor(0))).raised, 0);
    await resetMongo();
    await loginAttempts(stuffing('198.51.100.9', 6, 3, -5));
    const summary = await runRule(rule, nowFor(0), { overrides: { minFailures: 6, minAccounts: 3 } });
    assert.equal(summary.raised, 1);
  });

  test('a disabled rule evaluates nothing', async () => {
    await loginAttempts(stuffing('198.51.100.3', 20, 10, -10));
    const summary = await runRule(rule, nowFor(0), { overrides: { enabled: false } });
    assert.equal(summary.disabled, 1);
    assert.equal((await alertsFor(rule.id)).length, 0);
    assert.equal(await cursorFor(rule.id), null);
  });
});

describe('auth.admin_failed_logins', () => {
  const rule = getRule('auth.admin_failed_logins');
  const admin = (actorId, count, startMinute, extra = {}) => Array.from({ length: count }, (_, i) => ({
    actorId, actorType: 'admin', email: `${actorId ?? 'nobody'}@platform.test`, occurredAt: at(startMinute, i * 30), ...extra,
  }));

  test('fires at 5 failures on one admin account within 15 minutes, not below or for non-admins', async () => {
    const y = oid();
    await loginAttempts([
      ...admin(oid(), 4, -10),
      ...admin(y, 4, -10),
      ...admin(y, 1, -6, { reason: 'account_locked', ip: '192.0.2.10' }),
      ...admin(null, 10, -10, { reason: 'unknown_email' }),
      ...Array.from({ length: 10 }, (_, i) => ({ actorId: oid(), actorType: 'user', email: 'u@x.test', occurredAt: at(-10, i) })),
    ]);
    const summary = await runRule(rule, nowFor(0));
    assert.equal(summary.raised, 1);
    const [alert] = await alertsFor(rule.id);
    assert.equal(alert.subject.type, 'admin');
    assert.equal(alert.subject.id, y);
    assert.equal(alert.severity, 'high');
    assert.equal(alert.evidence.counts.failures, 5);
    assert.equal(alert.evidence.counts.lockouts, 1);
    assert.equal(alert.evidence.counts.ips, 2);

    const again = await runRule(rule, nowFor(5));
    assert.equal(again.detections, 0);
    assert.equal((await alertsFor(rule.id))[0].occurrences, 1);
  });
});

describe('auth.admin_new_ip', () => {
  const rule = getRule('auth.admin_new_ip');
  const ok = (actorId, ip, occurredAt) => ({ actorId, actorType: 'admin', email: `${actorId}@platform.test`, ip, success: true, reason: 'success', occurredAt });
  const days = (n) => at(-n * 24 * 60);

  test('alerts on a first-seen IP for an admin with history; not for known IPs, new admins or tenant users', async () => {
    const a = oid();
    const b = oid();
    const c = oid();
    await loginAttempts([
      ok(a, '192.0.2.1', days(2)),
      ok(a, '192.0.2.99', at(-5)), // new
      ok(a, '192.0.2.1', at(-4)), // known
      ok(b, '192.0.2.50', at(-5)), // no history at all
      ok(c, '192.0.2.70', days(40)), // outside the 30-day lookback
      ok(c, '192.0.2.71', days(10)),
      ok(c, '192.0.2.70', at(-3)), // not seen within 30 days
      { ...ok(oid(), '192.0.2.80', at(-5)), actorType: 'user' },
    ]);
    const summary = await runRule(rule, nowFor(0));
    assert.equal(summary.raised, 2);
    const alerts = await alertsFor(rule.id);
    const bySubject = new Map(alerts.map((x) => [x.subject.id, x]));
    assert.ok(bySubject.has(a));
    assert.ok(bySubject.has(c));
    assert.equal(bySubject.get(a).severity, 'medium');
    assert.equal(bySubject.get(a).evidence.details.ip, '192.0.2.99');
    assert.equal(bySubject.get(a).evidence.details.previousIp, '192.0.2.1');
    assert.equal(bySubject.get(a).dedupeKey, `auth.admin_new_ip|admin:${a}|ip:192.0.2.99`);

    // Signing in again from the now-known IP is not new.
    await loginAttempts([ok(a, '192.0.2.99', at(2))]);
    const again = await runRule(rule, nowFor(5));
    assert.equal(again.detections, 0);
  });

  test('requireHistory=false also flags an admin\'s very first sign-in', async () => {
    const b = oid();
    await loginAttempts([ok(b, '192.0.2.50', at(-5))]);
    assert.equal((await runRule(rule, nowFor(0))).raised, 0);
    await resetMongo();
    await loginAttempts([ok(b, '192.0.2.50', at(-5))]);
    assert.equal((await runRule(rule, nowFor(0), { overrides: { requireHistory: false } })).raised, 1);
  });
});

describe('iam.privilege_change', () => {
  const rule = getRule('iam.privilege_change');

  test('flags super grants and refused (self-targeted) changes; ignores routine grants', async () => {
    const target = oid();
    const granted = oid();
    const self = oid();
    await auditEvents([
      { module: 'iam.admins', action: 'admin.privilege.changed', occurredAt: at(-10), actorId: oid(), resourceType: 'admin', resourceId: target, metadata: { operation: 'update', adminId: target, changes: { adminType: { from: 'platform', to: 'super' } } } },
      { module: 'iam.admins', action: 'admin.privilege.changed', occurredAt: at(-9), actorId: oid(), resourceType: 'admin', resourceId: oid(), metadata: { operation: 'update', changes: { adminType: { from: 'platform', to: 'support' } } } },
      // Written by the interim security event shim: metadata kept in `after`.
      { module: 'iam.roles', action: 'rbac.role.granted', occurredAt: at(-8), actorId: oid(), resourceType: 'admin', resourceId: granted, after: { granteeType: 'admin', granteeId: granted, roleName: 'super' } },
      { module: 'iam.roles', action: 'rbac.role.granted', occurredAt: at(-8), actorType: 'user', actorId: oid(), resourceType: 'user', resourceId: oid(), metadata: { granteeType: 'user', roleName: 'Owner' } },
      { module: 'iam.roles', action: 'rbac.role.granted', occurredAt: at(-7), actorId: oid(), resourceType: 'admin', resourceId: oid(), metadata: { granteeType: 'admin', roleName: 'support' } },
      { module: 'iam.admins', action: 'admin.privilege.change_denied', occurredAt: at(-6), actorId: self, actorDisplay: 'self@platform.test', resourceType: 'admin', resourceId: self, result: 'failure', reason: 'self_change', metadata: { reason: 'self_change', targetId: self } },
      // Same action name in another module is not a privilege event.
      { module: 'reports', action: 'admin.privilege.changed', occurredAt: at(-5), metadata: { changes: { adminType: { to: 'super' } } } },
    ]);
    const summary = await runRule(rule, nowFor(0));
    assert.equal(summary.raised, 3);
    const alerts = await alertsFor(rule.id);
    const kinds = Object.fromEntries(alerts.map((a) => [a.subject.id, a.evidence.details.kind]));
    assert.equal(kinds[target], 'super_grant');
    assert.equal(kinds[granted], 'super_grant');
    assert.equal(kinds[self], 'self_change_attempt');
    assert.ok(alerts.every((a) => a.severity === 'high'));
    assert.ok(alerts.every((a) => a.evidence.refs[0].source === 'audit_log'));

    // A second super grant for the same admin merges.
    await auditEvents([{ module: 'iam.roles', action: 'rbac.role.granted', occurredAt: at(3), actorId: oid(), resourceType: 'admin', resourceId: target, metadata: { granteeType: 'admin', granteeId: target, roleName: 'Super' } }]);
    const again = await runRule(rule, nowFor(5));
    assert.equal(again.merged, 1);
    assert.equal(again.raised, 0);
    assert.equal((await alertsFor(rule.id)).length, 3);
  });

  test('optional change window flags admin privilege changes outside it (medium)', async () => {
    // T0 is Tuesday 12:00 UTC; the window below is 13:00-18:00 UTC on weekdays.
    await auditEvents([
      { module: 'iam.roles', action: 'rbac.role.granted', occurredAt: at(-30), actorId: oid(), resourceType: 'admin', resourceId: oid(), metadata: { granteeType: 'admin', roleName: 'support' } },
    ]);
    const summary = await runRule(rule, nowFor(0), {
      overrides: { changeWindowEnabled: true, changeWindowStartHour: 13, changeWindowEndHour: 18 },
    });
    assert.equal(summary.raised, 1);
    const [alert] = await alertsFor(rule.id);
    assert.equal(alert.severity, 'medium');
    assert.equal(alert.evidence.details.kind, 'outside_change_window');
  });
});

describe('auth.admin_mfa_change', () => {
  const rule = getRule('auth.admin_mfa_change');

  test('flags MFA disabled and re-enrolment for admins only', async () => {
    const disabled = oid();
    const fresh = oid();
    const again = oid();
    await auditEvents([
      { module: 'iam.auth', action: 'auth.mfa.disabled', occurredAt: at(-10), actorId: disabled, resourceType: 'admin', resourceId: disabled },
      { module: 'iam.auth', action: 'auth.mfa.enrolled', occurredAt: at(-9), actorId: fresh, resourceType: 'admin', resourceId: fresh },
      { module: 'iam.auth', action: 'auth.mfa.disabled', occurredAt: at(-10 * 24 * 60), actorId: again, resourceType: 'admin', resourceId: again },
      { module: 'iam.auth', action: 'auth.mfa.enrolled', occurredAt: at(-8), actorId: again, resourceType: 'admin', resourceId: again },
      { module: 'iam.auth', action: 'auth.mfa.disabled', occurredAt: at(-7), actorType: 'user', actorId: oid(), resourceType: 'user', resourceId: oid() },
    ]);
    const summary = await runRule(rule, nowFor(0));
    assert.equal(summary.raised, 2);
    const alerts = await alertsFor(rule.id);
    const kinds = Object.fromEntries(alerts.map((a) => [a.subject.id, a.evidence.details.kind]));
    assert.deepEqual(kinds, { [disabled]: 'mfa_disabled', [again]: 'mfa_re_enrolled' });
    assert.ok(alerts.every((a) => a.severity === 'high'));
    const reenrol = alerts.find((a) => a.subject.id === again);
    assert.equal(reenrol.evidence.refs.length, 2, 'both the earlier disable and the enrolment are evidence');

    assert.equal((await runRule(rule, nowFor(5))).detections, 0);
  });

  test('flags an admin MFA reset by another administrator; the forced re-enrolment is not an alert', async () => {
    const operator = oid();
    const target = oid();
    await auditEvents([
      {
        module: 'iam.admins',
        action: 'auth.mfa.reset_by_admin',
        occurredAt: at(-10),
        actorId: operator,
        actorDisplay: 'ops@platform.test',
        metadata: { targetAdminId: target, sessionsRevoked: 2 },
      },
      { module: 'iam.auth', action: 'auth.mfa.enrolled', occurredAt: at(-5), actorId: target, resourceType: 'admin', resourceId: target },
    ]);
    const summary = await runRule(rule, nowFor(0));
    assert.equal(summary.raised, 1);
    const [alert] = await alertsFor(rule.id);
    assert.equal(alert.subject.id, target);
    assert.equal(alert.evidence.details.kind, 'mfa_reset_by_admin');
    assert.equal(alert.ruleVersion, 2);
    assert.equal(alert.severity, 'high');
  });
});

describe('support.impersonation', () => {
  const rule = getRule('support.impersonation');
  const imp = (adminId, userId, minute, tenantId = 'tenant-a') => ({
    module: 'support.impersonation', action: 'impersonate', occurredAt: at(minute), actorId: adminId, actorDisplay: `${adminId}@platform.test`, resourceType: 'user', resourceId: userId, tenantId, reason: 'ticket 42',
  });

  test('medium on start, high over the daily cap or into an admin-owned tenant', async () => {
    const a = oid();
    const b = oid();
    const c = oid();
    const victim = new mongoose.Types.ObjectId();
    await User.collection.insertOne({ _id: victim, email: 'ops@platform.test', tenantId: 'tenant-z', deletedAt: null });
    await Admin.collection.insertOne({ email: 'ops@platform.test', adminType: 'platform', status: 'active', deletedAt: null });
    await auditEvents([
      imp(a, oid(), -5),
      ...Array.from({ length: 6 }, (_, i) => imp(b, oid(), -50 + i)),
      imp(c, String(victim), -4, 'tenant-z'),
    ]);
    const summary = await runRule(rule, nowFor(0));
    assert.equal(summary.raised, 3);
    const alerts = new Map((await alertsFor(rule.id)).map((x) => [x.subject.id, x]));
    assert.equal(alerts.get(a).severity, 'medium');
    assert.equal(alerts.get(b).severity, 'high');
    assert.equal(alerts.get(b).evidence.counts.dayTotal, 6);
    assert.equal(alerts.get(b).evidence.details.overCap, true);
    assert.equal(alerts.get(c).severity, 'high');
    assert.equal(alerts.get(c).evidence.counts.adminOwnedTargets, 1);
    assert.equal(alerts.get(a).dedupeKey, `support.impersonation|admin:${a}|day:2026-10-20`);

    // Later starts the same day merge, and crossing the cap escalates.
    await auditEvents(Array.from({ length: 5 }, (_, i) => imp(a, oid(), 1 + i * 0.5)));
    const again = await runRule(rule, nowFor(5));
    assert.equal(again.merged, 1);
    const merged = (await alertsFor(rule.id)).find((x) => x.subject.id === a);
    assert.equal(merged.severity, 'high');
    assert.equal(merged.evidence.counts.dayTotal, 6);
    assert.ok(merged.history.some((h) => h.action === 'escalated' && h.from === 'medium' && h.to === 'high'));
  });

  test('alertOnStart=false keeps only the escalated cases', async () => {
    await auditEvents([imp(oid(), oid(), -5), ...Array.from({ length: 6 }, (_, i) => imp('b0b0b0b0b0b0b0b0b0b0b0b0', oid(), -30 + i))]);
    const summary = await runRule(rule, nowFor(0), { overrides: { alertOnStart: false } });
    assert.equal(summary.raised, 1);
    assert.equal((await alertsFor(rule.id))[0].severity, 'high');
  });
});

describe('api_key.new_ip_range', () => {
  const rule = getRule('api_key.new_ip_range');

  test('flags a known key used from a range outside its baseline; not keys without a baseline', async () => {
    const k1 = new mongoose.Types.ObjectId();
    const k2 = oid();
    const k3 = oid();
    await ApiKey.collection.insertOne({ _id: k1, prefix: 'sak_k1aaaaaa', name: 'Reporting', tenantId: 'tenant-a', status: 'active', deletedAt: null });
    const usual = ['203.0.113.0/24'];
    await signals([
      { kind: 'api_key.request', subject: String(k1), tenantId: 'tenant-a', bucket: at(-3 * 24 * 60), count: 30, ipRanges: usual },
      { kind: 'api_key.request', subject: String(k1), tenantId: 'tenant-a', bucket: at(-10), count: 5, ipRanges: ['198.51.100.0/24'] },
      { kind: 'api_key.request', subject: k2, bucket: at(-3 * 24 * 60), count: 10, ipRanges: usual },
      { kind: 'api_key.request', subject: k2, bucket: at(-10), count: 5, ipRanges: ['198.51.100.0/24'] },
      { kind: 'api_key.request', subject: k3, bucket: at(-3 * 24 * 60), count: 30, ipRanges: usual },
      { kind: 'api_key.request', subject: k3, bucket: at(-10), count: 5, ipRanges: usual },
    ]);
    const summary = await runRule(rule, nowFor(0, LAG));
    assert.equal(summary.raised, 1);
    const [alert] = await alertsFor(rule.id);
    assert.equal(alert.subject.id, String(k1));
    assert.equal(alert.subject.display, 'Reporting (sak_k1aaaaaa)');
    assert.equal(alert.tenantId, 'tenant-a');
    assert.deepEqual(alert.evidence.details.newRanges, ['198.51.100.0/24']);
    assert.equal((await runRule(rule, nowFor(5, LAG))).detections, 0);
  });

  test('signal buckets younger than the signal lag wait for the next run', async () => {
    const key = oid();
    await signals([
      { kind: 'api_key.request', subject: key, bucket: at(-3 * 24 * 60), count: 30, ipRanges: ['203.0.113.0/24'] },
      { kind: 'api_key.request', subject: key, bucket: at(0), count: 5, ipRanges: ['198.51.100.0/24'] },
    ]);
    // now = T0 + 1 min: evaluation ends at T0 - 2 min, the bucket at T0 waits.
    assert.equal((await runRule(rule, at(1))).raised, 0);
    assert.equal((await runRule(rule, at(4))).raised, 1);
  });
});

describe('api_key.error_spike', () => {
  const rule = getRule('api_key.error_spike');

  test('fires at 50 calls with a 50% error rate within 15 minutes, not below', async () => {
    const [k1, k2, k3] = [oid(), oid(), oid()];
    const buckets = (subject, n, errors, minute) => ({ kind: 'api_key.request', subject, bucket: at(minute), count: n, clientErrors: errors });
    await signals([
      buckets(k1, 20, 10, -12), buckets(k1, 20, 10, -11), buckets(k1, 10, 5, -10),
      buckets(k2, 20, 10, -12), buckets(k2, 20, 10, -11), buckets(k2, 10, 4, -10),
      buckets(k3, 40, 40, -12),
    ]);
    const summary = await runRule(rule, nowFor(0, LAG));
    assert.equal(summary.raised, 1);
    const [alert] = await alertsFor(rule.id);
    assert.equal(alert.subject.id, k1);
    assert.equal(alert.evidence.counts.requests, 50);
    assert.equal(alert.evidence.counts.errors, 25);
    assert.equal(alert.evidence.counts.errorRatePercent, 50);
  });
});

describe('api_key.revoked_use', () => {
  const rule = getRule('api_key.revoked_use');

  test('flags refused calls presenting a revoked or deleted key after it was retired', async () => {
    await ApiKey.collection.insertMany([
      { prefix: 'sak_revoked1', name: 'Old', tenantId: 'tenant-a', status: 'revoked', revokedAt: at(-30), deletedAt: null },
      { prefix: 'sak_deleted1', name: 'Gone', tenantId: 'tenant-b', status: 'active', revokedAt: null, deletedAt: at(-30) },
      { prefix: 'sak_active01', name: 'Live', tenantId: 'tenant-a', status: 'active', revokedAt: null, deletedAt: null },
      { prefix: 'sak_revoked2', name: 'Later', tenantId: 'tenant-a', status: 'revoked', revokedAt: at(-30), deletedAt: null },
    ]);
    await signals([
      { kind: 'api_key.auth_failed', subject: 'sak_revoked1', bucket: at(-10), count: 3, ipRanges: ['192.0.2.0/24'] },
      { kind: 'api_key.auth_failed', subject: 'sak_deleted1', bucket: at(-9), count: 1 },
      { kind: 'api_key.auth_failed', subject: 'sak_active01', bucket: at(-10), count: 9 },
      { kind: 'api_key.auth_failed', subject: 'sak_revoked2', bucket: at(-40), count: 9 }, // before revocation
      { kind: 'api_key.auth_failed', subject: 'sak_unknown1', bucket: at(-10), count: 9 },
    ]);
    const summary = await runRule(rule, nowFor(0, LAG));
    assert.equal(summary.raised, 2);
    const alerts = new Map((await alertsFor(rule.id)).map((a) => [a.evidence.details.keyStatus, a]));
    assert.equal(alerts.get('revoked').evidence.counts.attempts, 3);
    assert.equal(alerts.get('revoked').tenantId, 'tenant-a');
    assert.equal(alerts.get('deleted').tenantId, 'tenant-b');
    assert.ok(alerts.get('revoked').evidence.refs.some((r) => r.source === 'api_key'));

    assert.equal((await runRule(rule, nowFor(5, LAG))).detections, 0);
  });
});

describe('traffic.rate_limit_hits', () => {
  const rule = getRule('traffic.rate_limit_hits');

  test('fires when 429s reach max(50, 5x the baseline), not below', async () => {
    const hits = (subject, count, minute) => ({ kind: 'rate_limit.hit', subject, bucket: at(minute), count });
    await signals([
      hits('tenant:t1', 30, -10), hits('tenant:t1', 20, -9), // 50, no baseline
      hits('tenant:t2', 49, -10),
      // Busy range: 150 per 15-minute window on average -> threshold 750.
      hits('ip:203.0.113.0/24', 100800, -3 * 24 * 60), hits('ip:203.0.113.0/24', 500, -10),
    ]);
    const summary = await runRule(rule, nowFor(0, LAG));
    assert.equal(summary.raised, 1);
    const [alert] = await alertsFor(rule.id);
    assert.equal(alert.subject.type, 'tenant');
    assert.equal(alert.subject.id, 't1');
    assert.equal(alert.tenantId, 't1');
    assert.equal(alert.evidence.counts.hits, 50);
    assert.equal(alert.evidence.counts.threshold, 50);
  });
});

describe('traffic.request_volume', () => {
  const rule = getRule('traffic.request_volume');

  test('fires when one tenant\'s requests reach max(5000, 5x its baseline)', async () => {
    const req = (subject, count, minute) => ({ kind: 'tenant.request', subject, tenantId: subject, bucket: at(minute), count });
    await signals([
      ...Array.from({ length: 5 }, (_, i) => req('t1', 1000, -10 + i)),
      req('t2', 6000, -10), req('t2', 672 * 2000, -2 * 24 * 60), // usual 2000 per window -> threshold 10000
      req('t3', 4999, -10),
    ]);
    const summary = await runRule(rule, nowFor(0, LAG));
    assert.equal(summary.raised, 1);
    const [alert] = await alertsFor(rule.id);
    assert.equal(alert.subject.id, 't1');
    assert.equal(alert.evidence.counts.requests, 5000);
  });
});

describe('authz.repeated_denials', () => {
  const rule = getRule('authz.repeated_denials');
  const denied = (actorId, count, minute) => Array.from({ length: count }, (_, i) => ({
    actorType: 'user', actorId, tenantId: 'tenant-a', method: 'GET', path: `/api/v1/dashboards/${i}?x=1`, statusCode: 403, occurredAt: at(minute, i * 10),
  }));
  const cross = (actorId, count, minute) => Array.from({ length: count }, (_, i) => ({
    module: 'security.access', action: 'request.denied', actorType: 'user', actorId, tenantId: 'tenant-b', result: 'failure', reason: 'cross_tenant',
    resourceType: 'route', resourceId: '/api/v1/tenants/:tenantId', occurredAt: at(minute, i * 30), metadata: { requestedTenantId: 'tenant-b', reason: 'cross_tenant' },
  }));

  test('medium at 20 denials in 10 minutes, high at 3 cross-tenant refusals; not below', async () => {
    const [u1, u2, u3, u4] = [oid(), oid(), oid(), oid()];
    await accessRows([...denied(u1, 20, -9), ...denied(u2, 19, -9)]);
    await auditEvents([
      ...cross(u3, 3, -5), ...cross(u4, 2, -5),
      // Other refusal reasons are not cross-tenant.
      ...cross(u4, 3, -5).map((row) => ({ ...row, reason: 'permission_missing' })),
    ]);
    const summary = await runRule(rule, nowFor(0));
    assert.equal(summary.raised, 2);
    const alerts = new Map((await alertsFor(rule.id)).map((a) => [a.subject.id, a]));
    assert.equal(alerts.get(u1).severity, 'medium');
    assert.equal(alerts.get(u1).evidence.counts.denials, 20);
    assert.ok(alerts.get(u1).evidence.details.paths.every((p) => !p.value.includes('?')));
    assert.equal(alerts.get(u3).severity, 'high');
    assert.equal(alerts.get(u3).evidence.counts.crossTenantDenials, 3);
    assert.deepEqual(alerts.get(u3).evidence.details.requestedTenants, ['tenant-b']);
    assert.equal((await runRule(rule, nowFor(5))).detections, 0);
  });
});

describe('export.unusual_volume', () => {
  const rule = getRule('export.unusual_volume');
  const dataExport = (actorId, minute, extra = {}) => ({
    actorType: 'user', actorId, tenantId: 'tenant-a', method: 'POST', path: '/api/v1/analytics/export', statusCode: 202, occurredAt: at(minute), ...extra,
  });

  test('flags volume above the caller\'s baseline and exports right after a role grant', async () => {
    const admin = oid();
    const [u1, u2, u3] = [oid(), oid(), oid()];
    await auditExports(Array.from({ length: 10 }, (_, i) => ({ requestedBy: admin, createdAt: at(-50 + i) })));
    // u1 usually exports ~8 per hour (200 over the previous day): 10 is normal.
    await accessRows([
      ...Array.from({ length: 200 }, (_, i) => dataExport(u1, -24 * 60 - 60 + i * 7)),
      ...Array.from({ length: 10 }, (_, i) => dataExport(u1, -30 + i)),
      ...Array.from({ length: 9 }, (_, i) => dataExport(u2, -30 + i)),
      ...Array.from({ length: 10 }, (_, i) => dataExport(u2, -20 + i, { statusCode: 403 })), // refused: not an export
      dataExport(u3, -5),
    ]);
    await auditEvents([{ module: 'iam.roles', action: 'rbac.role.granted', occurredAt: at(-2 * 24 * 60), actorId: oid(), resourceType: 'user', resourceId: u3, metadata: { granteeType: 'user', granteeId: u3, roleName: 'Admin' } }]);

    const summary = await runRule(rule, nowFor(0), { overrides: { baselineDays: 1 } });
    assert.equal(summary.raised, 2);
    const alerts = await alertsFor(rule.id);
    const volume = alerts.find((a) => a.evidence.details.kind === 'volume');
    assert.equal(volume.subject.id, admin);
    assert.equal(volume.evidence.counts.exports, 10);
    assert.ok(volume.evidence.refs.every((r) => r.source === 'audit_export'));
    const grant = alerts.find((a) => a.evidence.details.kind === 'new_grant');
    assert.equal(grant.subject.id, u3);
    assert.equal(grant.evidence.details.roleName, 'Admin');
    assert.equal((await runRule(rule, nowFor(5), { overrides: { baselineDays: 1 } })).detections, 0);
  });
});

describe('connector.auth_failures', () => {
  const rule = getRule('connector.auth_failures');

  test('flags 5 authentication failures per connector in an hour and unknown-token probing', async () => {
    const [c1, c2, c3] = [oid(), oid(), oid()];
    await signals([
      { kind: 'connector.auth_failed', subject: c1, tenantId: 'tenant-a', bucket: at(-30), count: 3 },
      { kind: 'connector.auth_failed', subject: c1, tenantId: 'tenant-a', bucket: at(-20), count: 2 },
      { kind: 'connector.auth_failed', subject: c2, tenantId: 'tenant-a', bucket: at(-20), count: 2 },
      { kind: 'webhook.unknown_token', subject: 'ip:203.0.113.0/24', bucket: at(-10), count: 20 },
      { kind: 'webhook.unknown_token', subject: 'ip:198.51.100.0/24', bucket: at(-10), count: 19 },
    ]);
    await failedSyncRuns([
      ...Array.from({ length: 2 }, (_, i) => ({ tenantId: 'tenant-a', connectorId: c2, finishedAt: at(-15 + i) })),
      ...Array.from({ length: 5 }, (_, i) => ({ tenantId: 'tenant-b', connectorId: c3, finishedAt: at(-15 + i) })),
      ...Array.from({ length: 5 }, (_, i) => ({ tenantId: 'tenant-b', connectorId: c2, finishedAt: at(-15 + i), error: { code: 'FILE_PARSE_FAILED' } })),
    ]);
    const summary = await runRule(rule, nowFor(0, LAG));
    assert.equal(summary.raised, 3);
    const alerts = new Map((await alertsFor(rule.id)).map((a) => [a.subject.id, a]));
    assert.equal(alerts.get(c1).severity, 'low');
    assert.equal(alerts.get(c1).evidence.counts.failures, 5);
    assert.equal(alerts.get(c3).tenantId, 'tenant-b');
    assert.ok(alerts.get(c3).evidence.refs.every((r) => r.source === 'sync_run'));
    assert.equal(alerts.get('203.0.113.0/24').severity, 'medium');
    assert.equal(alerts.has(c2), false);
    assert.equal((await runRule(rule, nowFor(5, LAG))).detections, 0);
  });
});

describe('resource.consumption', () => {
  const rule = getRule('resource.consumption');
  const slow = (tenantId, count, latencyMs, path = '/api/v1/analytics/query') => Array.from({ length: count }, (_, i) => ({
    actorType: 'user', actorId: oid(), tenantId, method: 'POST', path, statusCode: 200, latencyMs, occurredAt: at(-10, i * 20),
  }));

  test('flags slow query load per tenant and queue backlog; not below', async () => {
    await accessRows([
      ...slow('t1', 20, 6000),
      ...slow('t2', 19, 6000),
      ...slow('t3', 20, 6000, '/api/v1/auth/login'),
      ...slow('t4', 20, 4000),
    ]);
    const context = {
      ...defaultSources(),
      queueStats: async () => [
        { name: 'connector.sync', status: 'ok', waiting: 1000, active: 2, delayed: 0, failed: 0 },
        { name: 'email.delivery', status: 'ok', waiting: 999, active: 0, delayed: 0, failed: 3 },
      ],
    };
    const summary = await runRule(rule, nowFor(0), { context });
    assert.equal(summary.raised, 2);
    const alerts = new Map((await alertsFor(rule.id)).map((a) => [a.subject.id, a]));
    assert.equal(alerts.get('t1').evidence.counts.slowRequests, 20);
    assert.equal(alerts.get('t1').evidence.counts.totalLatencyMs, 120000);
    assert.equal(alerts.get('connector.sync').subject.type, 'queue');
    assert.equal(alerts.get('connector.sync').evidence.counts.waiting, 1000);

    // The backlog persists: the queue alert merges instead of duplicating.
    const again = await runRule(rule, nowFor(5), { context });
    assert.equal(again.raised, 0);
    assert.equal(again.merged, 1);
    assert.equal((await alertsFor(rule.id)).length, 2);
  });
});

test('fixtures are expressed against a fixed instant', () => {
  assert.equal(T0.toISOString(), '2026-10-20T12:00:00.000Z');
});
