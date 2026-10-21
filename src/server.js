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
 * PROCESS ROLE (roadmap 1.4)
 *   PROCESS_ROLE=all (default) also runs the queue consumers and the
 *   scheduler here. PROCESS_ROLE=web serves HTTP only and leaves background
 *   work to `src/worker.js` (`npm run start:worker`).
 *
 * HOW TO EXTEND
 *   New boot-time dependencies (Redis, queue consumers) are initialised here,
 *   in dependency order, and torn down in `jobs/shutdown.js` steps.
 */

import http from 'node:http';
import app from './app.js';
import env from './config/env.js';
import logger from './utils/logger.js';
import { connectDatabase } from './config/database.js';
import { initSocket, getIO } from './websocket/index.js';
import { startBackgroundWork, defaultShutdownDeps } from './jobs/background.js';
import { buildShutdownSteps, runShutdownSteps } from './jobs/shutdown.js';
import { closeRateLimitStore } from './middleware/rateLimiter.middleware.js';
// billing: idempotent seed of the default plan catalogue at startup.
import planService from './services/plan.service.js';
// observability: background DB reconnect + crash reporting (roadmap 2.8).
import { reconnectUntilConnected } from './config/database.js';
import { reportError, flushErrorReports } from './services/errorReporter.service.js';

const server = http.createServer(app);
const io = initSocket(server);

let shuttingDown = false;
// observability: stops the background reconnect loop on shutdown.
const reconnectAbort = new AbortController();

/** Boot sequence. */
function start() {
  // Listen first so probes/liveness work immediately; the database connects
  // in the background (retries + degraded mode) and health reports readiness.
  server.listen(env.app.port, () => {
    logger.info(
      { port: env.app.port, env: env.app.env, version: env.app.version },
      `${env.app.name} is running`,
    );

    connectDatabase()
      .then(async (dbConnected) => {
        if (!dbConnected) {
          // Not ready (readiness answers 503) until the database is back;
          // keep reconnecting instead of staying degraded forever (ops.05).
          logger.warn('Database is unavailable: not ready, reconnecting in the background');
          const recovered = await reconnectUntilConnected({ signal: reconnectAbort.signal });
          if (!recovered) return;
        }
        // billing (finding bil.13): seed missing default plans / feature keys /
        // prices once connected. Idempotent; never overwrites edited prices.
        if (env.billing.seedPlansOnStartup) {
          planService.ensureDefaults('system')
            .then((r) => logger.info({ created: r.created.length, updated: r.updated }, 'Plan catalogue ensured'))
            .catch((err) => logger.warn({ err: { message: err?.message } }, 'Plan catalogue seed failed'));
        }
        // Queue consumers + scheduler (roles worker/all only; a web process
        // just enqueues). Started only once the database is connected, so
        // jobs never run against a missing database.
        if (!shuttingDown) startBackgroundWork();
      })
      .catch((err) => logger.error({ err: { message: err?.message } }, 'Database startup failed'));
  });
}

/**
 * Graceful shutdown (see `jobs/shutdown.js` for the order): close Socket.IO
 * clients together with the HTTP server, stop the scheduler, drain queue
 * consumers (bounded), close Redis-backed resources, then the database -
 * every step time-boxed so the whole sequence fits SHUTDOWN_TIMEOUT_MS. A
 * hard timer remains as the last resort.
 */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  reconnectAbort.abort();
  logger.info({ signal }, 'Graceful shutdown initiated');

  const forceExitTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out - forcing exit');
    process.exit(1);
  }, env.server.shutdownTimeoutMs + 2000);
  forceExitTimer.unref();

  try {
    const outcome = await runShutdownSteps(
      buildShutdownSteps({
        server,
        io: io ?? getIO(),
        drainTimeoutMs: env.server.drainTimeoutMs,
        // The HTTP surface also owns the auth rate-limit store's Redis
        // connection (only present with REDIS_URL).
        deps: { ...defaultShutdownDeps(), closeRateLimitStore },
      }),
      { timeoutMs: env.server.shutdownTimeoutMs },
    );
    logger.info({ durationMs: outcome.durationMs, steps: outcome.steps }, 'Shutdown complete');
    await flushErrorReports({ timeoutMs: 1000 });
    await logger.flush?.();
    process.exit(outcome.ok ? 0 : 1);
  } catch (err) {
    logger.error({ err: { message: err.message } }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// A truly uncaught exception is a programming bug - log and fail fast.
process.on('uncaughtException', (err) => {
  logger.fatal({ err: { message: err.message, stack: err.stack } }, 'Uncaught exception');
  // Give the error reporter a moment to deliver the crash, then exit.
  reportError(err, { source: 'process', level: 'fatal' });
  flushErrorReports({ timeoutMs: 1500 }).finally(() => process.exit(1));
});

// Rejected promises are logged but do not crash the process by default.
process.on('unhandledRejection', (reason) => {
  logger.error(
    { err: { message: reason?.message ?? String(reason), stack: reason?.stack } },
    'Unhandled promise rejection',
  );
  void reportError(reason, { source: 'process' });
});

start();
