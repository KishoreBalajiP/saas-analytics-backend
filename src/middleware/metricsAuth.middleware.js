/**
 * Metrics endpoint authentication (roadmap 2.8).
 *
 * WHY IT EXISTS
 *   `GET /api/v1/metrics` exposes operational data (route names, error
 *   codes, queue depth) that must not be public. Prometheus authenticates
 *   with a static bearer token (`METRICS_TOKEN`, `authorization.credentials`
 *   in the scrape config). Without a configured token the endpoint does not
 *   exist (404), so it can never be left open by accident.
 *
 * RESPONSIBILITY
 *   - 404 when no token is configured (indistinguishable from an unknown
 *     route).
 *   - 401 with `WWW-Authenticate: Bearer` when the token is missing or
 *     wrong; the comparison is constant-time over SHA-256 digests.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import env from '../config/env.js';
import ApiError from '../utils/ApiError.js';

function digest(value) {
  return createHash('sha256').update(String(value)).digest();
}

/**
 * Build the middleware.
 *
 * @param {Object} [options]
 * @param {string} [options.token] - defaults to METRICS_TOKEN.
 * @returns {import('express').RequestHandler}
 */
export function createMetricsAuth({ token = env.observability?.metricsToken ?? '' } = {}) {
  const expected = token ? digest(token) : null;
  return function metricsAuth(req, res, next) {
    if (!expected) {
      return next(ApiError.notFound(`Route not found: ${req.method} ${req.baseUrl}${req.path}`));
    }
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header.trim()) : null;
    if (!match || !timingSafeEqual(digest(match[1]), expected)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="metrics"');
      return next(ApiError.unauthorized('A valid metrics token is required'));
    }
    return next();
  };
}

/** Middleware configured from METRICS_TOKEN. */
export const metricsAuth = createMetricsAuth();

export default metricsAuth;
