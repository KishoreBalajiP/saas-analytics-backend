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
 *   - Retry a bounded number of times on startup failure, then start the app
 *     in *degraded mode* (the process stays up so health checks / liveness
 *     still work and Mongo auto-reconnect can take over).
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
  autoIndex: !env.app.isProduction, // prod uses explicit migrations, dev builds indexes
  bufferCommands: false, // fail loudly instead of queueing when disconnected
  maxPoolSize: env.database.maxPoolSize,
  minPoolSize: env.database.minPoolSize,
  serverSelectionTimeoutMS: env.database.serverSelectionTimeoutMS,
  connectTimeoutMS: env.database.connectTimeoutMS,
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
export async function connectDatabase() {
  if (isConnected) return true;

  bindConnectionListeners();

  for (let attempt = 1; attempt <= env.database.connectAttempts; attempt += 1) {
    try {
      await mongoose.connect(env.database.uri, connectionOptions);
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

  logger.fatal('MongoDB unavailable after all attempts - continuing in degraded mode');
  return false;
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
