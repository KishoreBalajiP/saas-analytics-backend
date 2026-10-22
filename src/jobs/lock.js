/**
 * Distributed lease lock for scheduled jobs (roadmap 1.4).
 *
 * WHY IT EXISTS
 *   Every process that runs the scheduler fires the same cron ticks. Without
 *   a shared lock, two instances (or a slow tick overlapping the next one)
 *   run the same job at the same time. This module gives each job a lease:
 *   only the holder runs, it renews the lease while it works, and a crashed
 *   holder's lease simply expires.
 *
 * BACKENDS
 *   - Redis (`REDIS_URL` set): `SET key token NX PX lease`; renew/release are
 *     compare-and-set Lua scripts so a process can never touch a lock it no
 *     longer owns.
 *   - MongoDB (fallback): one `JobLock` document per key, taken with an
 *     atomic conditional upsert (`repositories/jobLock.repository.js`).
 *
 *   Lock errors fail CLOSED: when the backend is unreachable the job is
 *   skipped for that tick rather than risking a duplicate run.
 *
 * CONTRACT
 *   acquire(key, { owner, leaseMs }) -> token | null
 *   renew(key, token, { leaseMs })    -> boolean
 *   release(key, token, { holdUntil }) -> boolean
 *   `holdUntil` keeps the lock taken until that time (tick fencing: an
 *   instance whose clock fires a few seconds later does not run the same
 *   tick again).
 */

import { randomUUID } from 'node:crypto';
import IORedis from 'ioredis';
import env from '../config/env.js';
import logger from '../utils/logger.js';
import jobLockRepository from '../repositories/jobLock.repository.js';

const REDIS_PREFIX = 'saas:lock:';
const REDIS_READY_TIMEOUT_MS = 3000;

const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0`;

const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  if tonumber(ARGV[2]) > 0 then
    return redis.call('pexpire', KEYS[1], ARGV[2])
  end
  return redis.call('del', KEYS[1])
end
return 0`;

/** Unique token for one lock acquisition. */
function newToken(owner) {
  return `${owner ?? 'unknown'}:${randomUUID()}`;
}

/**
 * MongoDB-backed lock.
 *
 * @param {Object} [deps]
 * @param {Object} [deps.repository] - jobLock repository (injectable for tests).
 * @returns {{ backend: 'mongo', acquire: Function, renew: Function, release: Function, close: Function }}
 */
export function createMongoLock({ repository = jobLockRepository } = {}) {
  return {
    backend: 'mongo',
    async acquire(key, { owner, leaseMs }) {
      const token = newToken(owner);
      const ok = await repository.acquire(key, { owner, token, leaseMs, now: new Date() });
      return ok ? token : null;
    },
    async renew(key, token, { leaseMs }) {
      return repository.renew(key, { token, leaseMs, now: new Date() });
    },
    async release(key, token, { holdUntil = null } = {}) {
      return repository.release(key, { token, holdUntil, now: new Date() });
    },
    async close() {},
  };
}

/**
 * Redis-backed lock. `client` must expose ioredis' `set` and `eval`.
 *
 * @param {Object} deps
 * @param {Object|Function} deps.client - ioredis client, or a function returning a promise of one.
 * @param {string} [deps.prefix]
 * @returns {{ backend: 'redis', acquire: Function, renew: Function, release: Function, close: Function }}
 */
export function createRedisLock({ client, prefix = REDIS_PREFIX } = {}) {
  const resolveClient = typeof client === 'function' ? client : async () => client;
  return {
    backend: 'redis',
    async acquire(key, { owner, leaseMs }) {
      const redis = await resolveClient();
      const token = newToken(owner);
      const reply = await redis.set(`${prefix}${key}`, token, 'PX', Math.max(1, Math.round(leaseMs)), 'NX');
      return reply === 'OK' ? token : null;
    },
    async renew(key, token, { leaseMs }) {
      const redis = await resolveClient();
      const reply = await redis.eval(RENEW_SCRIPT, 1, `${prefix}${key}`, token, String(Math.max(1, Math.round(leaseMs))));
      return Number(reply) === 1;
    },
    async release(key, token, { holdUntil = null } = {}) {
      const redis = await resolveClient();
      const holdMs = holdUntil ? Math.max(0, holdUntil.getTime() - Date.now()) : 0;
      const reply = await redis.eval(RELEASE_SCRIPT, 1, `${prefix}${key}`, token, String(Math.round(holdMs)));
      return Number(reply) === 1;
    },
    async close() {
      const redis = typeof client === 'function' ? null : client;
      if (redis?.quit) await redis.quit().catch(() => redis.disconnect?.());
    },
  };
}

/* ------------------------- process-wide singleton ------------------------ */

let singleton = null;
let redisClient = null;

/** Lazily connect the dedicated lock client and wait (bounded) for ready. */
function getRedisClient() {
  if (!redisClient) {
    redisClient = new IORedis(env.redis.url, {
      // Fail fast: a lock we cannot reach means "skip this tick", never hang.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: REDIS_READY_TIMEOUT_MS,
    });
    redisClient.on('error', (err) => {
      logger.warn({ err: { message: err.message } }, 'Job lock Redis connection error');
    });
  }
  if (redisClient.status === 'ready') return Promise.resolve(redisClient);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Job lock Redis is not ready'));
    }, REDIS_READY_TIMEOUT_MS);
    const onReady = () => { cleanup(); resolve(redisClient); };
    const cleanup = () => { clearTimeout(timer); redisClient.removeListener('ready', onReady); };
    redisClient.once('ready', onReady);
  });
}

/**
 * The lock used by the scheduler: Redis when configured, else MongoDB.
 *
 * @returns {ReturnType<typeof createMongoLock>|ReturnType<typeof createRedisLock>}
 */
export function getJobLock() {
  if (singleton) return singleton;
  singleton = env.redis.enabled ? createRedisLock({ client: getRedisClient }) : createMongoLock();
  return singleton;
}

/** Close the lock's Redis connection (graceful shutdown). */
export async function closeJobLock() {
  singleton = null;
  if (!redisClient) return;
  const client = redisClient;
  redisClient = null;
  if (client.status !== 'ready') {
    client.disconnect();
    return;
  }
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}

export default { createMongoLock, createRedisLock, getJobLock, closeJobLock };
