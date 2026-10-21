/**
 * Dependency-aware readiness, public status and degraded monitoring
 * (roadmap 2.8; findings ops.07, ops2.05, ops.08, ops2.12).
 *
 *   - readiness: critical dependencies (database, redis, queue) down ->
 *     not_ready; non-critical (storage, scheduler, smtp) down/degraded ->
 *     degraded; a hanging check is bounded; non-critical checks are cached;
 *     transitions are logged once (e.g. SMTP going down);
 *   - the public status summary exposes component states only;
 *   - the admin aggregate degrades instead of returning 500 when the cache
 *     (Redis) is unreachable, and the Redis probe reports `down` - both
 *     against a REAL Redis driver pointed at a closed port (no network
 *     beyond loopback);
 *   - storage / SMTP probes with fakes.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startMongo, stopMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import { createReadiness, toPublicStatus, getPublicStatus, resetPublicStatusCache } from '../../src/services/readiness.service.js';
import * as monitoringService from '../../src/services/monitoring.service.js';
import { CacheError } from '../../src/services/cache.service.js';
import { createRedisCache } from '../../src/cache/redis.js';

before(async () => {
  await startMongo();
  await startHttp();
});
after(async () => {
  await stopHttp();
  await stopMongo();
});

const ok = async () => ({ status: 'ok' });
const down = async () => ({ status: 'down' });
const allOk = () => ({ database: ok, redis: ok, queue: ok, storage: ok, scheduler: ok, smtp: ok });

function fakeLog() {
  const entries = [];
  return {
    entries,
    warn: (obj, msg) => entries.push({ level: 'warn', obj, msg }),
    info: (obj, msg) => entries.push({ level: 'info', obj, msg }),
  };
}

test('all dependencies ok -> ready', async () => {
  const r = createReadiness({ checks: allOk(), log: fakeLog() });
  const result = await r.check();
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.checks, { database: 'ok', redis: 'ok', queue: 'ok', storage: 'ok', scheduler: 'ok', smtp: 'ok' });
});

test('a critical dependency down -> not_ready', async () => {
  for (const name of ['database', 'redis', 'queue']) {
    const r = createReadiness({ checks: { ...allOk(), [name]: down }, log: fakeLog() });
    const result = await r.check();
    assert.equal(result.status, 'not_ready', name);
    assert.equal(result.checks[name], 'down');
  }
});

test('a non-critical dependency down or degraded -> degraded (still serving)', async () => {
  for (const name of ['storage', 'scheduler', 'smtp']) {
    const r = createReadiness({ checks: { ...allOk(), [name]: down }, log: fakeLog() });
    assert.equal((await r.check()).status, 'degraded', name);
  }
  const r = createReadiness({ checks: { ...allOk(), scheduler: async () => ({ status: 'degraded' }) }, log: fakeLog() });
  assert.equal((await r.check()).status, 'degraded');
  // Disabled / unknown dependencies never degrade readiness.
  const r2 = createReadiness({ checks: { ...allOk(), redis: async () => ({ status: 'disabled' }), smtp: async () => ({ status: 'disabled' }), scheduler: async () => ({ status: 'unknown' }) }, log: fakeLog() });
  assert.equal((await r2.check()).status, 'ready');
});

test('a hanging or throwing check is bounded and counts as down', async () => {
  const r = createReadiness({
    checks: { ...allOk(), database: () => new Promise(() => {}), smtp: async () => { throw new Error('boom'); } },
    timeoutMs: 30,
    log: fakeLog(),
  });
  const started = Date.now();
  const result = await r.check();
  assert.ok(Date.now() - started < 1000, 'bounded');
  assert.equal(result.checks.database, 'down');
  assert.equal(result.checks.smtp, 'down');
  assert.equal(result.status, 'not_ready');
});

test('non-critical checks are cached; critical checks run every time', async () => {
  let clock = 1_000_000;
  const calls = { database: 0, storage: 0, smtp: 0 };
  const counted = (name, status = 'ok') => async () => { calls[name] += 1; return { status }; };
  const r = createReadiness({
    checks: { ...allOk(), database: counted('database'), storage: counted('storage'), smtp: counted('smtp') },
    cacheTtlMs: 10_000,
    smtpTtlMs: 60_000,
    now: () => clock,
    log: fakeLog(),
  });
  await r.check();
  await r.check();
  assert.deepEqual(calls, { database: 2, storage: 1, smtp: 1 });
  clock += 11_000; // storage stale, smtp still fresh
  await r.check(); // serves the stale storage value, refreshes in background
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.storage, 2);
  assert.equal(calls.smtp, 1);
  await r.check({ fresh: true });
  assert.equal(calls.smtp, 2);
});

test('status transitions are logged once (SMTP goes down, then recovers)', async () => {
  let smtp = 'ok';
  const log = fakeLog();
  const r = createReadiness({ checks: { ...allOk(), smtp: async () => ({ status: smtp }) }, log });
  await r.check({ fresh: true });
  smtp = 'down';
  await r.check({ fresh: true });
  await r.check({ fresh: true });
  smtp = 'ok';
  await r.check({ fresh: true });
  const smtpLogs = log.entries.filter((e) => e.obj.dependency === 'smtp');
  assert.deepEqual(smtpLogs.map((e) => [e.level, e.obj.status]), [['warn', 'down'], ['info', 'ok']]);
  assert.match(smtpLogs[0].msg, /smtp is down/);
});

test('public status exposes component states only', async () => {
  const outage = toPublicStatus({ checks: { database: 'down', redis: 'ok', queue: 'ok', storage: 'ok', scheduler: 'ok', smtp: 'disabled' }, checkedAt: '2026-10-21T00:00:00.000Z' });
  assert.deepEqual(outage, {
    status: 'outage',
    components: { api: 'outage', background_jobs: 'operational', file_storage: 'operational', email_delivery: 'operational' },
    updatedAt: '2026-10-21T00:00:00.000Z',
  });
  const degraded = toPublicStatus({ checks: { database: 'ok', redis: 'disabled', queue: 'ok', storage: 'ok', scheduler: 'degraded', smtp: 'down' }, checkedAt: 'x' });
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.components.background_jobs, 'degraded');
  assert.equal(degraded.components.email_delivery, 'outage');

  resetPublicStatusCache();
  const evaluator = createReadiness({ checks: allOk(), log: fakeLog() });
  const first = await getPublicStatus({ evaluator, ttlMs: 60_000 });
  assert.equal(first.status, 'operational');
});

test('GET /status is public and leaks no internals', async () => {
  resetPublicStatusCache();
  const res = await api('/api/v1/status');
  assert.equal(res.status, 200);
  const { data } = res.json;
  assert.ok(['operational', 'degraded', 'outage'].includes(data.status));
  assert.deepEqual(Object.keys(data).sort(), ['components', 'status', 'updatedAt']);
  for (const [name, state] of Object.entries(data.components)) {
    assert.ok(['api', 'background_jobs', 'file_storage', 'email_delivery'].includes(name), name);
    assert.ok(['operational', 'degraded', 'outage'].includes(state), state);
  }
  const text = JSON.stringify(res.json);
  for (const internal of ['latency', 'mongodb', 'redis://', 'error', 'version', 'hostname', 'pid']) {
    assert.ok(!text.toLowerCase().includes(internal), `leaked ${internal}`);
  }
});

test('GET /health/ready body carries only component statuses', async () => {
  const res = await api('/api/v1/health/ready');
  const { checks } = res.json.data;
  assert.deepEqual(Object.keys(checks).sort(), ['database', 'queue', 'redis', 'scheduler', 'smtp', 'storage']);
  assert.ok(!JSON.stringify(res.json).includes('latencyMs'));
});

async function closedPort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

test('Redis unreachable: the aggregate degrades (no 500) and the Redis probe reports down', async () => {
  const driver = createRedisCache({ url: `redis://127.0.0.1:${await closedPort()}`, keyPrefix: 'test:' });
  // The same wrapping cache.service applies: driver failures become CacheError.
  const cache = {
    async getOrSet(key, fn, ttl) {
      try {
        return await driver.getOrSet(key, fn, ttl);
      } catch (err) {
        throw new CacheError('CACHE_OPERATION_FAILED', err.message);
      }
    },
  };
  try {
    const redis = await monitoringService.getRedisHealth({ enabled: true, roundTrip: () => driver.get('probe'), timeoutMs: 2000 });
    assert.equal(redis.status, 'down');
    assert.equal(typeof redis.error, 'string');

    const compute = async () => ({ ...(await monitoringService.computeAggregateHealth()), redis });
    const aggregate = await monitoringService.getAggregateHealth({ cache, compute });
    assert.equal(aggregate.cached, false);
    assert.equal(aggregate.redis.status, 'down');
    assert.ok(['ok', 'degraded', 'down'].includes(aggregate.status));
    assert.equal(aggregate.db.status, 'ok');

    // Any other failure is not swallowed.
    await assert.rejects(
      monitoringService.getAggregateHealth({ cache: { getOrSet: async () => { throw new TypeError('bug'); } } }),
      TypeError,
    );
  } finally {
    await driver.close();
  }
});

test('roll-up: hard dependencies decide down, everything else degraded', () => {
  assert.equal(monitoringService.rollUp({ critical: [{ status: 'ok' }], other: [{ status: 'down' }] }), 'degraded');
  assert.equal(monitoringService.rollUp({ critical: [{ status: 'down' }], other: [] }), 'down');
  assert.equal(monitoringService.rollUp({ critical: [{ status: 'disabled' }], other: [{ status: 'ok' }] }), 'ok');
});

test('storage and SMTP probes', async () => {
  assert.equal((await monitoringService.getStorageHealth({ exists: async () => false, provider: 's3' })).status, 'ok');
  const forbidden = await monitoringService.getStorageHealth({
    exists: async () => { throw Object.assign(new Error('Access Denied'), { $metadata: { httpStatusCode: 403 } }); },
    provider: 's3',
  });
  assert.equal(forbidden.status, 'degraded');
  const unreachable = await monitoringService.getStorageHealth({
    exists: async () => { throw new Error('connect ETIMEDOUT s3://AKIAEXAMPLE:secret@bucket'); },
    provider: 's3',
  });
  assert.equal(unreachable.status, 'down');
  assert.ok(!unreachable.error.includes('secret'), 'credentials masked in probe errors');
  const hung = await monitoringService.getStorageHealth({ exists: () => new Promise(() => {}), timeoutMs: 30 });
  assert.equal(hung.status, 'down');

  assert.equal((await monitoringService.getSmtpHealth({ transportType: 'noop' })).status, 'disabled');
  assert.equal((await monitoringService.getSmtpHealth({ transportType: 'smtp', verify: async () => true })).status, 'ok');
  const smtpDown = await monitoringService.getSmtpHealth({ transportType: 'smtp', verify: () => new Promise(() => {}), timeoutMs: 30 });
  assert.equal(smtpDown.status, 'down');
});
