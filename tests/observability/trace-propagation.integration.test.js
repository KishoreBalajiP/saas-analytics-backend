/**
 * Request id + W3C trace context propagate through HTTP, queue jobs and
 * scheduled jobs into the logs (roadmap 2.8; findings ops.15, ops2.14).
 *
 * Asserted on captured log lines (`addLogTap`):
 *   - an inbound X-Request-Id is validated (forged/oversized ids replaced)
 *     and echoed; an inbound `traceparent` is continued;
 *   - lines written through the GLOBAL logger inside a request carry the
 *     requestId and traceId (no `req.log` needed);
 *   - a job enqueued by a real HTTP request (access-log export) logs, in the
 *     export worker, with the originating requestId, traceId, queue and jobId;
 *   - the BullMQ transport carries the same context (`data._trace`) through
 *     Redis (fake drivers, no network);
 *   - scheduled job ticks log with the job name and their own trace, and a
 *     manual run inside a request continues the request's trace;
 *   - untrusted carriers are validated.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import logger from '../../src/utils/logger.js';
import { addLogTap } from '../../src/config/logger.js';
import { createQueue } from '../../src/queues/index.js';
import { withTraceCarrier, instrumentConsumer, TRACE_FIELD } from '../../src/queues/instrument.js';
import { runJob, resetSchedulerForTests } from '../../src/jobs/scheduler.js';
import {
  runWithTrace,
  getTraceContext,
  childTraceContext,
  parseTraceparent,
  normalizeRequestId,
} from '../../src/utils/traceContext.js';
import { shortToken } from '../../src/utils/id.js';
import adminService from '../../src/services/admin.service.js';
import roleService from '../../src/services/role.service.js';
import permissionService from '../../src/services/permission.service.js';
import rbacCache from '../../src/services/rbac.cache.service.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT_SPAN = '00f067aa0ba902b7';
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_SPAN}-01`;

let lines = [];
let untap = null;
const parsed = () => lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
const waitFor = async (predicate, timeoutMs = 5000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = parsed().find(predicate);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
};

before(async () => {
  await startMongo();
  await startHttp();
  untap = addLogTap((line) => lines.push(line));
});
beforeEach(async () => {
  await resetMongo();
  await rbacCache.clearAll();
  lines = [];
});
after(async () => {
  untap?.();
  await stopHttp();
  await stopMongo();
});

async function ensureModule(key) {
  if (key.includes('.')) await ensureModule(key.slice(0, key.lastIndexOf('.')));
  try {
    await permissionService.createModule({ key, name: key });
  } catch (err) {
    if (err.statusCode !== 409) throw err;
  }
}

async function adminWith(permissionKey) {
  const moduleKey = permissionKey.slice(0, permissionKey.lastIndexOf('.'));
  const action = permissionKey.slice(permissionKey.lastIndexOf('.') + 1);
  const admin = await adminService.create({
    email: `trace-${shortToken(8)}@platform.test`, password: 'Password123!', adminType: 'platform', name: 'Trace Tester',
  });
  const role = await roleService.create({ tenantId: null, name: `role_${shortToken(8)}` });
  await ensureModule(moduleKey);
  try {
    await permissionService.createPermission({ module: moduleKey, action });
  } catch (err) {
    if (err.statusCode !== 409) throw err;
  }
  await roleService.addPermission({ roleId: role._id, permissionKey, by: null /* fixture seeding */ });
  await adminService.assignRole({ adminId: admin._id, roleId: role._id, tenantId: null, by: null /* fixture seeding */ });
  const login = await api('/api/v1/admin-auth/login', { method: 'POST', body: { email: admin.email, password: 'Password123!' } });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return login.json.data.accessToken;
}

