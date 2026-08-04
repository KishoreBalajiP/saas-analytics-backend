#!/usr/bin/env node
/**
 * CI runner: executes every guard in `scripts/ci/` and reports the rollup.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../..');

const guards = [
  'check-stubs.js',
  'check-routes.js',
  'check-models.js',
  'check-config.js',
  'check-readme-sync.js',
];

let anyFailed = false;
for (const guard of guards) {
  const script = path.join(__dirname, guard);
  const result = spawnSync(process.execPath, [script], { stdio: 'inherit', cwd: root });
  if (result.status !== 0) {
    console.error(`guard ${guard} FAILED`);
    anyFailed = true;
  }
}

if (anyFailed) {
  console.error('\nci:guards FAILED');
  process.exit(1);
}
console.log('\nci:guards OK');
