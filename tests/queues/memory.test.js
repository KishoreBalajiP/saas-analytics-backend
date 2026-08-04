/**
 * Tests for `queues/memory.queue.js` (in-memory transport).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryQueue } from '../../src/queues/memory.queue.js';
import { createQueue, QUEUE_NAMES } from '../../src/queues/index.js';

test('enqueue + consume delivers a message', async () => {
  const q = createInMemoryQueue();
  const received = [];
  q.consume(async ({ data }) => { received.push(data); });
  await q.enqueue({ a: 1 });
  await q.enqueue({ a: 2 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(received.length, 2);
  assert.deepEqual(received[0], { a: 1 });
  assert.deepEqual(received[1], { a: 2 });
  await q.close();
});

test('schedule respects the delay', async () => {
  const q = createInMemoryQueue();
  const received = [];
  q.consume(async ({ data }) => { received.push(data); });
  await q.schedule({ x: 1 }, 100);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(received.length, 0);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(received.length, 1);
  await q.close();
});

test('retries failed messages up to the attempts limit', async () => {
  const q = createInMemoryQueue({ attempts: 3, backoffMs: 5 });
  let attempts = 0;
  const events = [];
  q.consume(async () => {
    attempts += 1;
    throw new Error('boom');
  });
  q.on('retry', (e) => events.push(e));
  q.on('failed', (e) => events.push(e));
  await q.enqueue({ x: 1 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(attempts, 3);
  assert.equal(events.length, 3); // retry, retry, failed
  await q.close();
});

test('createQueue returns an in-memory handle in dev', () => {
  const handle = createQueue(QUEUE_NAMES.CONNECTOR_SYNC);
  assert.equal(handle.transport, 'memory');
  assert.equal(typeof handle.enqueue, 'function');
});

test('enqueue is rejected once closed', async () => {
  const q = createInMemoryQueue();
  await q.close();
  await assert.rejects(() => q.enqueue({ a: 1 }), /Queue is closed/);
});