test('inbound X-Request-Id is validated and echoed; traceparent is continued', async () => {
  const good = await api('/api/v1/health', { headers: { 'X-Request-Id': 'support-ticket-0001', traceparent: TRACEPARENT } });
  assert.equal(good.headers.get('x-request-id'), 'support-ticket-0001');
  assert.match(good.headers.get('traceresponse'), new RegExp(`^00-${TRACE_ID}-[0-9a-f]{16}-01$`));

  for (const forged of ['short', 'has spaces in it ok', 'x'.repeat(300), 'quote"injection-attempt', '{"level":60}']) {
    const res = await api('/api/v1/health', { headers: { 'X-Request-Id': forged } });
    const echoed = res.headers.get('x-request-id');
    assert.notEqual(echoed, forged, `forged id accepted: ${forged}`);
    assert.match(echoed, /^[0-9a-f-]{36}$/);
  }
  // A malformed traceparent starts a fresh trace instead of failing.
  const bad = await api('/api/v1/health', { headers: { traceparent: '00-zzzz-yyyy-01' } });
  assert.equal(bad.status, 200);
  assert.doesNotMatch(bad.headers.get('traceresponse'), new RegExp(TRACE_ID));

  // The access line of the traced request carries the trace.
  const access = await waitFor((l) => l.http === 'access' && l.requestId === 'support-ticket-0001');
  assert.ok(access, 'access line with requestId');
  assert.equal(access.traceId, TRACE_ID);
});

test('a job enqueued by an HTTP request logs with the request id and trace', async () => {
  const token = await adminWith('access_logs.export');
  lines = [];
  const res = await api('/api/v1/access-logs/export', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'X-Request-Id': 'support-ticket-0002', traceparent: TRACEPARENT },
    body: { format: 'json' },
  });
  assert.equal(res.status, 202, JSON.stringify(res.json));
  const exportId = res.json.data.exportId;

  const jobLine = await waitFor((l) => l.msg === 'export job completed' && l.exportId === exportId);
  assert.ok(jobLine, `export job log line\n${lines.join('')}`);
  assert.equal(jobLine.requestId, 'support-ticket-0002', 'job line carries the originating request id');
  assert.equal(jobLine.traceId, TRACE_ID, 'job line continues the inbound trace');
  assert.equal(jobLine.queue, 'export.jobs');
  assert.equal(jobLine.jobId, exportId);
  assert.match(jobLine.spanId, /^[0-9a-f]{16}$/);
});

test('the in-memory transport carries the trace into the consumer', async () => {
  const queue = createQueue('trace.memory', { transport: 'memory', attempts: 1 });
  const seen = new Promise((resolve) => {
    queue.consume(async (job) => {
      logger.info({ marker: 'memory-consumer' }, 'consumer ran');
      resolve({ ctx: getTraceContext(), data: job.data });
    });
  });
  await runWithTrace({ requestId: 'req-memory-0001', traceId: TRACE_ID, spanId: PARENT_SPAN }, () => queue.enqueue({ a: 1 }));
  const { ctx, data } = await seen;
  await queue.close();
  assert.equal(ctx.requestId, 'req-memory-0001');
  assert.equal(ctx.traceId, TRACE_ID);
  assert.equal(ctx.parentSpanId, PARENT_SPAN);
  assert.notEqual(ctx.spanId, PARENT_SPAN, 'the job gets its own span');
  assert.equal(data.a, 1);
  assert.deepEqual(data[TRACE_FIELD], { traceId: TRACE_ID, spanId: PARENT_SPAN, flags: '01', requestId: 'req-memory-0001' });
  const line = await waitFor((l) => l.marker === 'memory-consumer');
  assert.equal(line.requestId, 'req-memory-0001');
  assert.equal(line.traceId, TRACE_ID);
  assert.equal(line.queue, 'trace.memory');
});

