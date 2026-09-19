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
delete process.env.REDIS_URL;
process.env.STORAGE_PROVIDER = 'local';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/saas_analytics_test';

const testArgs =
  kdfIndex === -1 ? args : args.filter((_, i) => i !== kdfIndex && i !== kdfIndex + 1);
const child = spawn(
  process.execPath,
  // No explicit path: Node's test runner auto-discovers `*.test.js` files
  // recursively from the project root. Passing a directory (e.g. `tests/`)
  // is rejected by Node >= 22 (`Cannot find module '<dir>'`), so when no
  // explicit test files are requested we let the runner discover them.
  ['--test', ...testArgs],
  { stdio: 'inherit', env: process.env, cwd: process.cwd() },
);

child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
