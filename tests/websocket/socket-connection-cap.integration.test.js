/**
 * Socket.IO per-identity connection cap (sec.14).
 *
 * Runs in its own process with a small `SOCKET_MAX_CONNECTIONS_PER_IDENTITY`
 * set BEFORE the app is imported: one identity may hold at most that many
 * open sockets on an instance; further handshakes are refused with
 * `RATE_LIMITED`, other identities are unaffected, and closing a socket
 * frees a slot.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.SOCKET_MAX_CONNECTIONS_PER_IDENTITY = '2';

const { startMongo, stopMongo, resetMongo } = await import('../helpers/mongo.js');
const { createPollingClient } = await import('../helpers/socketPolling.js');
const { factories } = await import('../helpers/factories.js');
const { default: app } = await import('../../src/app.js');
const { initSocket, getIO } = await import('../../src/websocket/index.js');
const { default: authService } = await import('../../src/modules/iam/auth/auth.service.js');
const { default: queueService } = await import('../../src/services/queue.service.js');

let server;
let client;

before(async () => {
  await startMongo();
  server = http.createServer(app);
  initSocket(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  client = createPollingClient(`http://127.0.0.1:${server.address().port}/socket.io/?EIO=4&transport=polling`);
});
beforeEach(async () => { await resetMongo(); });
after(async () => {
  getIO()?.close();
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
  await queueService.closeAll();
  await stopMongo();
});

async function signedInUser() {
  const tenant = await factories.tenant.create();
  const user = await factories.user.create({ tenantId: tenant._id.toString() });
  const login = await authService.login({
    portal: 'user', email: user.email, password: 'Password123!', tenantId: tenant._id.toString(),
  });
  return login.accessToken;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('one identity may hold at most the configured number of sockets', async () => {
  const token = await signedInUser();
  const first = await client.connect({ token });
  const second = await client.connect({ token });
  assert.equal(first.connected, true);
  assert.equal(second.connected, true);

  const third = await client.connect({ token });
  assert.equal(third.connected, false);
  assert.equal(client.connectError(third.packet).data.code, 'RATE_LIMITED');

  // Another identity is unaffected.
  const other = await client.connect({ token: await signedInUser() });
  assert.equal(other.connected, true);

  // Closing a socket frees a slot.
  await client.close(first.sid);
  await settle();
  const again = await client.connect({ token });
  assert.equal(again.connected, true);
});
