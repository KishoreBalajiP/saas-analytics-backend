/**
 * check-routes CI guard (roadmap 2.1 / tst.06): platform-admin routes must
 * declare a permission middleware, not only authentication.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeRouteSource, ADMIN_PERMISSION_ALLOWLIST } from '../../scripts/ci/check-routes.js';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/ci/check-routes.js');
const rules = (violations) => violations.map((v) => `${v.rule}:${v.verb} ${v.path}`);

test('an admin route with authentication but no permission middleware fails', () => {
  const source = `
    router.get('/things', adminAuth, validate(schema.list), controller.list);
    router.post('/things', adminAuth, permission('things', 'create'), controller.create);
  `;
  assert.deepEqual(rules(analyzeRouteSource('src/routes/things.routes.js', source)), ['permission:get /things']);
});

test('permission is found anywhere in the middleware chain, including multi-line and nested calls', () => {
  const source = `
    router.post(
      '/a',
      adminAuth,
      validate(schema.create),
      permission((req) => ['things', req.query?.x ? 'configure' : 'view']),
      controller.create,
    );
  `;
  assert.deepEqual(analyzeRouteSource('src/routes/things.routes.js', source), []);
});

test('routers that mount adminAuth with router.use are checked too', () => {
  const source = `
    const router = Router();
    router.use(adminAuth);
    router.get( // ci:routes-exempt: adminAuth above
      '/',
      validate(schema.list),
      controller.list,
    );
    router.get( // ci:routes-exempt: adminAuth above
      '/:id',
      permission('things', 'view'),
      controller.get,
    );
  `;
  assert.deepEqual(rules(analyzeRouteSource('src/routes/things.routes.js', source)), ['permission:get /']);
});

test('exemptions need an explicit reason: an annotation with text, or the file allow-list', () => {
  const annotated = `router.get('/me', adminAuth, controller.me); // ci:permission-exempt: self-service profile`;
  assert.deepEqual(analyzeRouteSource('src/routes/x.routes.js', annotated), []);
  const bare = `router.get('/me', adminAuth, controller.me); // ci:permission-exempt:`;
  assert.equal(analyzeRouteSource('src/routes/x.routes.js', bare).length, 1);
  for (const [file, reason] of Object.entries(ADMIN_PERMISSION_ALLOWLIST)) {
    assert.ok(reason.length > 20, `${file} needs a real reason`);
    assert.deepEqual(analyzeRouteSource(file, `router.get('/me', adminAuth, controller.me);`), []);
  }
});

test('wrappers count only when their definition mounts the middleware', () => {
  const good = `
    const guarded = (action, ...mw) => [adminAuth, permission('things', action), ...mw];
    router.get('/', guarded('view'), controller.list);
  `;
  assert.deepEqual(analyzeRouteSource('src/routes/x.routes.js', good), []);
  const authOnly = `
    const guarded = (...mw) => [authenticate, ...mw];
    router.get('/', guarded(), controller.list);
  `;
  assert.deepEqual(analyzeRouteSource('src/routes/x.routes.js', authOnly), [], 'tenant routes only need authentication');
  const unauthenticated = `router.get('/open', controller.open);`;
  assert.deepEqual(rules(analyzeRouteSource('src/routes/x.routes.js', unauthenticated)), ['auth:get /open']);
  const docs = `/** router.get('/x', adminAuth, controller.x) */`;
  assert.deepEqual(analyzeRouteSource('src/routes/x.routes.js', docs), [], 'JSDoc examples are ignored');
});

test('the CLI exits non-zero for an admin route without a permission middleware, and zero once fixed', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'check-routes-'));
  try {
    mkdirSync(path.join(root, 'src/routes'), { recursive: true });
    const file = path.join(root, 'src/routes/widgets.routes.js');
    writeFileSync(file, "router.delete('/widgets/:id', adminAuth, controller.remove);\n");
    const failed = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /widgets\.routes\.js: DELETE \/widgets\/:id \(line 1\) is a platform-admin route without a permission middleware/);

    writeFileSync(file, "router.delete('/widgets/:id', adminAuth, permission('widgets', 'delete'), controller.remove);\n");
    const passed = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(passed.stdout, /check-routes: OK/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the real route tree passes', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
