/**
 * Durable jobs (roadmap 1.4): queue producers fail fast with typed errors
 * during a Redis outage (finding ops2.13), and queues drain on close.
 *
 * Exit criterion covered here: a queue producer timeout returns a typed
 * error. The BullMQ handle is exercised with injected fake drivers (no Redis
 * server is needed or contacted).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueue, closeAll } from '../../src/queues/index.js';
import { QueueError, QUEUE_ERROR_CODES, guardProducer } from '../../src/queues/errors.js';
import { createInMemoryQueue } from '../../src/queues/memory.queue.js';
import * as queueService from '../../src/services/queue.service.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fake BullMQ/ioredis drivers recording what the handle does. */
function fakeDrivers({ add, workerClose, ping, forceCloseHangs = false, queueCloseHangs = false } = {}) {
  const calls = { connections: [], queues: [], workers: [], quit: 0 };
  class Redis {
    constructor(url, opts) {
      this.url = url;
      this.opts = opts;
      calls.connections.push(this);
    }
    on() { return this; }
    ping() { return ping ? ping() : Promise.resolve('PONG'); }
    async quit() { calls.quit += 1; }
    disconnect() {}
  }
  class Queue {
    constructor(name, opts) {
      this.name = name;
      this.opts = opts;
      this.closed = false;
      calls.queues.push(this);
    }
    on() { return this; }
    off() { return this; }
    add(...args) { return add ? add(...args) : Promise.resolve({ id: '1', name: args[0] }); }
    async getJobCounts() { return { waiting: 2, active: 1, delayed: 0, failed: 0, completed: 5, paused: 0 }; }
    close() {
      if (queueCloseHangs) return new Promise(() => {});
      this.closed = true;
      return Promise.resolve();
    }
    async disconnect() { this.disconnected = true; }
  }
  class Worker {
    constructor(name, processor, opts) {
      this.name = name;
      this.processor = processor;
      this.opts = opts;
      this.forced = false;
      calls.workers.push(this);
    }
    on() { return this; }
    close(force = false) {
      if (force) {
        this.forced = true;
        return forceCloseHangs ? new Promise(() => {}) : Promise.resolve();
      }
      return workerClose ? workerClose() : Promise.resolve();
    }
    async disconnect() { this.disconnected = true; }
  }
  return { drivers: { Queue, Worker, Redis }, calls };
}

test('guardProducer: a hanging producer fails with QUEUE_TIMEOUT (503) within the bound', async () => {
  const t0 = Date.now();
  await assert.rejects(
    () => guardProducer(() => new Promise(() => {}), { timeoutMs: 50, queue: 'q' }),
    (err) => err instanceof QueueError
      && err.code === QUEUE_ERROR_CODES.TIMEOUT
      && err.statusCode === 503
      && err.isOperational === true
      && err.queue === 'q',
  );
  assert.ok(Date.now() - t0 < 1000);
});

test('guardProducer: a failing producer becomes QUEUE_UNAVAILABLE without leaking the cause message', async () => {
  await assert.rejects(
    () => guardProducer(async () => { throw new Error('connect ECONNREFUSED redis://:secret@10.0.0.5'); }, { timeoutMs: 1000 }),
    (err) => err.code === QUEUE_ERROR_CODES.UNAVAILABLE && err.statusCode === 503 && !/secret/.test(err.message),
  );
});

