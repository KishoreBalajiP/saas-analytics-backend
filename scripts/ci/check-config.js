#!/usr/bin/env node
/**
 * CI guard: check-config.
 *
 * Asserts that `process.env` is never read outside `src/config/` and
 * `tests/`. The check ignores comments and string literals so JSDoc
 * examples do not produce false positives.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

async function walk(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (/\.(m?js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const allowDirs = ['src/config/', 'tests/', 'scripts/ci/'];
const files = await walk(projectRoot);
let failed = false;

for (const file of files) {
  const rel = path.relative(projectRoot, file).replaceAll(path.sep, '/');
  if (allowDirs.some((d) => rel.startsWith(d))) continue;
  const source = await fs.readFile(file, 'utf8');
  // Strip block + line comments to avoid matching JSDoc examples.
  const cleaned = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    // Strip string literals (single, double, backtick).
    .replace(/(['"`])((?:\\.|(?!\1).)*)\1/g, "''");
  if (/process\.env/.test(cleaned)) {
    console.error(`check-config: ${rel} reads process.env (move it through config/env.js)`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log('check-config: OK');
