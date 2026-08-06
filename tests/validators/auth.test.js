/**
 * Tests for the Sprint 1 auth/admin validator schemas.
 *
 * Exercises the schema engine (`src/validators/index.js`) with the real
 * schemas declared in `src/validators/auth.validator.js` and
 * `src/validators/admin.validator.js`. No database, no argon2 - pure logic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { validate } from '../../src/validators/index.js';
import {
  loginSchema,
  refreshSchema,
  logoutSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  mfaVerifySchema,
} from '../../src/validators/auth.validator.js';
import { loginSchema as adminLoginSchema } from '../../src/validators/admin.validator.js';

/** Run the schema engine against a body; returns `{ req, error }`. */
function run(schema, body) {
  const req = { body, params: {}, query: {} };
  let error = null;
  const next = (err) => {
    error = err;
  };
  validate(schema)(req, {}, next);
  return { req, error };
}

test('loginSchema accepts valid credentials and normalises the email', () => {
  const { req, error } = run(loginSchema, { email: '  Alex@Acme.com ', password: 'secret' });
  assert.equal(error, undefined);
  assert.equal(req.validated.body.email, 'alex@acme.com');
  assert.equal(req.validated.body.password, 'secret');
});

test('loginSchema rejects a missing password', () => {
  const { error } = run(loginSchema, { email: 'a@b.com' });
  assert.ok(error, 'expected a validation error');
  assert.equal(error.statusCode, 422);
  assert.ok(error.errors.some((e) => e.field === 'password'));
});

test('loginSchema rejects a malformed email', () => {
  const { error } = run(loginSchema, { email: 'not-an-email', password: 'secret' });
  assert.ok(error);
  assert.ok(error.errors.some((e) => e.field === 'email'));
});

test('loginSchema accepts an optional 6-digit mfaToken but rejects bad ones', () => {
  assert.equal(run(loginSchema, { email: 'a@b.com', password: 'secret', mfaToken: '123456' }).error, undefined);
  const bad = run(loginSchema, { email: 'a@b.com', password: 'secret', mfaToken: '12ab56' });
  assert.ok(bad.error);
  assert.ok(bad.error.errors.some((e) => e.field === 'mfaToken'));
});

test('refreshSchema and logoutSchema allow an empty body (token comes via cookie)', () => {
  assert.equal(run(refreshSchema, {}).error, undefined);
  assert.equal(run(logoutSchema, {}).error, undefined);
  assert.equal(run(refreshSchema, { refreshToken: 'abc' }).req.validated.body.refreshToken, 'abc');
});

test('forgotPasswordSchema requires a valid email', () => {
  assert.equal(run(forgotPasswordSchema, { email: 'a@b.com' }).error, undefined);
  assert.ok(run(forgotPasswordSchema, {}).error);
});

test('resetPasswordSchema requires a token and a password of at least 8 chars', () => {
  assert.equal(run(resetPasswordSchema, { token: 'jwt', newPassword: 'longenough' }).error, undefined);
  const noToken = run(resetPasswordSchema, { newPassword: 'longenough' });
  assert.ok(noToken.error.errors.some((e) => e.field === 'token'));
  const short = run(resetPasswordSchema, { token: 'jwt', newPassword: 'short' });
  assert.ok(short.error.errors.some((e) => e.field === 'newPassword'));
});

test('mfaVerifySchema requires a 6-digit code', () => {
  assert.equal(run(mfaVerifySchema, { code: '654321' }).error, undefined);
  assert.ok(run(mfaVerifySchema, {}).error);
  assert.ok(run(mfaVerifySchema, { code: '123' }).error);
});

test('admin loginSchema enforces the same shape', () => {
  assert.equal(run(adminLoginSchema, { email: 'admin@x.com', password: 'secret' }).error, undefined);
  assert.ok(run(adminLoginSchema, { email: 'admin@x.com' }).error);
});

