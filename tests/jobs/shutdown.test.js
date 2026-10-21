/**
 * Durable jobs (roadmap 1.4): graceful shutdown order and bounds
 * (findings ops.06, con.09, ops2.08).
 *
 * Exit criterion covered here: shutdown closes sockets, the scheduler,
 * workers/queues, Redis-backed resources and the database in order, within
 * the timeout (unit test with fakes), plus one real HTTP + Socket.IO server
 * with a connected WebSocket client to prove open sockets no longer hold the
 * server open.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { buildShutdownSteps, runShutdownSteps, closeHttpServer } from '../../src/jobs/shutdown.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const silent = { warn() {}, info() {}, error() {} };

/** Fakes that record the order in which shutdown touches them. */
function fakes({ queueDrainMs = 0, queueHangs = false, schedulerDrainMs = 0 } = {}) {
  const events = [];
  const server = {
    closeIdleConnections() { events.push('server.closeIdleConnections'); },
    closeAllConnections() { events.push('server.closeAllConnections'); },
    close(cb) { events.push('server.close'); setTimeout(() => { events.push('server.closed'); cb?.(); }, 5); },
  };
  const io = {
    // Socket.IO disconnects every client first; its own HTTP close comes
    // after the adapter closes, so shutdown closes the engine and the
    // server directly as well.
    close() {
      events.push('io.close(sockets)');
      return new Promise(() => {}); // e.g. an adapter waiting on Redis
    },
    engine: { close() { events.push('io.engine.close'); } },
  };
  const deps = {
    async stopScheduler({ timeoutMs }) {
      events.push(`scheduler.stop(${timeoutMs > 0 ? 'bounded' : 'zero'})`);
      await sleep(schedulerDrainMs);
      return { drained: true };
    },
    async closeQueues({ drainTimeoutMs }) {
      events.push('queues.close');
      if (queueHangs) await new Promise(() => {});
      await sleep(Math.min(queueDrainMs, drainTimeoutMs));
      events.push('queues.closed');
      return [{ name: 'connector.sync', drained: queueDrainMs <= drainTimeoutMs }];
    },
    async closeLocks() { events.push('locks.close'); },
    async closeSocketAdapter() { events.push('socketAdapter.close'); },
    async flushAccessLog() { events.push('accessLog.flush'); },
    async closeCache() { events.push('cache.close'); },
    async closeMail() { events.push('mail.close'); },
    async closeStorage() { events.push('storage.close'); },
    async disconnectDatabase() { events.push('db.disconnect'); },
  };
  return { events, server, io, deps };
}

test('shutdown runs every step in order: sockets+http, scheduler, queues, redis resources, database', async () => {
  const { events, server, io, deps } = fakes({ queueDrainMs: 20 });
  const outcome = await runShutdownSteps(
    buildShutdownSteps({ server, io, drainTimeoutMs: 1000, deps }),
    { timeoutMs: 5000, log: silent },
  );
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.deepEqual(outcome.steps.map((s) => s.name), [
    'http', 'scheduler', 'queues', 'locks', 'socket-adapter', 'access-log', 'cache', 'mail', 'storage', 'database',
  ]);
  assert.deepEqual(events, [
    'server.closeIdleConnections',
    'io.close(sockets)',
    'io.engine.close',
    'server.close',
    'server.closed',
    'scheduler.stop(bounded)',
    'queues.close',
    'queues.closed',
    'locks.close',
    'socketAdapter.close',
    'accessLog.flush',
    'cache.close',
    'mail.close',
    'storage.close',
    'db.disconnect',
  ]);
  // Socket clients are closed before (not after) the HTTP server finishes.
  assert.ok(events.indexOf('io.close(sockets)') < events.indexOf('server.closed'));
});

test('a queue drain that hangs is cut off; the database is still disconnected within the timeout', async () => {
  const { events, server, io, deps } = fakes({ queueHangs: true });
  const t0 = Date.now();
  const outcome = await runShutdownSteps(
    buildShutdownSteps({ server, io, drainTimeoutMs: 300, deps }),
    { timeoutMs: 5000, log: silent },
  );
  const elapsed = Date.now() - t0;
  assert.equal(outcome.ok, false);
  const queues = outcome.steps.find((s) => s.name === 'queues');
  assert.equal(queues.status, 'timeout');
  // The hung transport is cut off at drain budget + close margin, so every
  // later step still runs and the whole shutdown stays far inside 5 s.
  for (const later of ['locks.close', 'accessLog.flush', 'cache.close', 'mail.close', 'storage.close', 'db.disconnect']) {
    assert.ok(events.includes(later), `${later} still ran`);
  }
  assert.equal(outcome.steps.at(-1).status, 'ok');
  assert.ok(elapsed < 300 + 1500 + 500, `finished in ${elapsed}ms`);
});

test('the database is closed even when earlier steps used up the whole deadline', async () => {
  const { events, deps } = fakes({ schedulerDrainMs: 400 });
  const outcome = await runShutdownSteps(buildShutdownSteps({ drainTimeoutMs: 1000, deps }), { timeoutMs: 200, log: silent });
  assert.equal(outcome.steps.find((s) => s.name === 'scheduler').status, 'timeout');
  assert.equal(outcome.steps.find((s) => s.name === 'cache').status, 'skipped');
  assert.equal(outcome.steps.at(-1).name, 'database');
  assert.equal(outcome.steps.at(-1).status, 'ok');
  assert.equal(events.at(-1), 'db.disconnect');
});

