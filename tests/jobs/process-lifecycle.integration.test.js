/**
 * Durable jobs (roadmap 1.4): process roles and real SIGTERM drains.
 *
 * Spawns the actual entry points (`src/server.js`, `src/worker.js`) against
 * the in-memory MongoDB of this test process (never a real database), sends
 * SIGTERM and asserts a clean exit inside SHUTDOWN_TIMEOUT_MS - for the web
 * server with a live Socket.IO WebSocket client connected (findings ops.06,
 * ops2.08). Also checks PROCESS_ROLE validation.
 *
 * The web entry's Socket.IO server requires an access token at the
 * handshake (sec.14), so the live client signs in over HTTP first and
 * presents its token in the CONNECT packet; an anonymous CONNECT on the same
 * server is refused with connect_error.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startMongo, stopMongo, getMongoUri } from '../helpers/mongo.js';
import { factories } from '../helpers/factories.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHUTDOWN_TIMEOUT_MS = 6000;

let mongoUri = null;
before(async () => {
  await startMongo();
  mongoUri = getMongoUri();
});
after(async () => { await stopMongo(); });

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

/**
 * Spawn an entry point and collect its output. On Windows `child.kill()` uses
 * TerminateProcess (POSIX signals are never delivered), so the child is
 * started through a shim that emits SIGTERM in-process on request; elsewhere
 * a real SIGTERM is sent.
 */
const signalViaIpc = process.platform === 'win32';

function launch(entry, extraEnv = {}) {
  const args = signalViaIpc
    ? [path.join(root, 'tests/helpers/entry-self-signal.js'), path.join(root, entry)]
    : [path.join(root, entry)];
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      MONGODB_URI: mongoUri,
      MONGODB_CONNECT_ATTEMPTS: '1',
      REDIS_URL: '',
      MAIL_PROVIDER: 'none',
      SHUTDOWN_TIMEOUT_MS: String(SHUTDOWN_TIMEOUT_MS),
      LOG_LEVEL: 'info',
      ...extraEnv,
    },
    stdio: signalViaIpc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return {
    child,
    exited,
    output: () => output,
    async terminate() {
      if (signalViaIpc) {
        await new Promise((resolve, reject) => {
          child.send('shutdown', (err) => (err ? reject(err) : resolve()));
        });
        return;
      }
      child.kill('SIGTERM');
    },
    async waitFor(pattern, timeoutMs = 15000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (pattern.test(output)) return true;
        if (child.exitCode !== null) return false;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    },
  };
}

test('worker entry: starts consumers + scheduler without HTTP and drains on SIGTERM', async () => {
  const proc = launch('src/worker.js');
  try {
    assert.ok(await proc.waitFor(/"msg":"Worker started"/), proc.output());
    assert.match(proc.output(), /Queue consumers registered/);
    assert.match(proc.output(), /Job scheduled/);
    assert.doesNotMatch(proc.output(), /is running/, 'the worker serves no HTTP');

    const t0 = Date.now();
    await proc.terminate();
    const { code } = await proc.exited;
    assert.equal(code, 0, proc.output());
    assert.ok(Date.now() - t0 < SHUTDOWN_TIMEOUT_MS, 'drained within the shutdown timeout');
    assert.match(proc.output(), /Worker shutdown complete/);
  } finally {
    if (proc.child.exitCode === null) proc.child.kill('SIGKILL');
  }
});

/**
 * Open a raw Engine.IO WebSocket and send the Socket.IO CONNECT packet with
 * `auth`. Resolves with the server's answer to the CONNECT: `40{...}`
 * (connected) or `44{...}` (connect_error).
 */
function openSocket(port, auth) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
  const closed = new Promise((resolve) => ws.addEventListener('close', resolve));
  const answered = new Promise((resolve, reject) => {
    ws.addEventListener('message', (event) => {
      const packet = String(event.data);
      // Engine.IO open packet ("0{...}") -> CONNECT to the default namespace.
      if (packet.startsWith('0')) ws.send(`40${auth ? JSON.stringify(auth) : ''}`);
      else if (packet.startsWith('40') || packet.startsWith('44')) resolve(packet);
    });
    ws.addEventListener('error', reject);
  });
  return { ws, closed, answered };
}