test('the BullMQ transport carries the trace through job data (fake drivers)', async () => {
  const added = [];
  let processor = null;
  class FakeRedis {
    constructor() { this.status = 'ready'; }
    on() { return this; }
    once() { return this; }
    removeListener() { return this; }
    async ping() { return 'PONG'; }
    async quit() { this.status = 'end'; }
    disconnect() { this.status = 'end'; }
  }
  class FakeQueue {
    on() {}
    off() {}
    async add(name, data, opts) { added.push({ name, data, opts }); return { id: opts?.jobId ?? 'j1' }; }
    async close() {}
  }
  class FakeWorker {
    constructor(_name, fn) { processor = fn; this.closing = false; }
    on() {}
    async close() {}
  }
  const queue = createQueue('trace.bull', {
    transport: 'bullmq', redisUrl: 'redis://fake:6379', drivers: { Queue: FakeQueue, Worker: FakeWorker, Redis: FakeRedis },
  });
  let consumerCtx = null;
  queue.consume(async () => {
    consumerCtx = getTraceContext();
    logger.info({ marker: 'bull-consumer' }, 'bull consumer ran');
  });
  await runWithTrace({ requestId: 'req-bull-00001', traceId: TRACE_ID, spanId: PARENT_SPAN }, () => queue.enqueue({ b: 2 }, { jobId: 'job-77' }));
  assert.equal(added.length, 1);
  assert.equal(added[0].data[TRACE_FIELD].requestId, 'req-bull-00001');
  // The worker (another process in production) receives the serialised data.
  const wire = JSON.parse(JSON.stringify(added[0].data));
  await processor({ data: wire, id: 'job-77', name: 'job', attemptsMade: 0, opts: { attempts: 1 } });
  await queue.close();
  assert.equal(consumerCtx.requestId, 'req-bull-00001');
  assert.equal(consumerCtx.traceId, TRACE_ID);
  const line = await waitFor((l) => l.marker === 'bull-consumer');
  assert.equal(line.jobId, 'job-77');
  assert.equal(line.queue, 'trace.bull');
});

test('scheduled ticks log with the job name; a manual run continues the caller trace', async () => {
  resetSchedulerForTests();
  const lock = { acquire: async () => 'tok', renew: async () => true, release: async () => true };
  let tickCtx = null;
  await runJob({
    name: 'trace-test-job',
    handler: async () => {
      tickCtx = getTraceContext();
      logger.info({ marker: 'tick' }, 'tick work');
    },
  }, { lock, instanceId: 'test' });
  assert.equal(tickCtx.job, 'trace-test-job');
  assert.match(tickCtx.traceId, /^[0-9a-f]{32}$/);
  const tick = await waitFor((l) => l.marker === 'tick');
  assert.equal(tick.job, 'trace-test-job');
  assert.equal(tick.traceId, tickCtx.traceId);
  assert.equal(tick.requestId, undefined, 'a scheduled tick has no request');

  let manualCtx = null;
  await runWithTrace({ requestId: 'req-manual-0001', traceId: TRACE_ID, spanId: PARENT_SPAN }, () => runJob({
    name: 'trace-test-job',
    handler: async () => { manualCtx = getTraceContext(); },
  }, { lock, instanceId: 'test', trigger: 'manual' }));
  assert.equal(manualCtx.traceId, TRACE_ID);
  assert.equal(manualCtx.requestId, 'req-manual-0001');
  assert.equal(manualCtx.job, 'trace-test-job');
});

test('untrusted carriers and headers are validated', () => {
  const ctx = childTraceContext({ traceId: 'not-hex', spanId: 'x', requestId: 'bad id with spaces', flags: 'zz' }, { queue: 'q' });
  assert.match(ctx.traceId, /^[0-9a-f]{32}$/);
  assert.equal(ctx.parentSpanId, null);
  assert.equal(ctx.requestId, undefined);
  assert.equal(ctx.flags, '01');
  assert.equal(parseTraceparent(`ff-${TRACE_ID}-${PARENT_SPAN}-01`), null);
  assert.equal(parseTraceparent(`00-${'0'.repeat(32)}-${PARENT_SPAN}-01`), null);
  assert.deepEqual(parseTraceparent(TRACEPARENT), { traceId: TRACE_ID, parentSpanId: PARENT_SPAN, flags: '01' });
  assert.equal(normalizeRequestId('  ok-request-id-1  '), 'ok-request-id-1');
  assert.equal(normalizeRequestId('<script>'), null);
  // Outside any context nothing is attached; non-object payloads pass through.
  assert.deepEqual(withTraceCarrier({ x: 1 }), { x: 1 });
  assert.equal(withTraceCarrier('raw'), 'raw');
  assert.equal(instrumentConsumer('q', null), null);
});
