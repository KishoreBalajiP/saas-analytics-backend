/**
 * Socket.IO handshake authentication and room authorisation (sec.14).
 *
 * No socket.io-client is installed, so the tests speak the Engine.IO v4
 * long-polling protocol directly over HTTP (`tests/helpers/socketPolling.js`).
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { createPollingClient } from '../helpers/socketPolling.js';
import { factories } from '../helpers/factories.js';
import app from '../../src/app.js';
import { initSocket, getIO } from '../../src/websocket/index.js';
import authService from '../../src/modules/iam/auth/auth.service.js';
import userRepository from '../../src/repositories/user.repository.js';
import queueService from '../../src/services/queue.service.js';
import permissionService from '../../src/services/permission.service.js';
import roleService from '../../src/services/role.service.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import { Dashboard } from '../../src/models/Dashboard.js';
import { UserRole } from '../../src/models/UserRole.js';

let server;
let base;
let client;

before(async () => {
  await startMongo();
  server = http.createServer(app);
  initSocket(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/socket.io/?EIO=4&transport=polling`;
  client = createPollingClient(base);
});
beforeEach(async () => { await resetMongo(); await rbacCache.clearAll(); });
after(async () => {
  getIO()?.close();
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
  await queueService.closeAll();
  await stopMongo();
});

/* --------------------------- engine.io client ---------------------------- */

const connect = (...args) => client.connect(...args);
const poll = (...args) => client.poll(...args);
const emitWithAck = (...args) => client.emitWithAck(...args);

/* -------------------------------- fixtures ------------------------------- */

async function signedInUser() {
  const tenant = await factories.tenant.create();
  const user = await factories.user.create({ tenantId: tenant._id.toString() });
  const login = await authService.login({
    portal: 'user', email: user.email, password: 'Password123!', tenantId: tenant._id.toString(),
  });
  return { tenant, user, token: login.accessToken, tenantId: tenant._id.toString() };
}

/** Give a user a tenant role carrying `dashboards.view`. */
async function grantDashboardView({ user, tenantId }) {
  // The catalogue entry may already exist from an earlier call (409); a real
  // failure still surfaces in `addPermission` below.
  await permissionService.createModule({ key: 'dashboards', name: 'Dashboards' }).catch(() => {});
  await permissionService.createPermission({ module: 'dashboards', action: 'view' }).catch(() => {});
  const role = await roleService.create({ tenantId, name: `viewer_${String(user._id).slice(-6)}` });
  await roleService.addPermission({ roleId: role._id, permissionKey: 'dashboards.view' });
  await new UserRole({ tenantId, userId: String(user._id), roleId: role._id, grantedBy: 'test' }).save();
}

/* --------------------------------- tests --------------------------------- */

test('a handshake without a token is rejected', async () => {
  const res = await connect({});
  assert.equal(res.connected, false);
  assert.ok(res.packet.startsWith('44'), `connect_error expected, got ${res.packet}`);
  const error = JSON.parse(res.packet.slice(2));
  assert.equal(error.data.code, 'UNAUTHORIZED');
});

test('a handshake with an invalid token is rejected', async () => {
  const res = await connect({ token: 'not-a-jwt' });
  assert.equal(res.connected, false);
  assert.ok(res.packet.startsWith('44'));
});

test('a token for a suspended account is rejected at the handshake', async () => {
  const a = await signedInUser();
  await userRepository.suspend(a.user._id, a.tenantId, 'test');
  const res = await connect({ token: a.token });
  assert.equal(res.connected, false);
  assert.equal(JSON.parse(res.packet.slice(2)).data.code, 'ACCOUNT_SUSPENDED');
});

test('a valid token connects (auth payload or Authorization header)', async () => {
  const a = await signedInUser();
  assert.equal((await connect({ token: a.token })).connected, true);
  assert.equal((await connect({}, { authorization: `Bearer ${a.token}` })).connected, true);
});

test('a socket may join its own tenant and dashboards, never another tenant\'s', async () => {
  const a = await signedInUser();
  const b = await signedInUser();
  await grantDashboardView(a);
  await grantDashboardView(b);
  const dashA = await Dashboard.create({ tenantId: a.tenantId, name: 'A board' });
  const dashB = await Dashboard.create({ tenantId: b.tenantId, name: 'B board' });
  const { sid, connected } = await connect({ token: a.token });
  assert.equal(connected, true);

  const own = await emitWithAck(sid, 'room:join', { room: `tenant:${a.tenantId}` });
  assert.equal(own.ok, true);
  const ownDashboard = await emitWithAck(sid, 'room:join', { room: `dashboard:${dashA._id}` });
  assert.equal(ownDashboard.ok, true);

  const crossTenant = await emitWithAck(sid, 'room:join', { room: `tenant:${b.tenantId}` });
  assert.equal(crossTenant.ok, false);
  assert.equal(crossTenant.error.code, 'FORBIDDEN');
  const crossDashboard = await emitWithAck(sid, 'room:join', { room: `dashboard:${dashB._id}` });
  assert.equal(crossDashboard.ok, false);
  const arbitrary = await emitWithAck(sid, 'room:join', { room: 'app:all' });
  assert.equal(arbitrary.ok, false);
  const malformed = await emitWithAck(sid, 'room:join', { room: 'dashboard:not-an-id' });
  assert.equal(malformed.ok, false);
});

test('a dashboard room needs dashboards.view, even inside the own tenant', async () => {
  const a = await signedInUser();
  const dashA = await Dashboard.create({ tenantId: a.tenantId, name: 'A board' });
  const { sid, connected } = await connect({ token: a.token });
  assert.equal(connected, true);

  // Same tenant, but the member holds no role that may view dashboards.
  const refused = await emitWithAck(sid, 'room:join', { room: `dashboard:${dashA._id}` });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'FORBIDDEN');
  // Their own tenant room stays available.
  assert.equal((await emitWithAck(sid, 'room:join', { room: `tenant:${a.tenantId}` })).ok, true);
});

test('a socket receives its own tenant\'s events and never another tenant\'s', async () => {
  const a = await signedInUser();
  const b = await signedInUser();
  const { sid, connected } = await connect({ token: a.token });
  assert.equal(connected, true);

  // The server joined the socket to its tenant room at connect time.
  getIO().to(`tenant:${b.tenantId}`).emit('dashboard:updated', { tenant: 'B' });
  getIO().to(`tenant:${a.tenantId}`).emit('dashboard:updated', { tenant: 'A' });
  const packets = await poll(sid);
  const events = packets.filter((p) => p.startsWith('42')).map((p) => JSON.parse(p.slice(2)));
  assert.deepEqual(events, [['dashboard:updated', { tenant: 'A' }]]);
});
