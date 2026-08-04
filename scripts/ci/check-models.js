#!/usr/bin/env node
/**
 * CI guard: check-models.
 *
 * Asserts that every Mongoose model under `src/models/` (i.e. a file that
 * calls `mongoose.model()`) also imports at least one plugin from
 * `src/models/plugins/`. This is a coarse signal; combined with the audit
 * plugin and integration tests, it ensures no model bypasses the standard
 * plugin set.
 *
 * Sprint 0 ships the plugins only; no business models exist yet, so this
 * check will pass trivially.
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

const modelsDir = path.join(projectRoot, 'src/models');
const files = await walk(modelsDir);
let failed = false;

for (const file of files) {
  const rel = path.relative(projectRoot, file).replaceAll(path.sep, '/');
  if (rel === 'src/models/README.md' || rel.endsWith('/plugins/index.js')) continue;
  const source = await fs.readFile(file, 'utf8');
  if (!/mongoose\.model\s*\(/.test(source)) continue;
  if (!/plugins\//.test(source)) {
    console.error(`check-models: ${rel} defines a mongoose.model() but does not import a plugin`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log('check-models: OK');
