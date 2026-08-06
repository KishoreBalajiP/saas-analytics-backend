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

const testArgs =
  kdfIndex === -1 ? args : args.filter((_, i) => i !== kdfIndex && i !== kdfIndex + 1);
const child = spawn(
  process.execPath,
  ['--test', ...(testArgs.length > 0 ? testArgs : ['tests/'])],
  { stdio: 'inherit', env: process.env, cwd: process.cwd() },
);

child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
