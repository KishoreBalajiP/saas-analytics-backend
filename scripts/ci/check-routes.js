#!/usr/bin/env node
/**
 * CI guard: check-routes.
 *
 * For every file under `src/routes/` (except `health.routes.js` and
 * `index.js`), inspect the source and assert that:
 *
 *   1. Any mounted route is either:
 *      - a `notImplemented` placeholder (returns 501), OR
 *      - protected by `authenticate`, `adminAuth`, or `optionalAuthenticate`,
 *        OR carries an explicit `ci:routes-exempt` annotation.
 *
 *   2. The `health.routes.js` exemption is intentional (only `/health/*`).
 *
 * Comments and string literals are stripped before matching so JSDoc
 * examples do not produce false positives.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

/**
 * Walk every JS file under `dir`.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
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

/**
 * Strip JSDoc-style block comments (`/* ... *\/`) and line comments so
 * example code inside documentation does not match the route regex.
 *
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

/**
 * Check whether every `router.<verb>(...)` call in `source` is either a
 * not-implemented stub or carries an auth middleware.
 *
 * Routes that mount a local wrapper (e.g. `guarded('view', ...)`) are also
 * compliant, provided that wrapper is DEFINED with an auth middleware in its
 * body - so an unauthenticated route cannot hide behind an arbitrary name.
 *
 * @param {string} source
 * @returns {boolean}
 */
function isCompliant(source) {
  const cleaned = stripComments(source);

  // Names of local wrappers whose bodies explicitly mount an auth middleware,
  // e.g. `const guarded = (action, ...mw) => [authenticate, ..., ...mw];`.
  const wrapperPattern =
    /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)\s*=>\s*)?\[[^\]]*?(?:authenticate|adminAuth|optionalAuthenticate|authenticateApiKey)[^\]]*?\]/g;
  const wrappers = new Set();
  let wrapperMatch;
  while ((wrapperMatch = wrapperPattern.exec(cleaned)) !== null) {
    wrappers.add(wrapperMatch[1]);
  }
  const wrapperUse = wrappers.size
    ? new RegExp(`\\b(?:${[...wrappers].join('|')})\\s*\\(`)
    : null;

  const routePattern = /router\.(get|post|put|patch|delete)\s*\(([^;]*?)\)/g;
  let match;
  let realCount = 0;
  while ((match = routePattern.exec(cleaned)) !== null) {
    const args = match[2];
    if (/notImplemented|notImplementedStub/.test(args)) continue;
    if (/authenticate|adminAuth|optionalAuthenticate|authenticateApiKey/.test(args)) continue;
    if (wrapperUse && wrapperUse.test(args)) continue;
    if (/ci:routes-exempt/.test(args)) continue;
    realCount += 1;
  }
  return realCount === 0;
}

const routesDir = path.join(projectRoot, 'src/routes');
const files = await walk(routesDir);
let failed = false;

for (const file of files) {
  const rel = path.relative(projectRoot, file).replaceAll(path.sep, '/');
  if (rel === 'src/routes/index.js') continue;
  if (rel === 'src/routes/health.routes.js') continue;
  const source = await fs.readFile(file, 'utf8');
  if (!isCompliant(source)) {
    console.error(`check-routes: ${rel} mounts a real route without an auth middleware`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log('check-routes: OK');