test('web entry: SIGTERM with a live Socket.IO client exits 0 inside SHUTDOWN_TIMEOUT_MS', async () => {
  const port = await freePort();
  const proc = launch('src/server.js', { PORT: String(port), PROCESS_ROLE: 'all' });
  const sockets = [];
  try {
    assert.ok(await proc.waitFor(/is running/), proc.output());
    assert.ok(await proc.waitFor(/Background work started/), proc.output());

    // A signed-in user (same in-memory database as the child process).
    const tenant = await factories.tenant.create();
    const user = await factories.user.create({ tenantId: tenant._id.toString() });
    const login = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': tenant._id.toString() },
      body: JSON.stringify({ email: user.email, password: 'Password123!' }),
    });
    const loginBody = await login.json();
    assert.equal(login.status, 200, JSON.stringify(loginBody));
    const token = loginBody.data.accessToken;

    // Handshake auth runs on the real entry point: anonymous is refused.
    const anonymous = openSocket(port, null);
    sockets.push(anonymous.ws);
    const refused = await anonymous.answered;
    assert.ok(refused.startsWith('44'), `connect_error expected, got ${refused}`);
    assert.equal(JSON.parse(refused.slice(2)).data.code, 'UNAUTHORIZED');

    // The live client: connected to the namespace with its access token.
    const live = openSocket(port, { token });
    sockets.push(live.ws);
    const accepted = await live.answered;
    assert.ok(accepted.startsWith('40'), `connected expected, got ${accepted}`);

    const t0 = Date.now();
    await proc.terminate();
    const { code } = await proc.exited;
    const elapsed = Date.now() - t0;
    assert.equal(code, 0, proc.output());
    assert.ok(elapsed < SHUTDOWN_TIMEOUT_MS, `exited in ${elapsed}ms`);
    assert.match(proc.output(), /Shutdown complete/);
    assert.doesNotMatch(proc.output(), /forcing exit/);
    // Shutdown closed both sockets (authenticated and refused).
    await Promise.all([live.closed, anonymous.closed]);
  } finally {
    for (const ws of sockets) ws.close();
    if (proc.child.exitCode === null) proc.child.kill('SIGKILL');
  }
});

test('web role: serves HTTP but starts no consumers or scheduler', async () => {
  // PROCESS_ROLE=web needs REDIS_URL; point it at an unroutable host - the
  // web role never connects at boot (queues are created lazily).
  const port = await freePort();
  const proc = launch('src/server.js', { PORT: String(port), PROCESS_ROLE: 'web', REDIS_URL: 'redis://127.0.0.1:1' });
  try {
    assert.ok(await proc.waitFor(/Background work not started/), proc.output());
    assert.doesNotMatch(proc.output(), /Job scheduled/);
    assert.doesNotMatch(proc.output(), /Queue consumers registered/);
    await proc.terminate();
    const { code } = await proc.exited;
    assert.equal(code, 0, proc.output());
  } finally {
    if (proc.child.exitCode === null) proc.child.kill('SIGKILL');
  }
});

test('PROCESS_ROLE is validated at startup', () => {
  const moduleUrl = new URL('../../src/config/env.js', import.meta.url).href;
  const load = (env) => spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(moduleUrl)})`], {
    env: { ...process.env, NODE_ENV: 'development', ...env },
    encoding: 'utf8',
  });
  const bogus = load({ PROCESS_ROLE: 'janitor' });
  assert.notEqual(bogus.status, 0);
  assert.match(bogus.stderr, /Invalid PROCESS_ROLE/);

  const webWithoutRedis = load({ PROCESS_ROLE: 'web', REDIS_URL: '' });
  assert.notEqual(webWithoutRedis.status, 0);
  assert.match(webWithoutRedis.stderr, /PROCESS_ROLE=web requires REDIS_URL/);

  const all = load({ PROCESS_ROLE: 'all', REDIS_URL: '' });
  assert.equal(all.status, 0, all.stderr);
  const worker = load({ PROCESS_ROLE: 'worker', REDIS_URL: '' });
  assert.equal(worker.status, 0, worker.stderr);
});