test('BullMQ handle: producer uses a fail-fast connection separate from the worker connection', async () => {
  const { drivers, calls } = fakeDrivers();
  const handle = createQueue('test.split', { transport: 'bullmq', redisUrl: 'redis://fake:6379', drivers, attempts: 4 });
  assert.equal(calls.connections.length, 1, 'only the producer connects until a consumer starts');
  const producer = calls.connections[0];
  assert.equal(producer.opts.enableOfflineQueue, false);
  assert.equal(producer.opts.maxRetriesPerRequest, 1);
  assert.equal(calls.queues[0].opts.connection, producer);

  handle.consume(async () => {});
  assert.equal(calls.connections.length, 2);
  const workerConn = calls.connections[1];
  assert.notEqual(workerConn, producer);
  assert.equal(workerConn.opts.maxRetriesPerRequest, null);
  assert.equal(calls.workers[0].opts.connection, workerConn);

  // The processor maps attempt metadata for the sync worker.
  let seen = null;
  const { drivers: d2, calls: c2 } = fakeDrivers();
  const h2 = createQueue('test.meta', { transport: 'bullmq', redisUrl: 'redis://fake', drivers: d2, attempts: 4 });
  h2.consume(async (job) => { seen = job; });
  await c2.workers[0].processor({ id: 'j1', name: 'sync', data: { a: 1 }, attemptsMade: 2, opts: { attempts: 4 } });
  assert.deepEqual(seen, { id: 'j1', name: 'sync', data: { a: 1 }, attemptsMade: 2, attempts: 4 });

  await handle.close();
  await h2.close();
});

test('BullMQ handle: enqueue during a Redis outage returns a typed timeout instead of hanging', async () => {
  const { drivers } = fakeDrivers({ add: () => new Promise(() => {}) });
  const handle = createQueue('test.hang', { transport: 'bullmq', redisUrl: 'redis://fake', drivers, producerTimeoutMs: 60 });
  const t0 = Date.now();
  await assert.rejects(() => handle.enqueue({ x: 1 }), (err) => err.code === 'QUEUE_TIMEOUT' && err.statusCode === 503);
  assert.ok(Date.now() - t0 < 1000, 'bounded by producerTimeoutMs');
  await assert.rejects(() => handle.schedule({ x: 1 }, 1000), (err) => err.code === 'QUEUE_TIMEOUT');
  await handle.close();
});

test('BullMQ handle: an immediate Redis error is QUEUE_UNAVAILABLE', async () => {
  const { drivers } = fakeDrivers({ add: async () => { throw new Error("Stream isn't writeable and enableOfflineQueue options is false"); } });
  const handle = createQueue('test.down', { transport: 'bullmq', redisUrl: 'redis://fake', drivers });
  await assert.rejects(() => handle.enqueue({ x: 1 }), (err) => err.code === 'QUEUE_UNAVAILABLE');
  await handle.close();
});

test('BullMQ handle: close waits for the worker within the drain budget, then forces it', async () => {
  const quick = fakeDrivers({ workerClose: () => sleep(20) });
  const h1 = createQueue('test.drain1', { transport: 'bullmq', redisUrl: 'redis://fake', drivers: quick.drivers });
  h1.consume(async () => {});
  const r1 = await h1.close({ drainTimeoutMs: 500 });
  assert.equal(r1.drained, true);
  assert.equal(quick.calls.workers[0].forced, false);
  assert.equal(quick.calls.queues[0].closed, true);
  assert.equal(quick.calls.quit, 2, 'worker and producer connections closed');

  const slow = fakeDrivers({ workerClose: () => new Promise(() => {}) });
  const h2 = createQueue('test.drain2', { transport: 'bullmq', redisUrl: 'redis://fake', drivers: slow.drivers });
  h2.consume(async () => {});
  const t0 = Date.now();
  const r2 = await h2.close({ drainTimeoutMs: 50 });
  assert.equal(r2.drained, false);
  assert.equal(slow.calls.workers[0].forced, true, 'worker force-closed after the budget');
  assert.ok(Date.now() - t0 < 1000);
});

test('BullMQ handle: ping round-trips on the producer connection and is bounded during an outage', async () => {
  const up = fakeDrivers();
  const live = createQueue('test.ping-up', { transport: 'bullmq', redisUrl: 'redis://fake', drivers: up.drivers });
  assert.equal(await live.ping(), 'PONG');
  await live.close();

  const down = fakeDrivers({ ping: () => new Promise(() => {}) });
  const dead = createQueue('test.ping-down', { transport: 'bullmq', redisUrl: 'redis://fake', drivers: down.drivers, producerTimeoutMs: 50 });
  const t0 = Date.now();
  await assert.rejects(() => dead.ping(), (err) => err.code === 'QUEUE_TIMEOUT');
  assert.ok(Date.now() - t0 < 1000);
  await dead.close();

  const memory = createQueue('test.ping-memory', { transport: 'memory' });
  assert.equal(await memory.ping(), 'PONG');
  await memory.close();
});