test('scheduler and queue drains share one budget', async () => {
  const seen = {};
  const { server, io, deps } = fakes();
  deps.stopScheduler = async ({ timeoutMs }) => { seen.scheduler = timeoutMs; await sleep(150); };
  deps.closeQueues = async ({ drainTimeoutMs }) => { seen.queues = drainTimeoutMs; };
  await runShutdownSteps(buildShutdownSteps({ server, io, drainTimeoutMs: 400, deps }), { timeoutMs: 5000, log: silent });
  assert.ok(seen.scheduler <= 400);
  assert.ok(seen.queues <= 400 - 140, `queues got ${seen.queues}ms after the scheduler used ~150ms`);
});

test('the real shutdown wiring provides every step (queues, Redis resources, storage, database)', async () => {
  const { defaultShutdownDeps } = await import('../../src/jobs/background.js');
  const deps = defaultShutdownDeps();
  for (const key of [
    'stopScheduler', 'closeQueues', 'closeLocks', 'closeSocketAdapter', 'flushAccessLog',
    'closeCache', 'closeMail', 'closeStorage', 'disconnectDatabase',
  ]) {
    assert.equal(typeof deps[key], 'function', `${key} is wired`);
  }
  const names = buildShutdownSteps({ server: {}, drainTimeoutMs: 100, deps }).map((s) => s.name);
  assert.deepEqual(names, [
    'http', 'scheduler', 'queues', 'locks', 'socket-adapter', 'access-log', 'cache', 'mail', 'storage', 'database',
  ]);
});

test('the web process also closes the auth rate-limit store with the other Redis resources', async () => {
  const { events, server, io, deps } = fakes();
  deps.closeRateLimitStore = async () => { events.push('rateLimit.close'); };
  const outcome = await runShutdownSteps(
    buildShutdownSteps({ server, io, drainTimeoutMs: 100, deps }),
    { timeoutMs: 5000, log: silent },
  );
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.deepEqual(outcome.steps.map((s) => s.name), [
    'http', 'scheduler', 'queues', 'locks', 'socket-adapter', 'rate-limit', 'access-log', 'cache', 'mail', 'storage', 'database',
  ]);
  assert.ok(events.indexOf('socketAdapter.close') < events.indexOf('rateLimit.close'));
  assert.ok(events.indexOf('rateLimit.close') < events.indexOf('db.disconnect'));

  // The real hook is a no-op without REDIS_URL (no connection was opened).
  const { closeRateLimitStore } = await import('../../src/middleware/rateLimiter.middleware.js');
  await closeRateLimitStore();
});

test('the worker process (no HTTP server) skips the http step', async () => {
  const { events, deps } = fakes();
  const outcome = await runShutdownSteps(buildShutdownSteps({ drainTimeoutMs: 100, deps }), { timeoutMs: 2000, log: silent });
  assert.equal(outcome.steps[0].name, 'scheduler');
  assert.equal(events.includes('server.close'), false);
  assert.equal(events.at(-1), 'db.disconnect');
});

test('a step that throws does not stop later steps', async () => {
  const { events, deps } = fakes();
  deps.closeCache = async () => { throw new Error('redis gone'); };
  const outcome = await runShutdownSteps(buildShutdownSteps({ drainTimeoutMs: 100, deps }), { timeoutMs: 2000, log: silent });
  assert.equal(outcome.steps.find((s) => s.name === 'cache').status, 'error');
  assert.equal(events.at(-1), 'db.disconnect');
});

test('a live Socket.IO WebSocket client no longer holds the HTTP server open', async () => {
  const server = http.createServer((_req, res) => res.end('ok'));
  const io = new SocketIOServer(server, { transports: ['websocket'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const connected = new Promise((resolve) => io.on('connection', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
  const clientClosed = new Promise((resolve) => ws.addEventListener('close', resolve));
  ws.addEventListener('message', (event) => {
    // Engine.IO open packet ("0{...}") -> join the default namespace ("40").
    if (String(event.data).startsWith('0')) ws.send('40');
  });
  await connected;
  assert.equal(io.engine.clientsCount, 1);

  const t0 = Date.now();
  const result = await closeHttpServer({ server, io, timeoutMs: 3000 });
  const elapsed = Date.now() - t0;
  assert.equal(result.forced, false, 'closed gracefully, not by the timeout');
  assert.ok(elapsed < 1500, `closed in ${elapsed}ms`);
  assert.equal(server.listening, false);
  await clientClosed;
});

test('Socket.IO uses the Redis adapter when Redis is configured, and its clients close on shutdown', async () => {
  const { attachRedisAdapter, closeSocketAdapter } = await import('../../src/websocket/index.js');
  const created = [];
  class FakeRedis {
    constructor(url) { this.url = url; this.status = 'ready'; this.quitCalled = false; created.push(this); }
    duplicate() { return new FakeRedis(this.url); }
    on() { return this; }
    async quit() { this.quitCalled = true; }
    disconnect() {}
  }
  let adapterArgs = null;
  const server = { adapterSet: null, adapter(a) { this.adapterSet = a; } };
  const attached = attachRedisAdapter(server, {
    url: 'redis://fake:6379',
    Redis: FakeRedis,
    adapterFactory: (pub, sub) => { adapterArgs = [pub, sub]; return 'redis-adapter'; },
  });
  assert.equal(attached, true);
  assert.equal(server.adapterSet, 'redis-adapter');
  assert.equal(created.length, 2, 'separate pub and sub connections');
  assert.deepEqual(adapterArgs, created);
  await closeSocketAdapter();
  assert.ok(created.every((c) => c.quitCalled));

  assert.equal(attachRedisAdapter({ adapter() {} }, { url: '' }), false, 'no Redis -> in-process adapter');
});
