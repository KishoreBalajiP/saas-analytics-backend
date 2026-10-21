/**
 * Auth configuration (roadmap 1.9): per-portal cookies, first-party cookie
 * domain, absolute session lifetime and per-route rate-limit settings.
 * Each case loads `src/config/env.js` in a child process with its own env.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const moduleUrl = new URL('../../src/config/env.js', import.meta.url).href;

function load(overrides = {}) {
  const script = `const { default: env } = await import(${JSON.stringify(moduleUrl)});
    process.stdout.write(JSON.stringify({ auth: env.security.auth, limits: env.security.authRateLimit }));`;
  // `undefined` removes a variable entirely (so the shipped default applies).
  const env = { ...process.env, NODE_ENV: 'development', ...overrides };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
}

test('defaults: distinct portal cookies, host-only domain, 30-day absolute lifetime', () => {
  const result = load({
    AUTH_COOKIE_NAME: undefined,
    AUTH_ADMIN_COOKIE_NAME: undefined,
    AUTH_COOKIE_DOMAIN: undefined,
    AUTH_SESSION_ABSOLUTE_TTL: undefined,
    AUTH_REFRESH_REUSE_GRACE_MS: undefined,
    // The test runner raises these to 10000; check the shipped defaults.
    AUTH_RATE_LIMIT_LOGIN_MAX: undefined,
    AUTH_RATE_LIMIT_REFRESH_MAX: undefined,
  });
  assert.equal(result.status, 0, result.stderr);
  const { auth, limits } = JSON.parse(result.stdout);
  assert.equal(auth.cookieName, 'saas_session');
  assert.equal(auth.adminCookieName, 'saas_admin_session');
  assert.notEqual(auth.cookieName, auth.adminCookieName);
  assert.equal(auth.cookieDomain, '');
  assert.equal(auth.sessionAbsoluteTtl, '30d');
  assert.equal(auth.refreshReuseGraceMs, 10000, 'a short reuse grace for lagging duplicate refreshes');
  assert.equal(limits.loginMax, 10);
  assert.equal(limits.refreshMax, 120, 'refresh has its own, looser budget');
});

test('a first-party cookie domain and SameSite=Lax can be configured', () => {
  const result = load({ AUTH_COOKIE_DOMAIN: '.example.com', AUTH_COOKIE_SAMESITE: 'Lax' });
  assert.equal(result.status, 0, result.stderr);
  const { auth } = JSON.parse(result.stdout);
  assert.equal(auth.cookieDomain, '.example.com');
  assert.equal(auth.cookieSameSite, 'Lax');
});

test('the refresh reuse grace can be disabled and never goes negative', () => {
  const disabled = load({ AUTH_REFRESH_REUSE_GRACE_MS: '0' });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(JSON.parse(disabled.stdout).auth.refreshReuseGraceMs, 0);
  const negative = load({ AUTH_REFRESH_REUSE_GRACE_MS: '-5' });
  assert.equal(negative.status, 0, negative.stderr);
  assert.equal(JSON.parse(negative.stdout).auth.refreshReuseGraceMs, 0);
});

test('a malformed absolute session lifetime refuses to start', () => {
  const result = load({ AUTH_SESSION_ABSOLUTE_TTL: '30 days' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AUTH_SESSION_ABSOLUTE_TTL/);
});

test('a zero session lifetime refuses to start (every session would be born expired)', () => {
  for (const [name, value] of [['AUTH_SESSION_ABSOLUTE_TTL', '0d'], ['JWT_REFRESH_TTL', '0s']]) {
    const result = load({ [name]: value });
    assert.notEqual(result.status, 0, `${name}=${value} must be refused`);
    assert.match(result.stderr, new RegExp(name));
  }
});