test('BullMQ handle: the first ping waits (bounded) for a connection that is still connecting', async () => {
  const { EventEmitter } = await import('node:events');
  const { drivers } = fakeDrivers();
  const connecting = [];
  /** ioredis-like: commands fail at once until 'ready' (enableOfflineQueue: false). */
  class ConnectingRedis extends EventEmitter {
    constructor(url, opts) {
      super();
      this.opts = opts;
      this.status = 'connecting';
      connecting.push(this);
    }
    ping() {
      return this.status === 'ready'
        ? Promise.resolve('PONG')
        : Promise.reject(new Error("Stream isn't writeable and enableOfflineQueue options is false"));
    }
    async quit() { this.status = 'end'; }
    disconnect() { this.status = 'end'; }
  }
  const handle = createQueue('test.ping-boot', {
    transport: 'bullmq', redisUrl: 'redis://fake', drivers: { ...drivers, Redis: ConnectingRedis }, producerTimeoutMs: 500,
  });
  const conn = connecting[0];
  setTimeout(() => { conn.status = 'ready'; conn.emit('ready'); }, 30);
  assert.equal(await handle.ping(), 'PONG', 'a Redis that finishes connecting is reported up');
  assert.equal(conn.listenerCount('ready'), 0);

  // Never becomes ready: typed timeout within the budget, no listener left.
  const stuck = createQueue('test.ping-stuck', {
    transport: 'bullmq', redisUrl: 'redis://fake', drivers: { ...drivers, Redis: ConnectingRedis }, producerTimeoutMs: 60,
  });
  const t0 = Date.now();
  await assert.rejects(() => stuck.ping(), (err) => err instanceof QueueError && err.statusCode === 503);
  assert.ok(Date.now() - t0 < 1000);
  await sleep(80);
  assert.equal(connecting[1].listenerCount('ready'), 0, 'no listener leaks across probes');
  await handle.close();
  await stuck.close();
});

test('BullMQ handle: close stays bounded when Redis is gone and every close call hangs', async () => {
  const { drivers, calls } = fakeDrivers({
    workerClose: () => new Promise(() => {}),
    forceCloseHangs: true,
    queueCloseHangs: true,
  });
  const handle = createQueue('test.all-hang', {
    transport: 'bullmq', redisUrl: 'redis://fake', drivers, closeStageMs: 40,
  });
  handle.consume(async () => {});
  const t0 = Date.now();
  const result = await handle.close({ drainTimeoutMs: 40 });
  assert.equal(result.drained, false);
  assert.ok(Date.now() - t0 < 1000, `closed in ${Date.now() - t0}ms`);
  assert.equal(calls.workers[0].forced, true);
  assert.equal(calls.workers[0].disconnected, true, 'worker connections dropped after the forced close timed out');
  assert.equal(calls.queues[0].disconnected, true, 'queue connection dropped after its close timed out');
});

test('real BullMQ + ioredis: an unreachable Redis fails the producer fast with a typed 503', async () => {
  // Loopback port 1 refuses connections: a Redis outage without any network
  // dependency. Exercises the real fail-fast producer connection settings.
  const handle = createQueue('test.real-dead', {
    transport: 'bullmq', redisUrl: 'redis://127.0.0.1:1', producerTimeoutMs: 300,
  });
  const typed = (err) => err instanceof QueueError
    && [QUEUE_ERROR_CODES.TIMEOUT, QUEUE_ERROR_CODES.UNAVAILABLE].includes(err.code)
    && err.statusCode === 503;
  const t0 = Date.now();
  await assert.rejects(() => handle.enqueue({ x: 1 }), typed);
  assert.ok(Date.now() - t0 < 2000, `enqueue failed in ${Date.now() - t0}ms`);
  await assert.rejects(() => handle.ping(), typed);
  const t1 = Date.now();
  const closed = await handle.close();
  assert.equal(closed.drained, true);
  assert.ok(Date.now() - t1 < 2000, 'closing a producer on a dead Redis does not hang');
});

