/**
 * Process bootstrap.
 *
 * WHY IT EXISTS
 *   `server.js` is the process entry point. It composes the parts the app
 *   needs to run (HTTP server, Socket.IO, database, scheduler) and owns the
 *   process lifecycle, including graceful shutdown.
 *
 * RESPONSIBILITY
 *   - Create the HTTP server from the assembled Express app.
 *   - Initialise Socket.IO on that server.
 *   - Connect MongoDB (retry, then continue in degraded mode if it fails).
 *   - Start the scheduler, then listen.
 *   - Handle SIGINT/SIGTERM with a graceful, time-bounded shutdown.
 *
 * HOW TO EXTEND
 *   New boot-time dependencies (Redis, queue consumers) are initialised here,
 *   in dependency order, and torn down inside `shutdown`.
 */

import http from 'node:http';
import app from './app.js';
import env from './config/env.js';
import logger from './utils/logger.js';
import {
  connectDatabase,
  disconnectDatabase,
} from './config/database.js';
import { initSocket, getIO } from './websocket/index.js';
import { initScheduler, stopScheduler } from './jobs/scheduler.js';

const server = http.createServer(app);
const io = initSocket(server);

let shuttingDown = false;

/** Boot sequence. */
function start() {
  // Listen first so probes/liveness work immediately; the database connects
  // in the background (retries + degraded mode) and health reports readiness.
  server.listen(env.app.port, () => {
    logger.info(
      { port: env.app.port, env: env.app.env, version: env.app.version },
      `${env.app.name} is running`,
    );

    connectDatabase().then((dbConnected) => {
      if (!dbConnected) {
        logger.warn('Running in DEGRADED mode: database is unavailable');
      }
      initScheduler();
    });
  });
}

/**
 * Graceful shutdown: stop accepting new work, drain in-flight requests,
 * then close sockets, scheduler and database - with a hard timeout so the
 * process can never hang forever.
 */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Graceful shutdown initiated');

  const forceExitTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out - forcing exit');
    process.exit(1);
  }, env.server.shutdownTimeoutMs);
  forceExitTimer.unref();

  server.closeIdleConnections?.();

  server.close(async () => {
    try {
      io?.close();
      await stopScheduler();
      await disconnectDatabase();
      await logger.flush?.();
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err: { message: err.message } }, 'Error during shutdown');
      process.exit(1);
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// A truly uncaught exception is a programming bug - log and fail fast.
process.on('uncaughtException', (err) => {
  logger.fatal({ err: { message: err.message, stack: err.stack } }, 'Uncaught exception');
  process.exit(1);
});

// Rejected promises are logged but do not crash the process by default.
process.on('unhandledRejection', (reason) => {
  logger.error(
    { err: { message: reason?.message ?? String(reason), stack: reason?.stack } },
    'Unhandled promise rejection',
  );
});

start();
