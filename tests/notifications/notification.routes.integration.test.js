/**
 * End-to-end HTTP integration tests for `/api/v1/notifications/*` (Sprint 7).
 * Covers inbox listing, unread count, mark-read (single + all), soft-delete,
 * preferences, and RBAC (401/403).
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
import notificationRepository from '../../src/repositories/notification.repository.js';
import { User } from '../../src/models/User.js';

const PASSWORD = 'Password123!';

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => { await resetMongo(); await rbacCache.clearAll(); });
after(async () => { await stopHttp(); await stopMongo(); });

async function onboard() {
  const ownerEmail = `owner-${shortToken(10).toLowerCase()}@example.com`;
  const owner = { email: ownerEmail, name: 'Owner', password: PASSWORD };
  const { tenant } = await tenantService.create({ tenant: { name: `Notif ${shortToken(10)}` }, owner, initialize: true, by: 'root' });
  const tenantId = tenant._id.toString();
  const login = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email: ownerEmail, password: PASSWORD } });
  assert.equal(login.status, 200);
  const user = await User.findOne({ tenantId, email: ownerEmail });
  return { tenantId, auth: { authorization: `Bearer ${login.json.data.accessToken}`, 'X-Tenant-Id': tenantId }, ownerId: user._id.toString() };
}

test('notification inbox: list, unread-count, mark-read, delete, preferences', async () => {
  const { auth, ownerId } = await onboard();
  const tid = auth['X-Tenant-Id'];

  await notificationRepository.create({ tenantId: tid, recipientId: ownerId, channel: 'in_app', type: 'alert', title: 'A', body: 'b' });
  await notificationRepository.create({ tenantId: tid, recipientId: ownerId, channel: 'in_app', type: 'alert', title: 'B', body: 'b' });

  const list = await api('/api/v1/notifications', { headers: auth });
  assert.equal(list.status, 200);
  assert.equal(list.json.data.length, 2);

  const count = await api('/api/v1/notifications/unread-count', { headers: auth });
  assert.equal(count.status, 200);
  assert.equal(count.json.data.count, 2);

  const firstId = list.json.data[0]._id;
  const read = await api(`/api/v1/notifications/${firstId}/read`, { method: 'POST', headers: auth });
  assert.equal(read.status, 200);

  const countAfter = await api('/api/v1/notifications/unread-count', { headers: auth });
  assert.equal(countAfter.json.data.count, 1);

  const allRead = await api('/api/v1/notifications/read-all', { method: 'POST', headers: auth });
  assert.equal(allRead.status, 204);
  const countNone = await api('/api/v1/notifications/unread-count', { headers: auth });
  assert.equal(countNone.json.data.count, 0);

  const del = await api(`/api/v1/notifications/${firstId}`, { method: 'DELETE', headers: auth });
  assert.equal(del.status, 204);

  const getPrefs = await api('/api/v1/notifications/preferences', { headers: auth });
  assert.equal(getPrefs.status, 200);
  const setPrefs = await api('/api/v1/notifications/preferences', { method: 'POST', headers: auth, body: { preferences: { digest: true } } });
  assert.equal(setPrefs.status, 200);
});

test('notification routes are 401 without a token and 403 without permission', async () => {
  const noAuth = await api('/api/v1/notifications');
  assert.equal(noAuth.status, 401);

  const { tenantId } = await onboard();
  const email = `nobody-${shortToken(10).toLowerCase()}@example.com`;
  await userRepository.create({ tenantId, email, status: 'active', passwordHash: await hash(PASSWORD), profile: { name: 'Nobody' } });
  const login = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email, password: PASSWORD } });
  const noRightsAuth = { authorization: `Bearer ${login.json.data.accessToken}`, 'X-Tenant-Id': tenantId };
  const denied = await api('/api/v1/notifications', { headers: noRightsAuth });
  assert.equal(denied.status, 403);
});
