#!/usr/bin/env node
/**
 * CI guard: check-stubs.
 *
 * Fails the build when a file uses `notImplementedStub` outside the
 * allowlist (`scripts/ci/stubs-allowlist.js`). This keeps the fail-closed
 * discipline visible: every placeholder must be declared.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import allowlist from './stubs-allowlist.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

/**
 * Recursively yield every JS/MJS file under `dir`.
 *
 * @param {string} dir
 * @returns {AsyncGenerator<string>}
 */
async function* walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(m?js)$/.test(entry.name)) yield full;
  }
}

const violations = [];

for await (const file of walk(path.join(projectRoot, 'src'))) {
  const rel = path.relative(projectRoot, file).replaceAll(path.sep, '/');
  if (allowlist.includes(rel)) continue;
  const source = await fs.readFile(file, 'utf8');
  if (/notImplementedStub/.test(source)) {
    violations.push(rel);
  }
}

if (violations.length > 0) {
  console.error('check-stubs: files using notImplementedStub without an allowlist entry:');
  for (const v of violations) console.error('  - ' + v);
  process.exit(1);
}
console.log('check-stubs: OK');
