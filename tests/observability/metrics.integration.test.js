/**
 * Prometheus metrics (roadmap 2.8; findings ops.07, ops2.05).
 *
 * This file sets METRICS_TOKEN before the app is imported, then checks:
 *   - GET /api/v1/metrics is protected (401 without / with a wrong token,
 *     constant-time bearer check) and serves the Prometheus text format;
 *   - every series named in the package exit criteria is exposed: HTTP
 *     request counts and latency histograms by route TEMPLATE and status,
 *     queue depth, job run outcomes, analytics query latency and timeouts,
 *     quota rejections, auth failures and the outbox backlog;
 *   - route labels never carry ids or tokens;
 *   - the endpoint is 404 when no token is configured (factory test).
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const METRICS_TOKEN = 'test-metrics-token-0123456789abcdef';
process.env.METRICS_TOKEN = METRICS_TOKEN;

const { startMongo, stopMongo } = await import('../helpers/mongo.js');
const { startHttp, stopHttp, api } = await import('../helpers/http.js');
const metrics = await import('../../src/utils/metrics.js');
const { createMetricsAuth } = await import('../../src/middleware/metricsAuth.middleware.js');
const { errorHandler } = await import('../../src/middleware/error.middleware.js');
const { runJob, resetSchedulerForTests } = await import('../../src/jobs/scheduler.js');
const { createQueue } = await import('../../src/queues/index.js');
const { TenantConcurrencyLimiter } = await import('../../src/services/analytics.limiter.js');
const ApiError = (await import('../../src/utils/ApiError.js')).default;

const EMBED_TOKEN = 'embedtok_metrics_0f1e2d3c4b5a69788796a5b4';

before(async () => {
  await startMongo();
  await startHttp();
});
after(async () => {
  await stopHttp();
  await stopMongo();
});

async function scrape(token = METRICS_TOKEN) {
  const res = await api('/api/v1/metrics', token ? { headers: { authorization: `Bearer ${token}` } } : {});
  return res;
}

/** The raw text body (api() parses JSON; re-fetch the text when needed). */
async function scrapeText() {
  const base = await startHttp();
  const res = await fetch(`${base}/api/v1/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
  return { status: res.status, type: res.headers.get('content-type'), text: await res.text() };
}

/** Value of one sample line, or undefined. */
function sample(text, name, labels = {}) {
  const want = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
    if (want.every((pair) => line.includes(pair))) return Number(line.slice(line.lastIndexOf(' ') + 1));
  }
  return undefined;
}

test('the endpoint refuses missing and wrong tokens', async () => {
  const none = await scrape(null);
  assert.equal(none.status, 401);
  assert.equal(none.headers.get('www-authenticate'), 'Bearer realm="metrics"');
  const wrong = await scrape('not-the-metrics-token-at-all');
  assert.equal(wrong.status, 401);
  // A user/admin JWT is not a metrics token either.
  const jwtLike = await scrape('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln');
  assert.equal(jwtLike.status, 401);
});

test('without a configured token the endpoint does not exist (404)', async () => {
  const app = express();
  app.get('/metrics', createMetricsAuth({ token: '' }), (_req, res) => res.send('should not be served'));
  app.use(errorHandler);
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
    assert.equal(res.status, 404);
    assert.ok(!(await res.text()).includes('should not be served'));
  } finally {
    server.close();
  }
});

test('exposes the listed series in Prometheus text format', async () => {
  // Traffic: a 401 (auth failure), a templated route with a token path.
  await api('/api/v1/auth/me', { headers: { authorization: 'Bearer nope-nope-nope-nope' } });
  await api(`/api/v1/embed/${EMBED_TOKEN}`);
  await api('/api/v1/health');

  // A quota refusal and an analytics timeout go through the real hooks.
  const quotaErr = new ApiError(409, 'Plan limit reached', {
    code: 'QUOTA_EXCEEDED',
    errors: [{ field: 'dashboards', metric: 'dashboards', limit: 3, current: 3 }],
  });
  metrics.observeApiError(quotaErr);
  await assert.rejects(metrics.timeAnalyticsQuery(async () => {
    throw Object.assign(new Error('operation exceeded time limit'), { code: 50, codeName: 'MaxTimeMSExpired' });
  }));
  await metrics.timeAnalyticsQuery(async () => [{ rows: [] }]);
  // A limiter refusal.
  const limiter = new TenantConcurrencyLimiter({ maxConcurrent: 1, maxQueued: 0, queueTimeoutMs: 0 });
  const hold = limiter.run('t1', () => new Promise((resolve) => setTimeout(resolve, 20)));
  await assert.rejects(limiter.run('t1', async () => null), (err) => err.code === 'QUERY_CONCURRENCY_LIMIT');
  await hold;

  // A scheduled job run (fake lock; JobRun recording is best-effort).
  resetSchedulerForTests();
  const lock = { acquire: async () => 'tok', renew: async () => true, release: async () => true };
  await runJob({ name: 'metrics-test-job', handler: async () => ({ processed: 2 }) }, { lock, instanceId: 'test' });
  await runJob({ name: 'metrics-test-job', handler: async () => { throw new Error('boom'); } }, { lock, instanceId: 'test' });

  // A queue job through the instrumented consumer.
  const queue = createQueue('metrics.test', { transport: 'memory', attempts: 1 });
  const done = new Promise((resolve) => queue.on('completed', resolve));
  queue.consume(async () => 'ok');
  await queue.enqueue({ hello: 'world' });
  await done;
  await queue.close();

  const { status, type, text } = await scrapeText();
  assert.equal(status, 200);
  assert.match(type, /^text\/plain; version=0\.0\.4/);

  for (const name of [
    'analivo_http_requests_total',
    'analivo_http_request_duration_seconds',
    'analivo_queue_jobs',
    'analivo_queue_jobs_processed_total',
    'analivo_job_runs_total',
    'analivo_analytics_queries_total',
    'analivo_analytics_query_duration_seconds',
    'analivo_quota_rejections_total',
    'analivo_auth_failures_total',
    'analivo_outbox_backlog',
    'analivo_api_errors_total',
    'analivo_dependency_up',
    'analivo_process_uptime_seconds',
  ]) {
    assert.match(text, new RegExp(`^# TYPE ${name} `, 'm'), `missing ${name}`);
  }

  // HTTP: by route template + status, latency histogram buckets.
  assert.ok(sample(text, 'analivo_http_requests_total', { method: 'GET', route: '/api/v1/health/', status: '200' }) >= 1
    || sample(text, 'analivo_http_requests_total', { method: 'GET', route: '/api/v1/health', status: '200' }) >= 1, 'health route counted');
  assert.ok(sample(text, 'analivo_http_requests_total', { method: 'GET', route: '/api/v1/auth/me', status: '401' }) >= 1);
  assert.ok(sample(text, 'analivo_http_request_duration_seconds_bucket', { route: '/api/v1/auth/me', status_class: '4xx', le: '+Inf' }) >= 1);
  // The embed token never becomes a label: the template does.
  assert.ok(!text.includes(EMBED_TOKEN), 'token leaked into a label');
  assert.ok(sample(text, 'analivo_http_requests_total', { route: '/api/v1/embed/:token' }) >= 1, 'embed counted by template');

  assert.ok(sample(text, 'analivo_auth_failures_total', { reason: 'UNAUTHORIZED' }) >= 1);
  assert.equal(sample(text, 'analivo_quota_rejections_total', { metric: 'dashboards' }), 1);
  assert.equal(sample(text, 'analivo_analytics_queries_total', { outcome: 'timeout' }), 1);
  assert.equal(sample(text, 'analivo_analytics_queries_total', { outcome: 'ok' }), 1);
  assert.equal(sample(text, 'analivo_analytics_queries_total', { outcome: 'rejected' }), 1);
  assert.equal(sample(text, 'analivo_job_runs_total', { job: 'metrics-test-job', status: 'succeeded' }), 1);
  assert.equal(sample(text, 'analivo_job_runs_total', { job: 'metrics-test-job', status: 'failed' }), 1);
  assert.equal(sample(text, 'analivo_queue_jobs_processed_total', { queue: 'metrics.test', outcome: 'completed' }), 1);
  // Queue depth for the platform queues (memory transport in tests).
  assert.notEqual(sample(text, 'analivo_queue_jobs', { queue: 'analytics.jobs', state: 'waiting' }), undefined);
  assert.equal(sample(text, 'analivo_outbox_backlog', { source: 'email_queue' }), 0);
  assert.equal(sample(text, 'analivo_queue_up', { queue: 'email.delivery' }), 1);
  // Dependency gauges come from the readiness checks (1 ok, 0 down). The
  // test helper connects mongoose directly (not via connectDatabase), so
  // only the presence of the database series is asserted here.
  assert.equal(sample(text, 'analivo_dependency_up', { dependency: 'queue' }), 1);
  assert.notEqual(sample(text, 'analivo_dependency_up', { dependency: 'database' }), undefined);
  assert.equal(sample(text, 'analivo_dependency_up', { dependency: 'smtp' }), undefined, 'disabled dependencies are omitted');
});

