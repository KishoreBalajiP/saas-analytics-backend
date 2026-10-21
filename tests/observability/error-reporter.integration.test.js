/**
 * Error aggregation (roadmap 2.8; findings ops.07, ops2.05, ops.15).
 *
 *   - the reporter scrubs secrets and PII before an event leaves the process;
 *   - dedupe, per-minute cap and the HTTP sink (fake fetch, no network);
 *   - the error middleware reports 5xx (not 4xx/501) with the request id and
 *     route template, and returns `requestId` in every error envelope;
 *   - scheduled-job failures and queue jobs that ran out of attempts are
 *     reported; retries are not;
 *   - POST /api/v1/client-errors accepts bounded, validated frontend reports,
 *     scrubs them, and is rate-limited per IP.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLIENT_ERROR_RATE_LIMIT_MAX = '3';

const { startMongo, stopMongo } = await import('../helpers/mongo.js');
const { startHttp, stopHttp, api } = await import('../helpers/http.js');
const reporter = await import('../../src/services/errorReporter.service.js');
const { errorHandler } = await import('../../src/middleware/error.middleware.js');
const { runJob, resetSchedulerForTests } = await import('../../src/jobs/scheduler.js');
const { createQueue } = await import('../../src/queues/index.js');
const { runWithTrace } = await import('../../src/utils/traceContext.js');
const ApiError = (await import('../../src/utils/ApiError.js')).default;

const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJlcnJvci1yZXBvcnQifQ.c2lnbmF0dXJlLWVycm9yLXJlcG9ydA';
const INVITE_TOKEN = 'invitetok_report_0a1b2c3d4e5f60718293a4b5c6d';
const EMBED_TOKEN = 'embedtok_report_9f8e7d6c5b4a3928170615243';

let events = [];
const captureSink = { name: 'capture', async send(event) { events.push(event); return 'sent'; } };

before(async () => {
  await startMongo();
  await startHttp();
});
beforeEach(() => {
  reporter.resetErrorReporter();
  reporter.setErrorSink(captureSink);
  events = [];
});
after(async () => {
  reporter.resetErrorReporter();
  await stopHttp();
  await stopMongo();
});

const asText = (value) => JSON.stringify(value);

test('events are scrubbed of secrets and personal data', async () => {
  const err = new Error(`login failed for jane.doe@example.com from 203.0.113.9 with Bearer ${JWT}`);
  err.config = { headers: { Authorization: `Bearer ${JWT}` }, password: 'Secret123!', email: 'jane.doe@example.com' };
  err.stack = `Error: boom\n    at fetch (https://app.example.com/accept?token=${INVITE_TOKEN})\n    at x (/api/v1/embed/${EMBED_TOKEN})`;
  await reporter.reportError(err, { source: 'api', extra: { cookie: 'saas_session=abcdef0123456789', userEmail: 'a@b.co', phone: '+1 555 0100' } });
  assert.equal(events.length, 1);
  const text = asText(events[0]);
  for (const leaked of [JWT, 'Secret123!', 'jane.doe@example.com', '203.0.113.9', INVITE_TOKEN, EMBED_TOKEN, 'abcdef0123456789', 'a@b.co', '+1 555 0100']) {
    assert.ok(!text.includes(leaked), `leaked ${leaked}: ${text}`);
  }
  assert.equal(events[0].source, 'api');
  assert.match(events[0].fingerprint, /^[0-9a-f]{32}$/);
  assert.equal(events[0].service.env, 'development');
});

test('repeats are deduplicated and counted; the per-minute cap drops the excess', async () => {
  reporter.resetErrorReporter({ maxEventsPerMinute: 3, dedupeWindowMs: 60000 });
  reporter.setErrorSink(captureSink);
  const make = () => new Error('same failure');
  // Same call site -> same fingerprint.
  const results = [];
  for (let i = 0; i < 3; i += 1) results.push(await reporter.reportError(make(), { source: 'job' }));
  assert.deepEqual(results, ['sent', 'deduped', 'deduped']);
  // Distinct errors hit the per-minute cap.
  const distinct = [];
  for (const code of ['A_ONE', 'B_TWO', 'C_THREE']) {
    distinct.push(await reporter.reportError(Object.assign(new Error(code), { code }), { source: 'job', route: code }));
  }
  assert.deepEqual(distinct, ['sent', 'sent', 'dropped']);
  // After the dedupe window the repeat is delivered with its count.
  reporter.resetErrorReporter({ maxEventsPerMinute: 10, dedupeWindowMs: 0 });
  reporter.setErrorSink(captureSink);
  events = [];
  await reporter.reportError(make(), { source: 'job' });
  assert.equal(events[0].occurrences, 1);
});

test('the http sink posts JSON with the bearer token and never throws on failure', async () => {
  const calls = [];
  const okFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 202, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  reporter.setErrorSink(reporter.createHttpSink({ url: 'https://errors.example.test/intake', token: 'sink-token', timeoutMs: 500, fetchImpl: okFetch }));
  assert.equal(await reporter.reportError(new Error('to http'), { source: 'api' }), 'sent');
  assert.equal(calls[0].url, 'https://errors.example.test/intake');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sink-token');
  assert.equal(JSON.parse(calls[0].init.body).error.message, 'to http');
  assert.ok(calls[0].init.signal, 'bounded by a timeout signal');

  reporter.resetErrorReporter();
  reporter.setErrorSink(reporter.createHttpSink({
    url: 'https://errors.example.test/intake',
    fetchImpl: async () => ({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) }),
  }));
  assert.equal(await reporter.reportError(new Error('sink down'), { source: 'api' }), 'failed');
  reporter.resetErrorReporter();
  reporter.setErrorSink(reporter.createHttpSink({ url: 'https://errors.example.test/intake', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }));
  assert.equal(await reporter.reportError(new Error('network down'), { source: 'api' }), 'failed');
  assert.equal(await reporter.flushErrorReports({ timeoutMs: 100 }), true);
});

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader(k, v) { this.headers[k] = v; },
  };
}

test('the error middleware reports 5xx with request context and returns requestId', async () => {
  const req = {
    id: 'req-error-000001',
    method: 'GET',
    originalUrl: `/api/v1/embed/${EMBED_TOKEN}?token=${INVITE_TOKEN}`,
    baseUrl: '/api/v1/embed',
    route: { path: '/:token' },
    log: { error() {}, warn() {} },
  };
  const res = fakeRes();
  await runWithTrace({ requestId: req.id }, async () => {
    errorHandler(new TypeError('cannot read properties of undefined'), req, res, () => {});
  });
  await reporter.flushErrorReports({ timeoutMs: 200 });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.requestId, 'req-error-000001');
  assert.equal(res.body.code, 'INTERNAL_ERROR');
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.error.type, 'TypeError');
  assert.equal(event.request.requestId, 'req-error-000001');
  assert.equal(event.request.route, '/api/v1/embed/:token');
  assert.ok(!asText(event).includes(EMBED_TOKEN) && !asText(event).includes(INVITE_TOKEN));

  // 4xx and deliberate 501s are not reported, but still carry requestId.
  for (const err of [ApiError.notFound('nope'), ApiError.validation('bad', []), ApiError.notImplemented()]) {
    const r = fakeRes();
    errorHandler(err, { ...req, id: 'req-error-000002' }, r, () => {});
    assert.equal(r.body.requestId, 'req-error-000002');
  }
  await reporter.flushErrorReports({ timeoutMs: 200 });
  assert.equal(events.length, 1, '4xx/501 are not reported');
});

test('every API error envelope carries the request id that is in the header', async () => {
  const res = await api('/api/v1/definitely-not-a-route', { headers: { 'X-Request-Id': 'support-ticket-4040' } });
  assert.equal(res.status, 404);
  assert.equal(res.json.requestId, 'support-ticket-4040');
  assert.equal(res.headers.get('x-request-id'), 'support-ticket-4040');
});

test('failed scheduled jobs and exhausted queue jobs are reported; retries are not', async () => {
  resetSchedulerForTests();
  const lock = { acquire: async () => 'tok', renew: async () => true, release: async () => true };
  await runJob({ name: 'reporter-test-job', handler: async () => { throw new Error('nightly job failed'); } }, { lock, instanceId: 'test' });
  await reporter.flushErrorReports({ timeoutMs: 200 });
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'job');
  assert.equal(events[0].context.job, 'reporter-test-job');
  assert.equal(events[0].trace.job, 'reporter-test-job');

  events = [];
  const queue = createQueue('reporter.test', { transport: 'memory', attempts: 2, backoffMs: 1 });
  const failed = new Promise((resolve) => queue.on('failed', resolve));
  let calls = 0;
  queue.consume(async () => { calls += 1; throw new Error('queue job keeps failing'); });
  await queue.enqueue({ x: 1 });
  await failed;
  await reporter.flushErrorReports({ timeoutMs: 200 });
  await queue.close();
  assert.equal(calls, 2);
  assert.equal(events.length, 1, 'only the final failure is reported');
  assert.equal(events[0].source, 'queue');
  assert.equal(events[0].context.queue, 'reporter.test');
  assert.equal(events[0].context.attemptsMade, 2);
});

test('POST /client-errors accepts a scrubbed frontend report', async () => {
  const res = await api('/api/v1/client-errors', {
    method: 'POST',
    headers: { 'X-Forwarded-For': '198.51.100.1' },
    body: {
      kind: 'boundary',
      name: 'TypeError',
      message: `Cannot read x (user jane@example.com, Bearer ${JWT})`,
      stack: `TypeError: Cannot read x\n    at Dashboard (https://app.example.com/assets/index.js:1:2)`,
      url: `https://app.example.com/invite/accept?token=${INVITE_TOKEN}`,
      route: '/dashboards/$id',
      requestId: 'req-client-000001',
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      release: '1.2.3',
      portal: 'tenant',
      unexpected: 'dropped by the validator',
    },
  });
  assert.equal(res.status, 202, JSON.stringify(res.json));
  assert.equal(res.json.data.accepted, true);
  await reporter.flushErrorReports({ timeoutMs: 200 });
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.source, 'frontend');
  assert.equal(event.error.type, 'TypeError');
  assert.match(event.error.stack, /at Dashboard/);
  assert.doesNotMatch(event.error.stack, /observability\.controller/, 'server stack never mixed in');
  assert.equal(event.context.apiRequestId, 'req-client-000001');
  assert.equal(event.context.kind, 'boundary');
  assert.equal(event.context.unexpected, undefined);
  const text = asText(event);
  for (const leaked of [JWT, INVITE_TOKEN, 'jane@example.com']) assert.ok(!text.includes(leaked), `leaked ${leaked}`);
});

test('POST /client-errors validates and bounds its input', async () => {
  const headers = { 'X-Forwarded-For': '198.51.100.2' };
  const missing = await api('/api/v1/client-errors', { method: 'POST', headers, body: { message: 'x' } });
  assert.equal(missing.status, 422);
  assert.ok(missing.json.errors.some((e) => e.field === 'kind'));
  const huge = await api('/api/v1/client-errors', { method: 'POST', headers, body: { kind: 'error', message: 'x'.repeat(5000) } });
  assert.equal(huge.status, 422);
  const forgedId = await api('/api/v1/client-errors', { method: 'POST', headers, body: { kind: 'error', message: 'x', requestId: 'bad id"' } });
  assert.equal(forgedId.status, 422);
  await reporter.flushErrorReports({ timeoutMs: 200 });
  assert.equal(events.length, 0);
});

test('POST /client-errors is rate-limited per client IP', async () => {
  const send = (ip) => api('/api/v1/client-errors', {
    method: 'POST', headers: { 'X-Forwarded-For': ip }, body: { kind: 'error', message: 'flood' },
  });
  const statuses = [];
  for (let i = 0; i < 4; i += 1) statuses.push((await send('198.51.100.50')).status);
  assert.deepEqual(statuses, [202, 202, 202, 429]);
  assert.equal((await send('198.51.100.51')).status, 202, 'another client is unaffected');
});
