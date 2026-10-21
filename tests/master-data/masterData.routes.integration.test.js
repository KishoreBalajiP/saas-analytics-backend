/**
 * Master-data HTTP surface (roadmap 2.1; findings adm.13, sec.12, tst.06):
 * writes need master_data.* permissions and are platform-wide, only
 * whitelisted fields are written, and the public search is escaped.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import { factories } from '../helpers/factories.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import { MasterData } from '../../src/models/MasterData.js';
import { seedPlatformRoles, adminSession } from '../platform-roles/helpers.js';

let superAdmin;
let platform;
let support;
let scopedPlatform;
let noRole;

before(async () => {
  await startMongo();
  await startHttp();
  await resetMongo();
  await rbacCache.clearAll();
  await MasterData.init();
  await seedPlatformRoles();
  const tenant = await factories.tenant.create();
  superAdmin = await adminSession({ adminType: 'super', roleName: 'super_admin' });
  platform = await adminSession({ adminType: 'platform', roleName: 'platform_admin' });
  support = await adminSession({ adminType: 'support', roleName: 'support_operator' });
  scopedPlatform = await adminSession({ adminType: 'platform', roleName: 'platform_admin', tenantScope: String(tenant._id) });
  noRole = await adminSession({ adminType: 'platform' });
});

after(async () => {
  await stopHttp();
  await stopMongo();
});

const create = (auth, body) => api('/api/v1/master-data/countries', { method: 'POST', headers: auth, body });

test('writes require a master_data permission, not just an admin token', async () => {
  for (const session of [noRole, support]) {
    const res = await create(session.auth, { code: 'zz', name: 'Nowhere' });
    assert.equal(res.status, 403);
    assert.equal(res.json.message, 'You do not have the "master_data.create" permission');
  }
  assert.equal(await MasterData.countDocuments({ code: 'zz' }), 0);
});

test('tenant-scoped admins cannot change platform-wide reference data', async () => {
  const res = await create(scopedPlatform.auth, { code: 'zy', name: 'Scoped' });
  assert.equal(res.status, 403);
  assert.equal(res.json.code, 'ADMIN_SCOPE_DENIED');
});

test('only whitelisted fields are written; isSystem and catalogue cannot be patched', async () => {
  const created = await create(platform.auth, {
    code: 'fr', name: 'France', locale: 'en', data: { iso2: 'FR' }, createdBy: 'forged', catalogue: 'plans',
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.data.catalogue, 'countries');
  assert.notEqual(created.json.data.createdBy, 'forged');

  const sys = await create(superAdmin.auth, { code: 'sys', name: 'System', isSystem: true });
  assert.equal(sys.status, 201);
  const patched = await api(`/api/v1/master-data/countries/${sys.json.data._id}`, {
    method: 'PATCH', headers: platform.auth, body: { isSystem: false, catalogue: 'plans', name: 'System entry' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.data.isSystem, true);
  assert.equal(patched.json.data.catalogue, 'countries');
  assert.equal(patched.json.data.name, 'System entry');

  const onlyForbidden = await api(`/api/v1/master-data/countries/${sys.json.data._id}`, {
    method: 'PATCH', headers: platform.auth, body: { isSystem: false },
  });
  assert.equal(onlyForbidden.status, 400);
  const del = await api(`/api/v1/master-data/countries/${sys.json.data._id}`, { method: 'DELETE', headers: superAdmin.auth });
  assert.equal(del.status, 409, 'system items still cannot be deleted');
});

test('platform admins cannot delete reference data (super only)', async () => {
  const created = await create(superAdmin.auth, { code: 'de', name: 'Germany' });
  const byPlatform = await api(`/api/v1/master-data/countries/${created.json.data._id}`, { method: 'DELETE', headers: platform.auth });
  assert.equal(byPlatform.status, 403);
  const bySuper = await api(`/api/v1/master-data/countries/${created.json.data._id}`, { method: 'DELETE', headers: superAdmin.auth });
  assert.equal(bySuper.status, 204);
});

test('the public search treats input literally and is length-capped', async () => {
  await create(superAdmin.auth, { code: 'aa', name: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!' });
  await create(superAdmin.auth, { code: 'dot', name: 'a.b' });
  const started = Date.now();
  const redos = await api(`/api/v1/master-data/countries?search=${encodeURIComponent('(a+)+$')}`);
  assert.equal(redos.status, 200);
  assert.deepEqual(redos.json.data, []);
  assert.ok(Date.now() - started < 2000);
  const invalidRegex = await api(`/api/v1/master-data/countries?search=${encodeURIComponent('[unclosed')}`);
  assert.equal(invalidRegex.status, 200);
  const literalDot = await api(`/api/v1/master-data/countries?search=${encodeURIComponent('a.b')}`);
  assert.deepEqual(literalDot.json.data.map((d) => d.code), ['dot']);
  const tooLong = await api(`/api/v1/master-data/countries?search=${'x'.repeat(65)}`);
  assert.equal(tooLong.status, 422);
});
