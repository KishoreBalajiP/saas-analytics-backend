/**
 * vizbuilder (roadmap 3.5): dashboard sharing enforced server-side over HTTP.
 * A restricted dashboard is invisible to non-shared members (404, absent
 * from lists); a `view` share reads but cannot edit (403); an `edit` share
 * edits; only the owner / dashboards.assign manage shares; principals of
 * another tenant are refused.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import { shortToken } from '../../src/utils/id.js';
import { hash } from '../../src/utils/password.js';
import * as tenantService from '../../src/services/tenant.service.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import userRepository from '../../src/repositories/user.repository.js';
import { Role } from '../../src/models/Role.js';
import { UserRole } from '../../src/models/UserRole.js';

const PASSWORD = 'Password123!';

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => { await resetMongo(); await rbacCache.clearAll(); });
after(async () => { await stopHttp(); await stopMongo(); });

async function login(tenantId, email) {
  const res = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email, password: PASSWORD } });
  assert.equal(res.status, 200);
  return { authorization: `Bearer ${res.json.data.accessToken}`, 'X-Tenant-Id': tenantId };
}

async function onboard() {
  const owner = { email: `owner-${shortToken(8).toLowerCase()}@example.com`, name: 'Owner', password: PASSWORD };
  const { tenant } = await tenantService.create({ tenant: { name: `Share ${shortToken(8)}` }, owner, initialize: true, by: 'root' });
  const tenantId = tenant._id.toString();
  return { tenantId, owner: await login(tenantId, owner.email) };
}

/** A Manager-role member (dashboards view/create/update, no assign). */
async function member(tenantId) {
  const email = `m-${shortToken(8).toLowerCase()}@example.com`;
  const user = await userRepository.create({ tenantId, email, status: 'active', passwordHash: await hash(PASSWORD), profile: { name: 'Member', locale: 'en', timezone: 'UTC' } });
  const role = await Role.findOne({ tenantId, name: 'Manager' }).lean();
  await UserRole.create({ tenantId, userId: String(user._id), roleId: String(role._id) });
  return { userId: String(user._id), roleId: String(role._id), auth: await login(tenantId, email) };
}

test('restricted dashboards: view vs edit shares, non-shared users denied', async () => {
  const { tenantId, owner } = await onboard();
  const alice = await member(tenantId);
  const bob = await member(tenantId);

  const created = await api('/api/v1/dashboards', { method: 'POST', headers: owner, body: { name: 'Board' } });
  const id = created.json.data._id;

  // Workspace visibility (default): RBAC decides, members see it.
  assert.equal((await api(`/api/v1/dashboards/${id}`, { headers: alice.auth })).status, 200);

  // Only the owner / dashboards.assign may restrict it.
  assert.equal((await api(`/api/v1/dashboards/${id}`, { method: 'PATCH', headers: alice.auth, body: { visibility: 'restricted' } })).status, 403);
  assert.equal((await api(`/api/v1/dashboards/${id}`, { method: 'PATCH', headers: owner, body: { visibility: 'restricted' } })).status, 200);

  // Not shared: 404 and absent from the list.
  assert.equal((await api(`/api/v1/dashboards/${id}`, { headers: alice.auth })).status, 404);
  assert.equal((await api(`/api/v1/dashboards/${id}/execute`, { headers: alice.auth })).status, 404);
  const listA = await api('/api/v1/dashboards', { headers: alice.auth });
  assert.equal(listA.json.data.length, 0);

  // Members cannot share.
  const denied = await api(`/api/v1/dashboards/${id}/share`, { method: 'POST', headers: alice.auth, body: { principalType: 'user', principalId: alice.userId, level: 'edit' } });
  assert.equal(denied.status, 404);

  // View share for alice: read yes, edit no.
  const s1 = await api(`/api/v1/dashboards/${id}/share`, { method: 'POST', headers: owner, body: { principalType: 'user', principalId: alice.userId, level: 'view' } });
  assert.equal(s1.status, 201, JSON.stringify(s1.json));
  const got = await api(`/api/v1/dashboards/${id}`, { headers: alice.auth });
  assert.equal(got.status, 200);
  assert.equal(got.json.data.access, 'view');
  assert.equal(got.json.data.shares, undefined, 'share list is for managers only');
  const patch = await api(`/api/v1/dashboards/${id}`, { method: 'PATCH', headers: alice.auth, body: { name: 'Mine' } });
  assert.equal(patch.status, 403);
  assert.equal(patch.json.code, 'DASHBOARD_ACCESS_DENIED');
  assert.equal((await api(`/api/v1/dashboards/${id}/shares`, { headers: alice.auth })).status, 403);
  assert.equal((await api('/api/v1/dashboards', { headers: alice.auth })).json.data.length, 1);

  // Bob is still denied.
  assert.equal((await api(`/api/v1/dashboards/${id}`, { headers: bob.auth })).status, 404);

  // Role share at edit level covers bob (Manager role).
  const s2 = await api(`/api/v1/dashboards/${id}/share`, { method: 'POST', headers: owner, body: { principalType: 'role', principalId: bob.roleId, level: 'edit' } });
  assert.equal(s2.status, 201);
  assert.equal((await api(`/api/v1/dashboards/${id}`, { method: 'PATCH', headers: bob.auth, body: { name: 'Edited' } })).status, 200);

  // Owner lists and revokes.
  const shares = await api(`/api/v1/dashboards/${id}/shares`, { headers: owner });
  assert.equal(shares.status, 200);
  assert.equal(shares.json.data.visibility, 'restricted');
  assert.equal(shares.json.data.shares.length, 2);
  assert.ok(shares.json.data.candidates.users.some((u) => u.id === alice.userId));
  assert.ok(shares.json.data.shares.some((x) => x.principalName === 'Manager'));
  assert.equal((await api(`/api/v1/dashboards/${id}/share/${s2.json.data._id}`, { method: 'DELETE', headers: owner })).status, 204);
  assert.equal((await api(`/api/v1/dashboards/${id}`, { headers: bob.auth })).status, 404);
});

test('share principals must belong to the tenant', async () => {
  const a = await onboard();
  const b = await onboard();
  const outsider = await member(b.tenantId);
  const created = await api('/api/v1/dashboards', { method: 'POST', headers: a.owner, body: { name: 'Board' } });
  const id = created.json.data._id;
  const res = await api(`/api/v1/dashboards/${id}/share`, { method: 'POST', headers: a.owner, body: { principalType: 'user', principalId: outsider.userId } });
  assert.equal(res.status, 400);
  // And another tenant cannot touch the dashboard at all.
  assert.equal((await api(`/api/v1/dashboards/${id}/shares`, { headers: b.owner })).status, 404);
});
