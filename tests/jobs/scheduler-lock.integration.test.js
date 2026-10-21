/**
 * Durable jobs (roadmap 1.4): distributed job lock, JobRun records and the
 * scheduler lifecycle.
 *
 * Exit criterion covered here: overlapping cron runs are prevented by the
 * lock (two instances, or a slow tick overlapping the next).
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { createMongoLock, createRedisLock } from '../../src/jobs/lock.js';
import {
  runJob,
  stopScheduler,
  resetSchedulerForTests,
  initScheduler,
  getRegisteredJobs,
} from '../../src/jobs/scheduler.js';
import { setProcessRole, runsBackgroundWork } from '../../src/jobs/runtime.js';
import { startBackgroundWork } from '../../src/jobs/background.js';
import { JobRun } from '../../src/models/JobRun.js';
import { JobLock } from '../../src/models/JobLock.js';

before(async () => { await startMongo(); });
beforeEach(async () => {
  await resetMongo();
  resetSchedulerForTests();
  setProcessRole(null);
});
after(async () => {
  setProcessRole(null);
  await stopMongo();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A job whose handler takes `ms` and counts its invocations. */
function slowJob(name, ms, result = { processed: 3 }) {
  const job = {
    name,
    calls: 0,
    leaseMs: 60000,
    async handler() {
      job.calls += 1;
      await sleep(ms);
      return result;
    },
  };
  return job;
}

/* ------------------------------ Mongo lock ------------------------------ */

test('mongo lock: only one of many concurrent acquirers gets the lease', async () => {
  const lock = createMongoLock();
  const tokens = await Promise.all(
    ['a', 'b', 'c', 'd', 'e'].map((owner) => lock.acquire('job:test', { owner, leaseMs: 60000 })),
  );
  assert.equal(tokens.filter(Boolean).length, 1);
});

test('mongo lock: renew/release need the owner token; an expired lease is taken over', async () => {
  const lock = createMongoLock();
  const token = await lock.acquire('job:x', { owner: 'a', leaseMs: 60000 });
  assert.ok(token);
  assert.equal(await lock.acquire('job:x', { owner: 'b', leaseMs: 60000 }), null, 'held lock cannot be taken');
  assert.equal(await lock.renew('job:x', 'not-the-token', { leaseMs: 60000 }), false);
  assert.equal(await lock.renew('job:x', token, { leaseMs: 60000 }), true);
  assert.equal(await lock.release('job:x', 'not-the-token'), false);
  assert.equal(await lock.release('job:x', token), true);
  const next = await lock.acquire('job:x', { owner: 'b', leaseMs: 60000 });
  assert.ok(next, 'released lock can be taken');

  // Holder crashes: its lease runs out and another instance takes over.
  await JobLock.updateOne({ _id: 'job:x' }, { $set: { lockedUntil: new Date(Date.now() - 1) } });
  const takeover = await lock.acquire('job:x', { owner: 'c', leaseMs: 60000 });
  assert.ok(takeover, 'expired lease is taken over');
  assert.equal(await lock.renew('job:x', next, { leaseMs: 60000 }), false, 'old holder lost the lock');
});

test('mongo lock: release with holdUntil keeps the lock until then (tick fencing)', async () => {
  const lock = createMongoLock();
  const token = await lock.acquire('job:fence', { owner: 'a', leaseMs: 60000 });
  await lock.release('job:fence', token, { holdUntil: new Date(Date.now() + 30000) });
  assert.equal(await lock.acquire('job:fence', { owner: 'b', leaseMs: 60000 }), null);
});

/* ------------------------------ Redis lock ------------------------------ */

/** Minimal in-memory stand-in for the ioredis calls the lock uses. */
function fakeRedis() {
  const store = new Map();
  const alive = (key) => {
    const entry = store.get(key);
    if (entry && entry.expiresAt <= Date.now()) store.delete(key);
    return store.get(key);
  };
  return {
    store,
    async set(key, value, px, ms, nx) {
      assert.equal(px, 'PX');
      assert.equal(nx, 'NX');
      if (alive(key)) return null;
      store.set(key, { value, expiresAt: Date.now() + ms });
      return 'OK';
    },
    async eval(script, numKeys, key, token, ms) {
      assert.equal(numKeys, 1);
      const entry = alive(key);
      if (!entry || entry.value !== token) return 0;
      if (script.includes("redis.call('del'") && Number(ms) === 0) {
        store.delete(key);
        return 1;
      }
      entry.expiresAt = Date.now() + Number(ms);
      return 1;
    },
  };
}

test('redis lock: SET NX PX semantics with compare-and-set renew/release', async () => {
  const redis = fakeRedis();
  const lock = createRedisLock({ client: redis });
  const [t1, t2] = await Promise.all([
    lock.acquire('job:r', { owner: 'a', leaseMs: 1000 }),
    lock.acquire('job:r', { owner: 'b', leaseMs: 1000 }),
  ]);
  assert.equal([t1, t2].filter(Boolean).length, 1, 'only one SET NX wins');
  const token = t1 ?? t2;
  assert.equal(await lock.renew('job:r', 'other', { leaseMs: 1000 }), false);
  assert.equal(await lock.renew('job:r', token, { leaseMs: 1000 }), true);
  assert.equal(await lock.release('job:r', 'other'), false);
  assert.equal(await lock.release('job:r', token), true);
  assert.equal(redis.store.has('saas:lock:job:r'), false);

  const fenced = await lock.acquire('job:r', { owner: 'a', leaseMs: 1000 });
  await lock.release('job:r', fenced, { holdUntil: new Date(Date.now() + 5000) });
  assert.equal(await lock.acquire('job:r', { owner: 'b', leaseMs: 1000 }), null, 'held until the fence');
});

