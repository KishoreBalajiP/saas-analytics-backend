/**
 * Database configuration and lifecycle.
 *
 * WHY IT EXISTS
 *   Owns the MongoDB connection lifecycle so the rest of the application is
 *   never coupled to Mongoose connection mechanics. `server.js` boots it,
 *   features consume it, and shutdown drains it.
 *
 * RESPONSIBILITY
 *   - Connect to MongoDB with production-tuned Mongoose options.
 *   - Retry a bounded number of times on startup failure. The web process
 *     then keeps reconnecting in the background (`reconnectUntilConnected`,
 *     exponential backoff) while readiness reports 503: Mongoose only
 *     auto-reconnects after a SUCCESSFUL initial connection, so without this
 *     a boot-time outage left the instance degraded forever (findings ops.05,
 *     ops2.02). The worker process exits instead and is restarted.
 *   - Listen to connection events for observability.
 *   - Expose `disconnectDatabase()` for graceful shutdown.
 *
 * HOW TO EXTEND
 *   - Tune pool / timeout values through `.env` (already wired).
 *   - Add connection event listeners here rather than scattering them.
 *   - Move to replica sets / Atlas: the URI is the only thing that changes.
 */

import mongoose from 'mongoose';
import env from './env.js';
import logger from './logger.js';

let isConnected = false;

const connectionOptions = {
  // Production does not build indexes at boot; run `npm run db:indexes -- --apply`
  // as a deploy step (scripts/ci/sync-indexes.js). Development builds them.
  autoIndex: !env.app.isProduction,
  bufferCommands: false, // fail loudly instead of queueing when disconnected
  maxPoolSize: env.database.maxPoolSize,
  minPoolSize: env.database.minPoolSize,
  // env exposes these as ...TimeoutMs; the driver option names end in MS.
  serverSelectionTimeoutMS: env.database.serverSelectionTimeoutMs,
  connectTimeoutMS: env.database.connectTimeoutMs,
  heartbeatFrequencyMS: 10000,
  family: 4, // prefer IPv4, avoids localhost/DNS IPv6 stalls on some hosts
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Attach one-time listeners that log every connectivity change. */
function bindConnectionListeners() {
  mongoose.connection.on('connected', () => {
    isConnected = true;
    logger.info('MongoDB connected');
  });

  mongoose.connection.on('disconnected', () => {
    isConnected = false;
    logger.warn('MongoDB disconnected');
  });

  mongoose.connection.on('reconnected', () => {
    isConnected = true;
    logger.info('MongoDB reconnected');
  });

  mongoose.connection.on('error', (err) => {
    logger.error({ err: { message: err.message } }, 'MongoDB connection error');
  });
}

/**
 * Establish the initial connection with a bounded retry loop.
 *
 * @returns {Promise<boolean>} true when connected, false after exhausting
 *   attempts (the caller decides whether to continue in degraded mode).
 */
export async function connectDatabase({ autoIndex } = {}) {
  if (isConnected) return true;
  // Maintenance scripts pass autoIndex:false so connecting never builds
  // indexes as a side effect (a dry run must not write).
  const options = autoIndex === undefined ? connectionOptions : { ...connectionOptions, autoIndex };

  bindConnectionListeners();

  for (let attempt = 1; attempt <= env.database.connectAttempts; attempt += 1) {
    try {
      await mongoose.connect(env.database.uri, options);
      isConnected = true;
      return true;
    } catch (err) {
      logger.error(
        { err: { message: err.message }, attempt, total: env.database.connectAttempts },
        'MongoDB connection attempt failed',
      );
      if (attempt < env.database.connectAttempts) {
        await sleep(env.database.retryDelayMs);
      }
    }
  }

  logger.fatal('MongoDB unavailable after all attempts - not ready; reconnecting in the background');
  return false;
}

/**
 * Keep trying to connect (observability: findings ops.05 / ops2.02), with
 * exponential backoff from `initialDelayMs` capped at `maxDelayMs`, until
 * connected or `signal` aborts. Each failure is logged with the attempt
 * number. Resolves true once connected, false when aborted.
 *
 * @param {Object} [options]
 * @param {() => Promise<boolean>} [options.connect] - one attempt; true when connected.
 * @param {number} [options.initialDelayMs]
 * @param {number} [options.maxDelayMs]
 * @param {AbortSignal} [options.signal]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.wait]
 * @returns {Promise<boolean>}
 */
export async function reconnectUntilConnected({
  connect = connectOnce,
  initialDelayMs = env.database.retryDelayMs,
  maxDelayMs = env.observability?.dbReconnectMaxDelayMs ?? 30000,
  signal,
  wait = abortableSleep,
} = {}) {
  let delay = Math.max(1, initialDelayMs);
  for (let attempt = 1; !signal?.aborted; attempt += 1) {
    await wait(delay, signal);
    if (signal?.aborted) break;
    try {
      if (await connect()) {
        logger.info({ attempt }, 'MongoDB connected after background reconnect');
        return true;
      }
    } catch (err) {
      logger.error({ err: { message: err?.message }, attempt, nextDelayMs: Math.min(delay * 2, maxDelayMs) }, 'MongoDB background reconnect failed');
    }
    delay = Math.min(delay * 2, Math.max(1, maxDelayMs));
  }
  return false;
}

/** One connection attempt with the production options (no retry loop). */
async function connectOnce() {
  if (isConnected && mongoose.connection.readyState === 1) return true;
  if (mongoose.connection.readyState === 2) {
    // A connect is already in flight (driver-level): wait for its outcome.
    await mongoose.connection.asPromise();
    return mongoose.connection.readyState === 1;
  }
  await mongoose.connect(env.database.uri, connectionOptions);
  isConnected = true;
  return true;
}

function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', done);
      resolve();
    }
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

/** Bounded delay for the disconnect step so shutdown can never hang. */
const DISCONNECT_TIMEOUT_MS = 5000;

/** Close the connection cleanly (used by graceful shutdown). */
export async function disconnectDatabase() {
  // Already disconnected (or never connected) - nothing to drain.
  if (mongoose.connection.readyState === 0) return;

  try {
    // Race the disconnect against a timeout: a connect that is still in
    // flight would otherwise block shutdown for the whole server-selection
    // window. Never let the database stall a graceful restart.
    await Promise.race([
      mongoose.disconnect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Database disconnect timed out')), DISCONNECT_TIMEOUT_MS),
      ),
    ]);
    isConnected = false;
    logger.info('MongoDB connection closed');
  } catch (err) {
    isConnected = false;
    logger.warn(
      { err: { message: err.message } },
      'Database disconnect incomplete - continuing shutdown',
    );
  }
}

/** Live connectivity flag exposed to the health endpoint. */
export function isDatabaseConnected() {
  return isConnected && mongoose.connection.readyState === 1;
}
