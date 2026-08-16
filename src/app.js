/**
 * Express application assembly.
 *
 * WHY IT EXISTS
 *   `app.js` is the ONLY place Express is configured. It does not listen on a
 *   port, does not connect to MongoDB and knows nothing about Socket.IO -
 *   that separation is what makes the app unit-testable and keeps concerns
 *   clean as the team grows.
 *
 * RESPONSIBILITY
 *   Apply middleware in a deliberate order and mount the API. Nothing here
 *   is deployment-specific; every knob comes from `config/env.js`.
 *
 * HOW TO EXTEND
 *   - New global middleware? Add it here, in the right position.
 *   - New API surface? Edit `routes/index.js`, not this file.
 */

import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import env from './config/env.js';
import corsConfig from './config/cors.js';
import { httpLoggerStream } from './config/logger.js';
import { requestIdMiddleware } from './middleware/requestId.middleware.js';
import { accessLog as accessLogMiddleware } from './middleware/accessLog.middleware.js';
import { apiLimiter } from './middleware/rateLimiter.middleware.js';
import { notFoundHandler } from './middleware/notFound.middleware.js';
import { errorHandler } from './middleware/error.middleware.js';
import apiRoutes from './routes/index.js';
import { registerAnalyticsWorker } from './jobs/analytics.worker.js';
import { registerExportWorker } from './jobs/export.worker.js';
import { initAuditConsumer } from './services/auditConsumer.service.js';

// Register the analytics queue consumer (report generation + alert
// evaluation) once per process so enqueued jobs are actually processed.
registerAnalyticsWorker();

// Register the export queue consumer (audit-trail artifact materialisation)
// once per process so requested exports actually complete.
registerExportWorker();

// Wire model-change events (audit plugin) to the audit trail. Runs after
// routes are imported so every audit-enabled model is already compiled.
initAuditConsumer();

const app = express();

app.disable('x-powered-by');
// Trust the configured number of reverse-proxy hops so `req.ip` is the real
// client IP (needed for accurate rate limiting and audit logs).
app.set('trust proxy', env.server.trustProxy);
app.set('env', env.app.env);

// 1. Request context (must run before anything that logs or throttles).
app.use(requestIdMiddleware);
// 1b. Per-request access trace (authenticated requests only; buffered writes).
app.use(accessLogMiddleware());

// 2. Security + transport headers.
app.use(helmet());
app.use(
  compression({
    filter: (req, res) => {
      // Never compress the Socket.IO polling channel - it manages its own
      // compression and gzip here breaks long-polling responses.
      if (req.url?.startsWith('/socket.io')) return false;
      return compression.filter(req, res);
    },
  }),
);

// 3. Cross-origin policy (allow-list driven, see config/cors.js).
app.use(cors(corsConfig));

// 4. Cookie + body parsing. Body size is bounded via env (`REQUEST_BODY_LIMIT`).
app.use(cookieParser());
// Inbound webhooks are verified with an HMAC over the RAW request bytes, so
// the webhook surface is buffered untouched BEFORE the JSON parser. This
// middleware runs first for `/api/v1/webhooks/*`, sets `req.body` to a
// Buffer and marks the request as parsed, which makes the `express.json`
// below skip it for webhook calls (exact bytes preserved for signing).
app.use(`${env.app.apiPrefix}/webhooks`, express.raw({ type: '*/*' }));
app.use(express.json({ limit: env.app.bodyLimit, strict: true }));
app.use(express.urlencoded({ extended: true, limit: env.app.bodyLimit }));

// 5. HTTP access logging (every request, through Pino).
morgan.token('requestId', (req) => req.id || '-');
app.use(
  morgan(
    ':requestId :method :url :status :res[content-length] :response-time ms - :remote-addr',
    { stream: httpLoggerStream },
  ),
);

// 6. Versioned API routes behind the global rate limiter.
app.use(env.app.apiPrefix, apiLimiter, apiRoutes);

// 7. Central 404 + error handling (must be last).
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
