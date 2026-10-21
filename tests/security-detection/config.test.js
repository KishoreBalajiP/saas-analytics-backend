/**
 * Security detection configuration (roadmap 2.6): defaults and fail-fast
 * validation of SECURITY_DETECTION_RULES_JSON and the notification
 * severity. Each case loads `src/config/env.js` in a child process.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const moduleUrl = new URL('../../src/config/env.js', import.meta.url).href;

function load(overrides = {}) {
  const script = `const { default: env } = await import(${JSON.stringify(moduleUrl)});
    process.stdout.write(JSON.stringify(env.securityDetection));`;
  const env = { ...process.env, NODE_ENV: 'development', ...overrides };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
}

test('defaults: detector on every 5 minutes, high-severity notification, no overrides', () => {
  const result = load({
    JOB_SECURITY_DETECTION_ENABLED: undefined,
    JOB_SECURITY_DETECTION_CRON: undefined,
    SECURITY_DETECTION_RULES_JSON: undefined,
    SECURITY_ALERT_NOTIFY_MIN_SEVERITY: undefined,
    SECURITY_ALERT_EMAILS: undefined,
    SECURITY_ALERT_WEBHOOK_URL: undefined,
  });
  assert.equal(result.status, 0, result.stderr);
  const cfg = JSON.parse(result.stdout);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.cron, '*/5 * * * *');
  assert.equal(cfg.settleSec, 60);
  assert.equal(cfg.initialLookbackMinutes, 60);
  assert.equal(cfg.maxCatchUpHours, 24);
  assert.deepEqual(cfg.rules, {});
  assert.equal(cfg.notifyMinSeverity, 'high');
  assert.deepEqual(cfg.notifyEmails, []);
  assert.equal(cfg.falsePositiveSuppressHours, 24);
  assert.equal(cfg.signals.enabled, true);
  assert.equal(cfg.signals.retentionDays, 35);
});

test('rule overrides and on-call targets are read from the environment', () => {
  const result = load({
    SECURITY_DETECTION_RULES_JSON: '{"auth.credential_stuffing":{"minFailures":30}}',
    SECURITY_ALERT_EMAILS: 'oncall@example.com, secops@example.com',
    SECURITY_ALERT_NOTIFY_MIN_SEVERITY: 'Medium',
  });
  assert.equal(result.status, 0, result.stderr);
  const cfg = JSON.parse(result.stdout);
  assert.deepEqual(cfg.rules, { 'auth.credential_stuffing': { minFailures: 30 } });
  assert.deepEqual(cfg.notifyEmails, ['oncall@example.com', 'secops@example.com']);
  assert.equal(cfg.notifyMinSeverity, 'medium');
});

test('malformed overrides and unknown severities refuse to start', () => {
  for (const overrides of [
    { SECURITY_DETECTION_RULES_JSON: '{not json' },
    { SECURITY_DETECTION_RULES_JSON: '[1,2]' },
    { SECURITY_ALERT_NOTIFY_MIN_SEVERITY: 'urgent' },
  ]) {
    const result = load(overrides);
    assert.notEqual(result.status, 0, JSON.stringify(overrides));
    assert.match(result.stderr, /SECURITY_(DETECTION_RULES_JSON|ALERT_NOTIFY_MIN_SEVERITY)/);
  }
});