test('BullMQ handle: stats report Redis-wide counts', async () => {
  const { drivers } = fakeDrivers();
  const handle = createQueue('test.stats', { transport: 'bullmq', redisUrl: 'redis://fake', drivers });
  const stats = await handle.stats();
  assert.equal(stats.waiting, 2);
  assert.equal(stats.active, 1);
  assert.equal(stats.consuming, false);
  await handle.close();
});

test('memory queue: close lets an in-flight job finish within the drain budget', async () => {
  const q = createInMemoryQueue({ concurrency: 1 });
  let finished = false;
  q.consume(async () => { await sleep(50); finished = true; });
  await q.enqueue({ a: 1 });
  await q.enqueue({ a: 2 }); // still buffered: dropped on close
  await sleep(10);
  assert.equal(q.stats().active, 1);
  const result = await q.close({ drainTimeoutMs: 1000 });
  assert.equal(finished, true);
  assert.deepEqual(result, { drained: true, dropped: 1 });
});

test('memory queue: once the drain starts, new jobs are refused with a typed 503 while in-flight ones finish', async () => {
  const handle = createQueue('test.drain-refuse', { transport: 'memory', concurrency: 1 });
  let finished = false;
  handle.consume(async () => { await sleep(80); finished = true; });
  await handle.enqueue({ a: 1 });
  await sleep(10);
  const closing = handle.close({ drainTimeoutMs: 1000 });
  await assert.rejects(
    () => handle.enqueue({ a: 2 }),
    (err) => err instanceof QueueError && err.code === QUEUE_ERROR_CODES.UNAVAILABLE && err.statusCode === 503,
  );
  await assert.rejects(() => handle.schedule({ a: 3 }, 10), (err) => err.code === QUEUE_ERROR_CODES.UNAVAILABLE);
  const result = await closing;
  assert.equal(finished, true, 'the in-flight job was allowed to finish');
  assert.deepEqual(result, { drained: true, dropped: 0 });
});

test('memory queue: a hanging job does not hold close past the budget', async () => {
  const q = createInMemoryQueue({ concurrency: 1 });
  q.consume(() => new Promise(() => {}));
  await q.enqueue({ a: 1 });
  await sleep(10);
  const t0 = Date.now();
  const result = await q.close({ drainTimeoutMs: 50 });
  assert.equal(result.drained, false);
  assert.ok(Date.now() - t0 < 1000);
  await assert.rejects(() => q.enqueue({ a: 2 }), /closed/);
});

test('queue service: enqueue on a closed queue is a typed QUEUE_UNAVAILABLE', async () => {
  const handle = queueService.getQueue('test.service');
  await handle.close();
  await assert.rejects(
    () => handle.enqueue({ x: 1 }),
    (err) => err instanceof QueueError && err.code === 'QUEUE_UNAVAILABLE',
  );
  await closeAll();
});

test('queue stats: one entry per queue name; memory handles add up', async () => {
  const { getQueueStats } = await import('../../src/queues/index.js');
  const a = createQueue('test.merge', { transport: 'memory' });
  const b = createQueue('test.merge', { transport: 'memory' });
  await a.enqueue({ n: 1 });
  await b.enqueue({ n: 2 });
  await b.enqueue({ n: 3 });
  const stats = (await getQueueStats()).filter((q) => q.name === 'test.merge');
  assert.equal(stats.length, 1);
  assert.equal(stats[0].waiting, 3);
  assert.equal(stats[0].status, 'ok');
  await a.close();
  await b.close();
});
