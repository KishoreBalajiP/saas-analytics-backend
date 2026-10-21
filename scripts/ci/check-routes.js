#!/usr/bin/env node
/**
 * CI guard: check-routes.
 *
 * For every file under `src/routes/` (except `health.routes.js` and
 * `index.js`), inspect the source and assert that:
 *
 *   1. Any mounted route is either:
 *      - a `notImplemented` placeholder (returns 501), OR
 *      - protected by `authenticate`, `adminAuth`, `optionalAuthenticate` or
 *        `authenticateApiKey` (directly or through a local wrapper that
 *        mounts one), OR carries an explicit `ci:routes-exempt` annotation.
 *
 *   2. Every platform-admin route (one that mounts `adminAuth`, or any route
 *      of a router that mounts `router.use(adminAuth)`) ALSO declares a
 *      permission middleware - `permission(...)` directly or through a local
 *      wrapper whose definition mounts one. Authentication alone is not
 *      authorization (roadmap 2.1 / finding tst.06). Exceptions must be
 *      explicit and carry a reason: either the file is listed in
 *      `ADMIN_PERMISSION_ALLOWLIST` below, or the route carries a
 *      `ci:permission-exempt: <reason>` annotation.
 *
 *   3. The `health.routes.js` exemption is intentional (only `/health/*`).
 *
 * Block comments and whole-line comments are stripped before matching so
 * JSDoc examples do not produce false positives; trailing comments on a
 * route line are kept so annotations are visible.
 *
 * USAGE
 *   node scripts/ci/check-routes.js            # checks <repo>/src/routes
 *   node scripts/ci/check-routes.js --root DIR # checks DIR/src/routes (tests)
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

/**
 * Admin route files that may mount `adminAuth` without a permission
 * middleware, each with the reason. Keep this list short.
 */
export const ADMIN_PERMISSION_ALLOWLIST = Object.freeze({
  'src/routes/admin-auth.routes.js':
    'Self-service for the signed-in admin (profile, MFA enrol/verify/disable): the admin acts only on its own account. Login, refresh, logout and password routes are unauthenticated.',
});

const AUTH_RE = /authenticate|adminAuth|optionalAuthenticate|authenticateApiKey/;
const ADMIN_AUTH_RE = /\badminAuth\b/;
const USER_AUTH_RE = /\b(?:authenticate|optionalAuthenticate|authenticateApiKey)\b/;
const PERMISSION_RE = /\bpermission\s*\(/;
const STUB_RE = /notImplemented|notImplementedStub/;

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
 * Strip block comments (`/* ... *\/`) and whole-line `//` comments, keeping
 * line breaks so reported line numbers stay accurate.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, (line) => line.replace(/[^\n]/g, ' '));
}

/**
 * Extract every `router.<verb>(...)` call with its full, paren-balanced
 * argument text (strings and trailing `//` comments are skipped while
 * balancing, but kept in the text so annotations stay visible).
 *
 * @param {string} cleaned - source after `stripComments`.
 * @returns {Array<{ verb: string, path: string|null, args: string, trailing: string, line: number }>}
 */
