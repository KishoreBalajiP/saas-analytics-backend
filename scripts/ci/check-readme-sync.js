#!/usr/bin/env node
/**
 * CI guard: check-readme-sync.
 *
 * Ensures every module folder under `src/modules/` carries a `STATUS.md`
 * documenting its current implementation state. Also verifies the root
 * `README.md` and `CHANGELOG.md` exist.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

const modulesDir = path.join(projectRoot, 'src/modules');
let failed = false;

// Root docs.
const required = [
  path.join(projectRoot, 'README.md'),
  path.join(projectRoot, 'CHANGELOG.md'),
  path.join(projectRoot, 'src/docs/ARCHITECTURE.md'),
  path.join(projectRoot, 'src/docs/DECISIONS.md'),
];
for (const file of required) {
  try {
    await fs.access(file);
  } catch {
    console.error(`check-readme-sync: missing ${path.relative(projectRoot, file)}`);
    failed = true;
  }
}

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(full, ...(await walk(full)));
  }
  return out;
}

const dirs = await walk(modulesDir);
for (const dir of dirs) {
  const statusPath = path.join(dir, 'STATUS.md');
  try {
    await fs.access(statusPath);
  } catch {
    console.error(`check-readme-sync: missing STATUS.md in ${path.relative(projectRoot, dir).replaceAll(path.sep, '/')}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log('check-readme-sync: OK');
