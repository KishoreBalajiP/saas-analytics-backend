/**
 * CORS configuration.
 *
 * WHY IT EXISTS
 *   Centralises cross-origin policy for the HTTP API. The frontend origin(s)
 *   come from `CORS_ORIGINS` / `CLIENT_URL` and never live in code.
 *
 * RESPONSIBILITY
 *   - Allow every origin in the configured allow-list.
 *   - Reflect credentials and the headers our platform uses.
 *   - Deny unknown browser origins (request proceeds but without CORS headers,
 *     so the browser blocks it) and log the attempt for auditability.
 *
 * HOW TO EXTEND
 *   - Add origins through `.env` (no code change required).
 *   - If embeddable widgets must be usable from arbitrary domains, revisit
 *     this policy deliberately with the security team.
 */

import env from './env.js';
import logger from './logger.js';

const allowedOrigins = env.cors.origins;

export default {
  /**
   * Origin resolver invoked by the `cors` middleware as
   * `origin(req.headers.origin, callback)`. Server-to-server calls (curl,
   * cron, same-origin) send no Origin header and are always allowed.
   */
  origin(origin, callback) {
    const originAllowed =
      !origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin);

    if (!originAllowed) {
      logger.warn({ origin, allowedOrigins }, 'CORS request blocked');
    }

    // `null` error + `false` = proceed but emit no CORS headers.
    callback(null, originAllowed);
  },

  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Request-Id',
    'X-Tenant-Id',
    'X-Idempotency-Key',
  ],
  exposedHeaders: ['X-Request-Id', 'Content-Disposition'],
  maxAge: 86400, // cache preflight for 24h
  optionsSuccessStatus: 204,
};
