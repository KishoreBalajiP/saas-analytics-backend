/**
 * HTTP surface of /api/v1/delivery (roadmap 3.4): permission checks,
 * tenant isolation, secrets never echoed, public unsubscribe.
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
import delivery from '../../src/services/delivery/index.js';

const PASSWORD = 'Password123!';
const URL_SECRET = 'https://93.184.216.34/services/T000/B000/topsecret';

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => { await resetMongo(); await rbacCache.clearAll(); });
after(async () => { await stopHttp(); await stopMongo(); });

async function login(tenantId, email) {
  const res = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email, password: PASSWORD } });
  assert.equal(res.status, 200);
  return { authorization: `Bearer ${res.json.data.accessToken}`, 'X-Tenant-Id': tenantId };
}

async function onboard() {
  const owner = { email: `owner-${shortToken(10).toLowerCase()}@example.com`, name: 'Owner', password: PASSWORD };
  const { tenant } = await tenantService.create({ tenant: { name: `Del ${shortToken(10)}` }, owner, initialize: true, by: 'root' });
  const tenantId = tenant._id.toString();
  return { tenantId, auth: await login(tenantId, owner.email) };
}

test('destinations: create hides the URL, permission and tenant isolation enforced', async () => {
  const a = await onboard();
  const b = await onboard();
  const created = await api('/api/v1/delivery/destinations', { method: 'POST', headers: a.auth, body: { type: 'slack', name: 'Ops', url: URL_SECRET } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(JSON.stringify(created.json).includes('topsecret'), false);

  const blocked = await api('/api/v1/delivery/destinations', { method: 'POST', headers: a.auth, body: { type: 'webhook', name: 'L', url: 'https://127.0.0.1/x' } });
  assert.equal(blocked.status, 400);

  const listA = await api('/api/v1/delivery/destinations', { headers: a.auth });
  assert.equal(listA.json.data.length, 1);
  assert.equal(JSON.stringify(listA.json).includes('topsecret'), false);
  const listB = await api('/api/v1/delivery/destinations', { headers: b.auth });
  assert.equal(listB.json.data.length, 0);
  const delB = await api(`/api/v1/delivery/destinations/${created.json.data._id}`, { method: 'DELETE', headers: b.auth });
  assert.equal(delB.status, 404);

  const email = `nobody-${shortToken(8).toLowerCase()}@example.com`;
  await userRepository.create({ tenantId: a.tenantId, email, status: 'active', passwordHash: await hash(PASSWORD), profile: { name: 'Nobody' } });
  const noRights = await login(a.tenantId, email);
  assert.equal((await api('/api/v1/delivery/destinations', { headers: noRights })).status, 403);
  assert.equal((await api('/api/v1/delivery/deliveries', { headers: noRights })).status, 403);
});

test('deliveries history is tenant-scoped; unsubscribe is public and token-checked', async () => {
  const a = await onboard();
  const b = await onboard();
  await delivery.deliver({ tenantId: a.tenantId, kind: 'report', destination: { type: 'email', to: 'x@example.org' }, payload: { template: 'report.delivered', variables: { reportName: 'R' } }, idempotencyKey: 'h1' });
  const listA = await api('/api/v1/delivery/deliveries', { headers: a.auth });
  assert.equal(listA.status, 200);
  assert.equal(listA.json.data.length, 1);
  assert.equal(listA.json.data[0].payload, undefined);
  const listB = await api('/api/v1/delivery/deliveries', { headers: b.auth });
  assert.equal(listB.json.data.length, 0);
  const retryB = await api(`/api/v1/delivery/deliveries/${listA.json.data[0]._id}/retry`, { method: 'POST', headers: b.auth });
  assert.equal(retryB.status, 404);

  const bad = await api('/api/v1/delivery/unsubscribe', { method: 'POST', body: { token: 'forged.sig' } });
  assert.equal(bad.status, 400);
  const ok = await api('/api/v1/delivery/unsubscribe', { method: 'POST', body: { token: delivery.unsubscribeToken(a.tenantId, 'x@example.org') } });
  assert.equal(ok.status, 200);
});
