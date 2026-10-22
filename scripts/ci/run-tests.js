#!/usr/bin/env node
/**
 * Test runner: runs the suite under a chosen password KDF.
 *
 * WHY IT EXISTS
 *   `utils/password.js` defaults to Argon2id, but the native `argon2` binary
 *   is not available on every developer machine (Windows prebuilds can crash
 *   on load). `npm test` therefore runs the suite in `scrypt` mode so tests
 *   are portable, while `npm run test:argon2` exercises the real Argon2id
 *   path on CI (Linux).
 *
 * USAGE
 *   node scripts/ci/run-tests.js [--kdf argon2|scrypt] [test file ...]
 *
 * NOTE
 *   Lives in `scripts/ci/` (rather than `scripts/`) because `check-config`
 *   only permits `process.env` access in `src/config/`, `tests/` and
 *   `scripts/ci/`. `run-all.js` uses an explicit guard list, so this file is
 *   not executed as part of `npm run ci:guards`.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';

const args = process.argv.slice(2);
const kdfIndex = args.indexOf('--kdf');
const requestedKdf = kdfIndex !== -1 ? args[kdfIndex + 1] : undefined;
const kdf = requestedKdf ?? process.env.PASSWORD_KDF ?? 'scrypt';

if (!['argon2', 'scrypt'].includes(kdf)) {
  console.error(`Unknown PASSWORD_KDF "${kdf}". Expected "argon2" or "scrypt".`);
  process.exit(1);
}

process.env.PASSWORD_KDF = kdf;

/* ------------------------------------------------------------------------- */
/* Test environment isolation.                                               */
/*                                                                            */
/* The project keeps real production credentials in `.env` so the running     */
/* deployment matches Render. Tests MUST NOT touch production resources:      */
/*   * NODE_ENV=development  - matches what tests assert (e.g. health checks)  */
/*   * REDIS_URL=            - force the cache/queue to use in-memory drivers */
/*   * STORAGE_PROVIDER=local - force the storage layer to write to a tmp dir */
/*   * MONGODB_URI=.../test  - defensive; integration tests boot an in-memory */
/*                              mongod via `tests/helpers/mongo.js` but the    */
/*                              app import path would otherwise resolve the   */
/*                              Atlas URI from `.env`.                        */
/*                                                                            */
/* These overrides only affect the spawned test process. The runner itself is */
/* the only place this happens, so production `.env` stays untouched.         */
/* ------------------------------------------------------------------------- */
process.env.NODE_ENV = 'development';
// An empty value prevents dotenv from repopulating the developer's Redis URL.
process.env.REDIS_URL = '';
process.env.STORAGE_PROVIDER = 'local';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/saas_analytics_test';
// Disable rate limiting in tests to avoid flaky 429s when tests create many
// ephemeral admin/user accounts.
process.env.RATE_LIMIT_MAX = '10000';
process.env.RATE_LIMIT_STRICT_MAX = '10000';
process.env.EXTERNAL_API_RATE_LIMIT_MAX = '10000';
process.env.EMBED_RATE_LIMIT_MAX = '10000';
// Per-route auth limiters (tests that exercise a real limit set their own
// small values before importing the app).
for (const key of [
  'AUTH_RATE_LIMIT_LOGIN_MAX',
  'AUTH_RATE_LIMIT_LOGIN_IP_MAX',
  'AUTH_RATE_LIMIT_REFRESH_MAX',
  'AUTH_RATE_LIMIT_PASSWORD_MAX',
  'AUTH_RATE_LIMIT_INVITATION_MAX',
  'AUTH_RATE_LIMIT_MFA_MAX',
  'AUTH_RATE_LIMIT_VERIFICATION_MAX',
  'AUTH_RATE_LIMIT_REGISTER_MAX',
]) {
  process.env[key] = '10000';
}
// adminauth: most suites sign platform admins in with a password only. The
// privileged-admin MFA policy (ADMIN_MFA_REQUIRED_TYPES, default
// super,platform) is therefore off for the general suite; the admin-auth
// suites that exercise it set their own value before importing the app.
process.env.ADMIN_MFA_REQUIRED_TYPES = 'none';
// Never allow the test process to open the developer or production SMTP
// connection loaded from .env. Email tests use the service capture sink and
// the noop transport instead.
process.env.MAIL_PROVIDER = 'none';
// The email outbox contract enables its drain job by default.  A developer's
// `.env` may disable it for a running deployment, but must not change the
// behavior asserted by the isolated test suite.
process.env.JOB_EMAIL_ENABLED = 'true';
process.env.JOB_EMAIL_CRON = '* * * * *';
delete process.env.SMTP_HOST;
delete process.env.SMTP_PORT;
delete process.env.MAIL_USER;
delete process.env.MAIL_PASSWORD;

const testArgs =
  kdfIndex === -1 ? args : args.filter((_, i) => i !== kdfIndex && i !== kdfIndex + 1);
// Test-file concurrency. TEST_CONCURRENCY wins when set. Otherwise, when the
// machine is already overloaded (1-minute load above the CPU count, e.g.
// several suites running side by side), run fewer files at once so
// timing-sensitive tests are not starved. An explicit --test-concurrency
// argument is passed through untouched.
const cpuCount = os.availableParallelism?.() ?? os.cpus().length;
const requestedConcurrency = Number(process.env.TEST_CONCURRENCY);
const concurrencyArgs = testArgs.some((arg) => arg.startsWith('--test-concurrency'))
  ? []
  : Number.isInteger(requestedConcurrency) && requestedConcurrency > 0
    ? [`--test-concurrency=${requestedConcurrency}`]
    : os.loadavg()[0] > cpuCount
      ? [`--test-concurrency=${Math.max(1, Math.floor(cpuCount / 4))}`]
      : [];

const child = spawn(
  process.execPath,
  // No explicit path: Node's test runner auto-discovers `*.test.js` files
  // recursively from the project root. Passing a directory (e.g. `tests/`)
  // is rejected by Node >= 22 (`Cannot find module '<dir>'`), so when no
  // explicit test files are requested we let the runner discover them.
  ['--test', ...concurrencyArgs, ...testArgs],
  { stdio: 'inherit', env: process.env, cwd: process.cwd() },
);

child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