test('registry: cardinality cap, label escaping and histogram math', () => {
  const c = metrics.counter('analivo_test_cap_total', 'cap test', ['k']);
  for (let i = 0; i < metrics.MAX_SERIES_PER_METRIC + 5; i += 1) c.inc({ k: String(i) });
  assert.equal(c.series.size, metrics.MAX_SERIES_PER_METRIC);
  assert.equal(metrics.getMetric('analivo_metrics_dropped_series_total').get({ metric: 'analivo_test_cap_total' }), 5);

  const g = metrics.gauge('analivo_test_escape', 'escape test', ['v']);
  g.set({ v: 'a"b\\c\nd' }, 1);
  assert.deepEqual(g.render(), ['analivo_test_escape{v="a\\"b\\\\c\\nd"} 1']);

  const h = metrics.histogram('analivo_test_seconds', 'hist', [], [0.1, 1]);
  h.observe({}, 0.05);
  h.observe({}, 0.5);
  h.observe({}, 5);
  assert.deepEqual(h.render(), [
    'analivo_test_seconds_bucket{le="0.1"} 1',
    'analivo_test_seconds_bucket{le="1"} 2',
    'analivo_test_seconds_bucket{le="+Inf"} 3',
    'analivo_test_seconds_sum 5.55',
    'analivo_test_seconds_count 3',
  ]);
  assert.throws(() => metrics.counter('analivo_test_seconds', 'clash'), /already registered/);
  assert.throws(() => metrics.counter('bad name', 'x'), /Invalid metric name/);
});

test('route labels normalise ids in mount paths and never use raw URLs', () => {
  assert.equal(metrics.routeLabel({}), '<unmatched>');
  assert.equal(
    metrics.routeLabel({ route: { path: '/usage' }, baseUrl: '/api/v1/tenants/6650f1e2a3b4c5d6e7f80912' }),
    '/api/v1/tenants/:id/usage',
  );
  assert.equal(metrics.routeLabel({ route: { path: '/:id' }, baseUrl: '/api/v1/connectors' }), '/api/v1/connectors/:id');
});
