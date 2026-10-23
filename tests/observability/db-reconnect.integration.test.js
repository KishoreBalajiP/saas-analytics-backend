/**
 * Boot-time MongoDB outage no longer leaves the web process degraded
 * forever (roadmap 2.8; findings ops.05, ops2.02).
 *
 *   - unit: `reconnectUntilConnected` retries with capped exponential
 *     backoff until a connect succeeds, and stops when aborted;
 *   - lifecycle: `src/server.js` is spawned against a MongoDB port where
 *     nothing listens (an in-memory server is started on that port later,
 *     never a real database). Liveness answers 200 and readiness 503 while
 *     the database is missing; once it appears the process reconnects by
 *     itself, starts its background work, turns ready, and still drains
 *     cleanly on SIGTERM.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { reconnectUntilConnected } from '../../src/config/database.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('reconnectUntilConnected backs off exponentially (capped) until connected', async () => {
  const waits = [];
  let attempts = 0;
  const connected = await reconnectUntilConnected({
    initialDelayMs: 100,
    maxDelayMs: 350,
    wait: async (ms) => { waits.push(ms); },
    connect: async () => {
      attempts += 1;
      if (attempts < 4) throw new Error('ECONNREFUSED');
      return true;
    },
  });
  assert.equal(connected, true);
  assert.equal(attempts, 4);
  assert.deepEqual(waits, [100, 200, 350, 350]);
});

test('reconnectUntilConnected stops when aborted', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const result = reconnectUntilConnected({
    initialDelayMs: 5,
    maxDelayMs: 5,
    signal: controller.signal,
    connect: async () => {
      attempts += 1;
      if (attempts === 3) controller.abort();
      throw new Error('still down');
    },
  });
  assert.equal(await result, false);
  assert.equal(attempts, 3);
});

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

test('web entry: recovers from a boot-time database outage without a restart', { timeout: 120000 }, async () => {
  const [httpPort, mongoPort] = [await freePort(), await freePort()];
  const child = spawn(process.execPath, [path.join(root, 'src/server.js')], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(httpPort),
      PROCESS_ROLE: 'all',
      MONGODB_URI: `mongodb://127.0.0.1:${mongoPort}/reconnect_test`,
      MONGODB_CONNECT_ATTEMPTS: '1',
      MONGODB_RETRY_DELAY_MS: '200',
      MONGODB_RECONNECT_MAX_DELAY_MS: '500',
      MONGODB_SERVER_SELECTION_TIMEOUT_MS: '500',
      MONGODB_CONNECT_TIMEOUT_MS: '500',
      REDIS_URL: '',
      MAIL_PROVIDER: 'none',
      SHUTDOWN_TIMEOUT_MS: '6000',
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const waitFor = async (pattern, timeoutMs = 30000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (pattern.test(output)) return true;
      if (child.exitCode !== null) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };
  const get = async (p) => {
    const res = await fetch(`http://127.0.0.1:${httpPort}${p}`);
    return { status: res.status, body: await res.json() };
  };

  let mongo = null;
  try {
    assert.ok(await waitFor(/is running/), output);
    assert.ok(await waitFor(/MongoDB background reconnect failed/), `keeps retrying:\n${output}`);
    assert.doesNotMatch(output, /Background work started/, 'no jobs run without a database');

    const live = await get('/api/v1/health');
    assert.equal(live.status, 200);
    assert.equal(live.body.data.db, 'disconnected');
    const notReady = await get('/api/v1/health/ready');
    assert.equal(notReady.status, 503);
    assert.equal(notReady.body.data.checks.database, 'down');

    // The database comes back on the same port.
    mongo = await MongoMemoryServer.create({ instance: { port: mongoPort, ip: '127.0.0.1' } });
    assert.ok(await waitFor(/MongoDB connected after background reconnect/, 60000), output);
    assert.ok(await waitFor(/Background work started/), output);

    let ready = null;
    for (let i = 0; i < 40; i += 1) {
      ready = await get('/api/v1/health/ready');
      if (ready.status === 200) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(ready.status, 200, JSON.stringify(ready.body));
    assert.equal(ready.body.data.checks.database, 'ok');
    assert.equal((await get('/api/v1/health')).body.data.db, 'connected');

    child.kill('SIGTERM');
    const exit = await exited;
    // Windows reports the delivered SIGTERM as the exit signal even when the
    // handler completes its graceful shutdown and calls process.exit(0).
    assert.ok(exit.code === 0 || exit.signal === 'SIGTERM', `${JSON.stringify(exit)}\n${output}`);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await mongo?.stop();
  }
});
