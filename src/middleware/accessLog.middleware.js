/**
 * accessLog.middleware.js (Sprint 8 - implemented).
 *
 * PURPOSE
 *   Captures every authenticated HTTP request as an `AccessLog` row. Lives
 *   right after `requestId.middleware.js` at the top of the stack. Writes are
 *   buffered by `services/accessLog.service.js#capture`.
 *
 * RESPONSIBILITY
 *   - Subscribe to `res.finish` so latency includes the full response.
 *   - Capture { actorId?, actorType?, method, path, statusCode,
 *     latencyMs, ip, userAgent, requestId, error? }.
 *   - Never capture request/response bodies, cookies, or the Authorization
 *     header (the service allowlist already drops anything else).
 *   - Skip unauthenticated requests (no actor) - this is the *authenticated*
 *     request trace, not the morgan request log.
 *
 * USAGE
 *   ```
 *   app.use(accessLogMiddleware);   // after requestId, before routes
 *   ```
 */

import { getActor } from './actor.js';
import * as accessLogService from '../services/accessLog.service.js';

/**
 * Middleware factory. Captures the request on `res.finish` when an
 * authenticated actor is present. The actor is read at finish time because
 * auth middleware runs at the route level (after this global middleware).
 * Never throws into the request path.
 *
 * @param {Object} [options]
 * @returns {import('express').RequestHandler}
 */
export function accessLog(options = {}) {
  return (req, res, next) => {
    const started = process.hrtime.bigint();

    res.on('finish', () => {
      const actor = getActor(req);
      if (!actor) return;

      const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
      const entry = {
        actorType: actor.type,
        actorId: actor.id,
        tenantId: actor.tenantId ?? null,
        method: req.method,
        path: req.originalUrl ?? req.url,
        statusCode: res.statusCode,
        latencyMs,
        ip: req.ip ?? null,
        userAgent: req.headers?.['user-agent'] ?? null,
        requestId: req.id ?? null,
      };
      if (res.statusCode >= 400) {
        entry.error = {
          code: String(res.statusCode),
          message: res.statusMessage ?? null,
        };
      }
      if (options.event) entry.event = options.event;
      accessLogService.capture(entry);
    });

    return next();
  };
}

export default {
  accessLog,
  _meta: {
    phase: '8 - implemented',
    mountOrder: 'global, right after requestId.middleware.js',
    seeAlso: ['src/services/accessLog.service.js'],
  },
};