export function extractRouteCalls(cleaned) {
  const calls = [];
  const opener = /router\.(get|post|put|patch|delete)\s*\(/g;
  let match;
  while ((match = opener.exec(cleaned)) !== null) {
    const start = opener.lastIndex;
    let depth = 1;
    let i = start;
    let quote = null;
    while (i < cleaned.length && depth > 0) {
      const ch = cleaned[i];
      if (quote) {
        if (ch === '\\') { i += 2; continue; }
        if (ch === quote) quote = null;
        i += 1;
        continue;
      }
      if (ch === '/' && cleaned[i + 1] === '/') {
        const eol = cleaned.indexOf('\n', i);
        i = eol === -1 ? cleaned.length : eol;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
      } else if (ch === '(') {
        depth += 1;
      } else if (ch === ')') {
        depth -= 1;
      }
      i += 1;
    }
    const args = cleaned.slice(start, Math.max(start, i - 1));
    const pathMatch = /^\s*(?:\/\/[^\n]*\n\s*)?(['"`])([^'"`]*)\1/.exec(args);
    // A trailing comment after the closing paren (same line) may annotate it.
    const eol = cleaned.indexOf('\n', i);
    const trailing = cleaned.slice(i, eol === -1 ? cleaned.length : eol);
    calls.push({
      verb: match[1],
      path: pathMatch ? pathMatch[2] : null,
      args,
      trailing,
      line: cleaned.slice(0, match.index).split('\n').length,
    });
    opener.lastIndex = i;
  }
  return calls;
}

/**
 * Names of local wrappers (`const guarded = (...) => [ ... ]`) whose array
 * body matches `bodyRe`.
 */
function wrappersMatching(cleaned, bodyRe) {
  const wrapperPattern = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)\s*=>\s*)?\[([\s\S]*?)\];/g;
  const names = new Set();
  let wrapperMatch;
  while ((wrapperMatch = wrapperPattern.exec(cleaned)) !== null) {
    if (bodyRe.test(wrapperMatch[2])) names.add(wrapperMatch[1]);
  }
  return names;
}

function usesWrapper(args, names) {
  if (names.size === 0) return false;
  return new RegExp(`\\b(?:${[...names].join('|')})\\s*\\(`).test(args);
}

/**
 * Check one route file.
 *
 * @param {string} rel - repo-relative path (`src/routes/x.routes.js`).
 * @param {string} source - file contents.
 * @returns {Array<{ rule: 'auth'|'permission', line: number, verb: string, path: string|null, message: string }>}
 */
export function analyzeRouteSource(rel, source) {
  const cleaned = stripComments(source);
  const authWrappers = wrappersMatching(cleaned, AUTH_RE);
  const permissionWrappers = wrappersMatching(cleaned, PERMISSION_RE);
  const routerUsesAdminAuth = /router\.use\(\s*adminAuth\s*[,)]/.test(cleaned);
  const fileAllowlisted = Object.prototype.hasOwnProperty.call(ADMIN_PERMISSION_ALLOWLIST, rel);

  const violations = [];
  for (const call of extractRouteCalls(cleaned)) {
    const { args } = call;
    if (STUB_RE.test(args)) continue;
    const where = `${call.verb.toUpperCase()} ${call.path ?? '(dynamic path)'} (line ${call.line})`;

    const authenticated = AUTH_RE.test(args) || usesWrapper(args, authWrappers) || /ci:routes-exempt/.test(args);
    if (!authenticated) {
      violations.push({ rule: 'auth', ...call, message: `${where} mounts a real route without an auth middleware` });
      continue;
    }

    const adminRoute = ADMIN_AUTH_RE.test(args) || (routerUsesAdminAuth && !USER_AUTH_RE.test(args));
    if (!adminRoute) continue;
    const authorized = PERMISSION_RE.test(args) || usesWrapper(args, permissionWrappers);
    const exempt = fileAllowlisted || /ci:permission-exempt:\s*\S/.test(`${args}\n${call.trailing}`);
    if (!authorized && !exempt) {
      violations.push({
        rule: 'permission',
        ...call,
        message: `${where} is a platform-admin route without a permission middleware (add permission(module, action), or allow-list it with a reason)`,
      });
    }
  }
  return violations;
}

/**
 * Check every route file under `<root>/src/routes`.
 *
 * @param {string} [root=projectRoot]
 * @returns {Promise<Array<{ file: string } & Object>>}
 */
export async function checkRoutes(root = projectRoot) {
  const routesDir = path.join(root, 'src/routes');
  const files = await walk(routesDir);
  const failures = [];
  for (const file of files) {
    const rel = path.relative(root, file).replaceAll(path.sep, '/');
    if (rel === 'src/routes/index.js') continue;
    if (rel === 'src/routes/health.routes.js') continue;
    const source = await fs.readFile(file, 'utf8');
    for (const violation of analyzeRouteSource(rel, source)) failures.push({ file: rel, ...violation });
  }
  return failures;
}

async function main() {
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex !== -1 ? path.resolve(process.argv[rootIndex + 1]) : projectRoot;
  const failures = await checkRoutes(root);
  for (const failure of failures) {
    console.error(`check-routes: ${failure.file}: ${failure.message}`);
  }
  if (failures.length > 0) {
    process.exit(1);
  }
  console.log('check-routes: OK');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