/* ------------------------------- runJob --------------------------------- */

test('overlapping runs of one job are prevented: two instances, one execution', async () => {
  const job = slowJob('overlap-test', 150);
  const [a, b] = await Promise.all([
    runJob(job, { instanceId: 'instance-a' }),
    runJob(job, { instanceId: 'instance-b' }),
  ]);
  assert.equal(job.calls, 1, 'the handler ran once');
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, ['skipped', 'succeeded']);
  assert.equal([a, b].find((r) => r.status === 'skipped').reason, 'locked');

  const runs = await JobRun.find({ job: 'overlap-test' }).lean();
  assert.equal(runs.length, 1, 'one JobRun recorded');
  assert.equal(runs[0].status, 'succeeded');
  assert.deepEqual(runs[0].counts, { processed: 3 });
  assert.ok(['instance-a', 'instance-b'].includes(runs[0].instanceId));
  assert.ok(runs[0].finishedAt >= runs[0].startedAt);
  assert.equal(typeof runs[0].durationMs, 'number');
  assert.equal(runs[0].leaseUntil, null);
  assert.ok(runs[0].expiresAt > new Date(), 'finished runs carry a retention expiry');

  // Lock released after completion: the next tick runs again.
  const next = await runJob(job, { instanceId: 'instance-b' });
  assert.equal(next.status, 'succeeded');
  assert.equal(job.calls, 2);
});

test('a slow tick overlapping the next tick on the same instance is skipped', async () => {
  const job = slowJob('slow-tick', 200);
  const first = runJob(job, { instanceId: 'solo' });
  await sleep(30);
  const second = await runJob(job, { instanceId: 'solo' });
  assert.equal(second.status, 'skipped');
  assert.equal((await first).status, 'succeeded');
  assert.equal(job.calls, 1);
});

test('tick fencing: a late instance does not re-run a tick that already ran', async () => {
  const job = slowJob('fenced', 5);
  const tickAt = new Date();
  const first = await runJob(job, { tickAt, instanceId: 'early' });
  assert.equal(first.status, 'succeeded');
  const late = await runJob(job, { tickAt, instanceId: 'late' });
  assert.equal(late.status, 'skipped');
  assert.equal(job.calls, 1);
});

test('a failing job records a failed JobRun with a sanitised error and frees the lock', async () => {
  const job = {
    name: 'failing-job',
    leaseMs: 60000,
    async handler() {
      const err = new Error('connect failed mongodb://admin:hunter2@db.internal:27017/x password=hunter2\n    at stack line');
      err.code = 'ECONNREFUSED';
      throw err;
    },
  };
  const result = await runJob(job, { instanceId: 'i1' });
  assert.equal(result.status, 'failed');
  const run = await JobRun.findOne({ job: 'failing-job' }).lean();
  assert.equal(run.status, 'failed');
  assert.equal(run.error.code, 'ECONNREFUSED');
  assert.doesNotMatch(run.error.message, /hunter2/);
  assert.doesNotMatch(run.error.message, /stack line/);
  // Lock released: the job can run again on the next tick.
  const retry = await runJob(job, { instanceId: 'i2' });
  assert.equal(retry.status, 'failed');
});

test('an unreachable lock backend skips the tick (fails closed)', async () => {
  const job = slowJob('lock-down', 1);
  const brokenLock = { acquire: async () => { throw new Error('redis down'); } };
  const result = await runJob(job, { lock: brokenLock });
  assert.deepEqual(result, { status: 'skipped', reason: 'lock_unavailable' });
  assert.equal(job.calls, 0);
});

test('stopScheduler waits for in-flight runs, bounded by its timeout', async () => {
  const quick = slowJob('drain-quick', 100);
  const pending = runJob(quick, { instanceId: 'd' });
  await sleep(10);
  const drained = await stopScheduler({ timeoutMs: 2000 });
  assert.equal(drained.drained, true);
  assert.equal((await pending).status, 'succeeded');

  // After stop, new ticks are refused.
  const refused = await runJob(slowJob('after-stop', 1));
  assert.deepEqual(refused, { status: 'skipped', reason: 'stopping' });

  resetSchedulerForTests();
  const hanging = slowJob('drain-hang', 1000);
  const hangingRun = runJob(hanging, { instanceId: 'd' });
  await sleep(10);
  const t0 = Date.now();
  const bounded = await stopScheduler({ timeoutMs: 100 });
  assert.equal(bounded.drained, false);
  assert.ok(Date.now() - t0 < 600, 'stop does not wait past its timeout');
  await hangingRun;
});

/* --------------------------- roles + registry --------------------------- */

test('the stale-job reaper is a registered, enabled job', () => {
  const reaper = getRegisteredJobs().find((j) => j.name === 'stale-job-recovery');
  assert.ok(reaper, 'stale-job-recovery is registered');
  assert.equal(reaper.enabled, true);
  assert.equal(reaper.cronExpression, '*/5 * * * *');
});

test('a web-role process starts neither the scheduler nor queue consumers', () => {
  setProcessRole('web');
  assert.equal(runsBackgroundWork(), false);
  assert.equal(initScheduler(), false);
  assert.equal(startBackgroundWork(), false);
  setProcessRole('worker');
  assert.equal(runsBackgroundWork(), true);
  assert.throws(() => setProcessRole('janitor'), /Invalid process role/);
});
