/**
 * adminauth configuration (roadmap 2.2 / auth.15): link lifetimes, MFA
 * policy, step-up window and recovery-code count. Each case loads
 * `src/config/env.js` in a child process with its own environment.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const moduleUrl = new URL('../../src/config/env.js', import.meta.url).href;
const KEYS = [
  'PASSWORD_RESET_TTL_MS',
  'EMAIL_VERIFICATION_TTL_MS',
  'EMAIL_VERIFICATION_RESEND_COOLDOWN_MS',
  'ADMIN_MFA_REQUIRED_TYPES',
  'ADMIN_STEP_UP_TTL_MS',
  'ADMIN_INVITATION_TTL_MS',
  'ADMIN_INVITATION_RESEND_COOLDOWN_MS',
  'MFA_RECOVERY_CODE_COUNT',
];

function load(overrides = {}) {
  const script = `const { default: env } = await import(${JSON.stringify(moduleUrl)});
    process.stdout.write(JSON.stringify(env.security.auth));`;
  const env = { ...process.env, NODE_ENV: 'development' };
  for (const key of KEYS) delete env[key];
  // The application loader intentionally reads the project `.env`. Seed the
  // documented defaults here so this child-process test is independent of a
  // developer's local overrides while still exercising the real loader.
  Object.assign(env, {
    PASSWORD_RESET_TTL_MS: '3600000',
    EMAIL_VERIFICATION_TTL_MS: '86400000',
    EMAIL_VERIFICATION_RESEND_COOLDOWN_MS: '60000',
    ADMIN_MFA_REQUIRED_TYPES: 'super,platform',
    ADMIN_STEP_UP_TTL_MS: '300000',
    ADMIN_INVITATION_TTL_MS: '259200000',
    ADMIN_INVITATION_RESEND_COOLDOWN_MS: '60000',
    MFA_RECOVERY_CODE_COUNT: '10',
  });
  Object.assign(env, overrides);
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
}

test('defaults: reset links 1 h, verification 24 h, invitations 72 h, MFA required for super and platform', () => {
  const result = load();
  assert.equal(result.status, 0, result.stderr);
  const auth = JSON.parse(result.stdout);
  assert.equal(auth.passwordResetTokenTtlMs, 60 * 60 * 1000);
  assert.equal(auth.verificationTokenTtlMs, 24 * 60 * 60 * 1000);
  assert.equal(auth.verificationResendCooldownMs, 60 * 1000);
  assert.equal(auth.adminInvitationTtlMs, 72 * 60 * 60 * 1000);
  assert.equal(auth.adminInvitationResendCooldownMs, 60 * 1000);
  assert.deepEqual(auth.adminMfaRequiredTypes, ['super', 'platform']);
  assert.equal(auth.adminStepUpTtlMs, 5 * 60 * 1000);
  assert.equal(auth.mfaRecoveryCodeCount, 10);
});

test('lifetimes and the policy are configurable', () => {
  const result = load({
    PASSWORD_RESET_TTL_MS: '1800000',
    EMAIL_VERIFICATION_TTL_MS: '172800000',
    ADMIN_INVITATION_TTL_MS: '604800000',
    ADMIN_INVITATION_RESEND_COOLDOWN_MS: '120000',
    ADMIN_MFA_REQUIRED_TYPES: 'Super, Platform, support',
    ADMIN_STEP_UP_TTL_MS: '600000',
    MFA_RECOVERY_CODE_COUNT: '12',
  });
  assert.equal(result.status, 0, result.stderr);
  const auth = JSON.parse(result.stdout);
  assert.equal(auth.passwordResetTokenTtlMs, 1_800_000);
  assert.equal(auth.verificationTokenTtlMs, 172_800_000);
  assert.equal(auth.adminInvitationTtlMs, 604_800_000);
  assert.equal(auth.adminInvitationResendCooldownMs, 120_000);
  assert.deepEqual(auth.adminMfaRequiredTypes, ['super', 'platform', 'support']);
  assert.equal(auth.adminStepUpTtlMs, 600_000);
  assert.equal(auth.mfaRecoveryCodeCount, 12);
});

test('`none` turns the type policy off; the step-up window and code count are clamped', () => {
  const off = load({ ADMIN_MFA_REQUIRED_TYPES: 'none' });
  assert.deepEqual(JSON.parse(off.stdout).adminMfaRequiredTypes, []);
  const tiny = JSON.parse(load({ ADMIN_STEP_UP_TTL_MS: '1', MFA_RECOVERY_CODE_COUNT: '1' }).stdout);
  assert.equal(tiny.adminStepUpTtlMs, 30 * 1000);
  assert.equal(tiny.mfaRecoveryCodeCount, 5);
  const huge = JSON.parse(load({ ADMIN_STEP_UP_TTL_MS: '999999999', MFA_RECOVERY_CODE_COUNT: '500' }).stdout);
  assert.equal(huge.adminStepUpTtlMs, 60 * 60 * 1000);
  assert.equal(huge.mfaRecoveryCodeCount, 20);
});
