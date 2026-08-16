/**
 * Monitoring surface - end-to-end HTTP integration tests (Sprint 8).
 *
 * WHY IT EXISTS
 *   Proves the operational health surface: auth + RBAC gating, live probes
 *   (system/db/websocket), structured deferred probes (queue/scheduler/
 *   storage/connectors/metrics), and the 5 s cached aggregate.
 *
 * DESIGN
 *   - Real Express app on an ephemeral port + real in-memory MongoDB.
 *   - RBAC seeding mirrors `tests/compliance.integration.test.js`.
 */

import test, { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from './helpers/mongo.js';
import { startHttp, stopHttp, api } from './helpers/http.js';
import { shortToken } from '../src/utils/id.js';
import adminService from '../src/services/admin.service.js';
import roleService from '../src/services/role.service.js';
import permissionService from '../src/services/permission.service.js';
import rbacCache from '../src/services/rbac.cache.service.js';

const PASSWORD = 'Password123!';

/** Create the dotted module tree for a `<module>.<action>` key. */
async function ensureModule(key) {
  if (key.includes('.')) await ensureModule(key.slice(0, key.lastIndexOf('.')));
  try {
    await permissionService.createModule({ key, name: key });
  } catch (err) {
    if (err.statusCode !== 409) throw err;
  }
}

/** Register a `<module>.<action>` permission (idempotent). */
async function ensurePermission(key) {
  const module = key.slice(0, key.lastIndexOf('.'));
  const action = key.slice(key.lastIndexOf('.') + 1);
  await ensureModule(module);
  try {
    await permissionService.createPermission({ module, action });
  } catch (err) {
    if (err.statusCode !== 409) throw err;
  }
}

/** Seed a platform admin holding `<moduleKey>.<action>` on a fresh role. */
async function seedAdminWithPermission({ moduleKey, action }) {
  const admin = await adminService.create({
    email: `admin-${shortToken(8)}@platform.test`,
    password: PASSWORD,
    adminType: 'platform',
    name: 'Monitoring Tester',
  });
  const role = await roleService.create({ tenantId: null, name: `role_${shortToken(8)}` });
  await ensurePermission(`${moduleKey}.${action}`);
  await roleService.addPermission({ roleId: role._id, permissionKey: `${moduleKey}.${action}`, by: admin._id });
  await adminService.assignRole({ adminId: admin._id, roleId: role._id, tenantId: null, by: admin._id });
  const login = await api('/api/v1/admin-auth/login', {
    method: 'POST',
    body: { email: admin.email, password: PASSWORD },
  });
  assert.equal(login.status, 200);
  return { admin, token: login.json.data.accessToken };
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

describe('monitoring surface', () => {
  before(async () => {
    await startMongo();
    await startHttp();
  });

  after(async () => {
    await stopHttp();
    await stopMongo();
  });

  beforeEach(async () => {
    await resetMongo();
    await rbacCache.clearAll();
  });

  test('rejects unauthenticated requests with 401', async () => {
    for (const path of [
      '/api/v1/monitoring/health/system',
      '/api/v1/monitoring/health/db',
      '/api/v1/monitoring/health/websocket',
      '/api/v1/monitoring/health/aggregate',
      '/api/v1/monitoring/metrics',
    ]) {
      const res = await api(path);
      assert.equal(res.status, 401, `${path} should require auth`);
    }
  });

  test('rejects an admin without the monitoring.view permission', async () => {
    const { token } = await seedAdminWithPermission({ moduleKey: 'compliance', action: 'view' });
    const res = await api('/api/v1/monitoring/health/system', { headers: bearer(token) });
    assert.equal(res.status, 403);
  });

  test('system probe returns a process snapshot', async () => {
    const { token } = await seedAdminWithPermission({ moduleKey: 'monitoring', action: 'view' });
    const res = await api('/api/v1/monitoring/health/system', { headers: bearer(token) });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.status, 'ok');
    assert.equal(typeof res.json.data.uptimeSec, 'number');
    assert.equal(typeof res.json.data.memory.rssBytes, 'number');
    assert.equal(typeof res.json.data.cpu.cores, 'number');
    assert.equal(typeof res.json.data.nodeVersion, 'string');
  });

  test('db probe pings MongoDB and reports ok', async () => {
    const { token } = await seedAdminWithPermission({ moduleKey: 'monitoring', action: 'view' });
    const res = await api('/api/v1/monitoring/health/db', { headers: bearer(token) });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.status, 'ok');
    assert.equal(typeof res.json.data.latencyMs, 'number');
  });

  test('websocket probe reports ok or degraded, never throws', async () => {
    const { token } = await seedAdminWithPermission({ moduleKey: 'monitoring', action: 'view' });
    const res = await api('/api/v1/monitoring/health/websocket', { headers: bearer(token) });
    assert.equal(res.status, 200);
    assert.ok(['ok', 'degraded'].includes(res.json.data.status));
    assert.equal(typeof res.json.data.latencyMs, 'number');
  });

  test('deferred probes return structured deferred results, not 501', async () => {
    const { token } = await seedAdminWithPermission({ moduleKey: 'monitoring', action: 'view' });
    for (const path of [
      '/api/v1/monitoring/health/queue',
      '/api/v1/monitoring/health/scheduler',
      '/api/v1/monitoring/health/storage',
      '/api/v1/monitoring/health/connectors',
    ]) {
      const res = await api(path, { headers: bearer(token) });
      assert.equal(res.status, 200, `${path} should be implemented`);
      assert.equal(res.json.data.status, 'deferred');
      assert.equal(res.json.data.phase, '3');
    }
  });

  test('metrics is a structured deferred payload', async () => {
    const { token } = await seedAdminWithPermission({ moduleKey: 'monitoring', action: 'view' });
    const res = await api('/api/v1/monitoring/metrics', { headers: bearer(token) });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.status, 'deferred');
    assert.equal(res.json.data.phase, '4');
  });

  test('aggregate fans out over live probes and is cached for 5 s', async () => {
    const { token } = await seedAdminWithPermission({ moduleKey: 'monitoring', action: 'view' });
    const headers = bearer(token);
    const res1 = await api('/api/v1/monitoring/health/aggregate', { headers });
    assert.equal(res1.status, 200);
    assert.equal(res1.json.data.system.status, 'ok');
    assert.equal(res1.json.data.db.status, 'ok');
    assert.ok(['ok', 'degraded'].includes(res1.json.data.websocket.status));
    assert.equal(res1.json.data.queue.status, 'deferred');
    assert.ok(['ok', 'degraded', 'down'].includes(res1.json.data.status));

    const res2 = await api('/api/v1/monitoring/health/aggregate', { headers });
    assert.equal(res2.status, 200);
    assert.equal(res2.json.data.checkedAt, res1.json.data.checkedAt, 'aggregate should be cached');
  });
});
